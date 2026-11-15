using System.Text;
using System.Text.RegularExpressions;
using Miru.Core;

namespace Miru.Git;

/// <summary>
/// One window's read-only Git view. Call serially. Refresh invalidates IDs; readings
/// are live, not an atomic snapshot of another process's changing HEAD/index/files.
/// </summary>
public sealed class GitRepository
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly GitCommand command;
    private readonly Dictionary<string, GitChange> changes = new(StringComparer.Ordinal);
    public string RootPath { get; }
    public string TopPath { get; }

    private GitRepository(GitCommand command, string root, string top)
    { this.command = command; RootPath = root; TopPath = top; }

    public static async Task<GitRepository> OpenAsync(string topPath, CancellationToken cancellationToken = default)
    {
        RejectWsl(topPath);
        var top = GitPaths.RequireExisting(topPath);
        RejectWsl(top);
        if (!Directory.Exists(top)) throw new GitException("Repository view requires a folder.");
        GitPaths.ValidateMetadata(top, cancellationToken);
        var command = new GitCommand();
        // Reads configuration values only, before status (which can invoke clean/process
        // filters). Includes are refused rather than silently ignoring their semantics.
        await CheckConfigurationAsync(command, top, cancellationToken).ConfigureAwait(false);
        var rootText = Decode(await command.RunAsync(top, ["rev-parse", "--show-toplevel"], cancellationToken).ConfigureAwait(false));
        var root = GitPaths.RequireExisting(rootText.TrimEnd('\r', '\n'));
        RejectWsl(root);
        if (!LocalPaths.IsInside(root, top)) throw new GitException("Git reported a repository outside the selected folder's ancestors.");
        return new GitRepository(command, root, top);
    }

    public async Task<GitStatus> RefreshAsync(CancellationToken cancellationToken = default)
    {
        changes.Clear(); // A failed refresh must not retain IDs from an old view.
        ValidateScope(cancellationToken);
        await CheckConfigurationAsync(command, RootPath, cancellationToken).ConfigureAwait(false);
        var relative = Path.GetRelativePath(RootPath, TopPath).Replace(Path.DirectorySeparatorChar, '/');
        var data = await command.RunAsync(RootPath,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", "--", relative], cancellationToken).ConfigureAwait(false);
        var records = Decode(data).Split('\0');
        var result = new List<GitChange>();
        for (var i = 0; i < records.Length; i++)
        {
            var record = records[i];
            if (record.Length == 0) continue;
            if (record.Length < 4 || record[2] != ' ' || !" MADRCU?!T".Contains(record[0]) || !" MADRCU?!T".Contains(record[1]))
                throw new GitException("Git returned an unsupported status record.");
            var target = RepositoryPath(record[3..]);
            string? original = null;
            if (record[0] is 'R' or 'C' || record[1] is 'R' or 'C')
            {
                if (++i >= records.Length || records[i].Length == 0) throw new GitException("Git returned an incomplete rename record.");
                original = RepositoryPath(records[i]);
            }
            if (LocalPaths.IsInside(TopPath, target))
                Add(target, original, record[0], record[1]);
            else if (original is not null && LocalPaths.IsInside(TopPath, original))
                Add(original, null, 'D', ' '); // A rename leaving the visible top is a deletion only.
        }
        foreach (var change in result) changes.Add(change.Id, change);
        return new GitStatus(RootPath, TopPath, result.AsReadOnly());

        void Add(string target, string? source, char index, char worktree) => result.Add(new GitChange(
            Guid.NewGuid().ToString("N"), Path.GetRelativePath(TopPath, target),
            source is null ? null : Path.GetRelativePath(TopPath, source), index, worktree));
    }

    public async Task<GitDiff> ReadDiffAsync(string id, GitStage stage, CancellationToken cancellationToken = default)
    {
        ValidateScope(cancellationToken);
        if (!changes.TryGetValue(id, out var change)) throw new GitException("This change is no longer in the view. Refresh the repository.");
        if (stage is not (GitStage.Staged or GitStage.Unstaged)) throw new GitException("Select staged or unstaged changes.");
        if (change.IsConflict) return new GitDiff("", "", false, "This file has unresolved conflicts. Resolve them outside MIRU.");
        if (stage == GitStage.Staged ? !change.IsStaged : !change.IsUnstaged)
            throw new GitException("This change is not present in the selected stage. Refresh the repository.");
        // Config may have changed since refresh. No helper is run by the raw blob path,
        // but use the same refusal boundary for a consistent read-only view.
        await CheckConfigurationAsync(command, RootPath, cancellationToken).ConfigureAwait(false);
        var target = LocalPaths.FullPath(change.RelativePath, TopPath);
        if (!LocalPaths.IsInside(TopPath, target)) throw new GitException("The change is outside the current top.");
        byte[] before, after;
        string? notice = null;
        if (stage == GitStage.Staged)
        {
            var source = change.OriginalRelativePath is null ? target : LocalPaths.FullPath(change.OriginalRelativePath, TopPath);
            if (!LocalPaths.IsInside(TopPath, source))
            {
                before = [];
                notice = "The original path is outside the current top; its contents are not read. This side is shown as an addition.";
            }
            else before = await ReadBlobAsync(source, head: true, cancellationToken).ConfigureAwait(false);
            after = await ReadBlobAsync(target, head: false, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            before = change.IndexStatus == '?' ? [] : await ReadBlobAsync(target, head: false, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                // Reuse Core's regular-file, reparse-point, final-handle and 2 MiB checks.
                var actual = GitPaths.RequireExisting(target);
                if (!LocalPaths.IsInside(TopPath, actual)) throw new GitException("The working file moved outside the current top.");
                var files = new ViewerSession(TopPath);
                files.Open(new LaunchRequest(actual, TopPath));
                if (files.SelectedEntry is not { } entry) throw new GitException("The working file is no longer an ordinary file.");
                after = files.Read(entry.Id).Bytes;
            }
            catch (FileNotFoundException) { after = []; }
            catch (DirectoryNotFoundException) { after = []; }
        }
        try
        {
            if (before.Contains((byte)0) || after.Contains((byte)0)) throw new DecoderFallbackException();
            return new GitDiff(Utf8.GetString(before), Utf8.GetString(after), false, Notice: notice);
        }
        catch (DecoderFallbackException)
        { return new GitDiff("", "", true, "Binary or non-UTF-8 content cannot be shown as a text diff.", notice); }
    }

    private async Task<byte[]> ReadBlobAsync(string target, bool head, CancellationToken token)
    {
        if (!LocalPaths.IsInside(TopPath, target)) throw new GitException("The comparison path is outside the current top.");
        if (head && !await HasHeadAsync(token).ConfigureAwait(false)) return [];
        var relative = Path.GetRelativePath(RootPath, target).Replace(Path.DirectorySeparatorChar, '/');
        var listing = Decode(await command.RunAsync(RootPath,
            head ? ["ls-tree", "-z", "HEAD", "--", relative] : ["ls-files", "--stage", "-z", "--", relative], token).ConfigureAwait(false));
        var records = listing.Split('\0').Where(r => r.Contains('\t') && r[(r.IndexOf('\t') + 1)..] == relative).ToArray();
        if (records.Length == 0) return []; // Absent entry, not a missing referenced object.
        if (records.Length != 1) throw new GitException("The Git entry is conflicted; resolve it outside MIRU.");
        var metadata = records[0][..records[0].IndexOf('\t')].Split(' ');
        if (metadata.Length != 3 || metadata[0] is not ("100644" or "100755") || (head ? metadata[1] != "blob" : metadata[2] != "0"))
            throw new GitException("Only ordinary file blobs are displayed; links, submodules and unresolved entries are not followed.");
        var oid = head ? metadata[2] : metadata[1];
        if (!Regex.IsMatch(oid, "^(?:[a-f0-9]{40}|[a-f0-9]{64})$", RegexOptions.CultureInvariant))
            throw new GitException("Git returned an invalid object identifier.");
        try { return await command.RunAsync(RootPath, ["cat-file", "blob", oid], token).ConfigureAwait(false); }
        catch (GitCommandException ex) when (ex.ExitCode is 1 or 128)
        { throw new GitException("A referenced Git object is missing or damaged. MIRU does not fetch it automatically."); }
    }

    private async Task<bool> HasHeadAsync(CancellationToken token)
    {
        try { await command.RunAsync(RootPath, ["rev-parse", "--verify", "--quiet", "HEAD"], token).ConfigureAwait(false); return true; }
        catch (GitCommandException ex) when (ex.ExitCode == 1)
        {
            var reference = Decode(await command.RunAsync(RootPath, ["symbolic-ref", "--quiet", "HEAD"], token).ConfigureAwait(false)).TrimEnd('\r', '\n');
            try { await command.RunAsync(RootPath, ["show-ref", "--verify", "--quiet", reference], token).ConfigureAwait(false); }
            catch (GitCommandException missing) when (missing.ExitCode == 1) { return false; }
            throw; // An existing but damaged branch is not an empty/unborn HEAD.
        }
    }

    private static async Task CheckConfigurationAsync(GitCommand command, string directory, CancellationToken token)
    {
        try
        {
            var config = await command.RunAsync(directory, ["config", "--no-includes", "--null", "--name-only", "--get-regexp",
                "^(filter\\..*\\.(clean|process)|include\\.path|includeif\\..*\\.path|core\\.(worktree|attributesfile|excludesfile))$"], token).ConfigureAwait(false);
            if (config.Length > 0)
                throw new GitException("External Git filters, included configuration or custom worktree/attribute/ignore paths are configured. Git view is stopped before status; ordinary file browsing remains available.");
        }
        catch (GitCommandException ex) when (ex.ExitCode == 1) { /* No matching configuration. */ }
    }

    private string RepositoryPath(string relative)
    {
        if (relative.Length == 0 || relative.StartsWith('/') || relative.Contains('\\') ||
            relative.Split('/').Any(s => s is "" or "." or ".."))
            throw new GitException("Git returned an unsupported path.");
        var path = LocalPaths.FullPath(relative, RootPath);
        if (!LocalPaths.IsInside(RootPath, path)) throw new GitException("Git returned a path outside the repository.");
        return path;
    }

    private void ValidateScope(CancellationToken token)
    {
        if (GitPaths.RequireExisting(RootPath) != RootPath || GitPaths.RequireExisting(TopPath) != TopPath)
            throw new GitException("The repository or current top moved. Open the folder again.");
        GitPaths.ValidateMetadata(TopPath, token);
    }

    private static void RejectWsl(string path)
    {
        if (path.Replace('/', '\\').StartsWith("\\\\", StringComparison.Ordinal))
            throw new GitException("Native Git for WSL/network paths is not implemented. Use Files for WSL browsing; Windows Git is not run against that repository.");
    }

    private static string Decode(byte[] data)
    {
        try { return Utf8.GetString(data); }
        catch (DecoderFallbackException) { throw new GitException("Git returned non-UTF-8 path or metadata bytes; they are not guessed."); }
    }
}
