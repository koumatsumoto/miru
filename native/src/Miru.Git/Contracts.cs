using System.Diagnostics;
using Miru.Core;

namespace Miru.Git;

public enum GitStage { Staged, Unstaged }

public sealed record GitChange(string Id, string RelativePath, string? OriginalRelativePath,
    char IndexStatus, char WorktreeStatus)
{
    public bool IsConflict => IndexStatus == 'U' || WorktreeStatus == 'U' ||
        (IndexStatus == 'A' && WorktreeStatus == 'A') || (IndexStatus == 'D' && WorktreeStatus == 'D');
    public bool IsStaged => IndexStatus is not (' ' or '?' or '!');
    public bool IsUnstaged => WorktreeStatus is not (' ' or '!');
}

public sealed record GitStatus(string RootPath, string TopPath, IReadOnlyList<GitChange> Changes);
public sealed record GitDiff(string Before, string After, bool Binary, string? Message = null, string? Notice = null);
public class GitException(string message) : IOException(message);

internal static class GitPaths
{
    internal static void ValidateMetadata(string top, CancellationToken cancellationToken = default)
    {
        string? current = top;
        while (current is not null)
        {
            var marker = Path.Combine(current, ".git");
            FileAttributes attributes;
            try { attributes = File.GetAttributes(marker); }
            catch (FileNotFoundException) { current = Path.GetDirectoryName(current); continue; }
            catch (DirectoryNotFoundException) { current = Path.GetDirectoryName(current); continue; }
            var metadata = RequireExisting(marker); // Reject a linked .git before Git starts.
            if ((attributes & FileAttributes.Directory) == 0)
            {
                var text = ReadMetadataText(marker);
                if (!text.StartsWith("gitdir: ", StringComparison.Ordinal)) throw new GitException("Unsupported Git worktree metadata.");
                metadata = RequireExisting(LocalPaths.FullPath(text[8..], current));
            }
            if (!Directory.Exists(metadata)) throw new GitException("Git metadata is not a local directory.");
            var worktreeMetadata = metadata;
            var common = Path.Combine(metadata, "commondir");
            if (Exists(common)) metadata = RequireExisting(LocalPaths.FullPath(ReadMetadataText(common), metadata));
            var roots = LocalPaths.IsInside(metadata, worktreeMetadata) ? new[] { metadata } : new[] { worktreeMetadata, metadata };
            ValidateMetadataTrees(roots, cancellationToken);
            // Check this only after the tree scan: an objects/info parent may itself
            // be a link and must not be probed before that link has been rejected.
            foreach (var name in new[] { "alternates", "http-alternates" })
                if (Exists(Path.Combine(metadata, "objects", "info", name)))
                    throw new GitException("Alternate Git object stores are not supported by this local-only Git view.");
            return;
        }
        throw new GitException("The selected folder is not in a supported non-bare Git repository.");
    }

    internal const int MetadataEntryLimit = 30_000;
    internal static void ValidateMetadataTrees(IEnumerable<string> roots, CancellationToken token, int entryLimit = MetadataEntryLimit)
    {
        var clock = Stopwatch.StartNew();
        var entries = 0;
        var pending = new Stack<(string Path, int Depth)>(roots.Distinct(StringComparer.Ordinal).Select(p => (p, 0)));
        while (pending.TryPop(out var next))
        {
            CheckLimit();
            if (next.Depth > 64) throw new GitException("Git metadata nesting is unsupported. Files view remains available.");
            _ = RequireExisting(next.Path);
            foreach (var child in Directory.EnumerateFileSystemEntries(next.Path, "*", new EnumerationOptions { AttributesToSkip = 0, IgnoreInaccessible = false }))
            {
                if (++entries > entryLimit) throw new GitException("Git metadata exceeds the 30,000-entry safety scan limit. Files view remains available.");
                CheckLimit();
                var attributes = File.GetAttributes(child);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new GitException("Links or junctions inside Git metadata are not followed. Files view remains available.");
                if ((attributes & FileAttributes.Directory) != 0) pending.Push((child, next.Depth + 1));
            }
        }
        void CheckLimit()
        {
            token.ThrowIfCancellationRequested();
            if (clock.ElapsedMilliseconds >= 2000)
                throw new GitException("Git metadata safety scan exceeded two seconds. Files view remains available.");
        }
    }

    private static bool Exists(string path)
    {
        try { _ = File.GetAttributes(path); return true; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    private static string ReadMetadataText(string path)
    {
        var files = new ViewerSession(path);
        files.OpenPath(path);
        if (files.SelectedEntry is not { } entry) throw new GitException("Git metadata must be an ordinary file.");
        var content = files.Read(entry.Id);
        if (content.Bytes.Length > 8192 || content.Text is null) throw new GitException("Unsupported Git metadata text.");
        return content.Text.TrimEnd('\r', '\n');
    }

    // Reuse Core's existing canonical/reparse/mapped-drive validation without making
    // its implementation helpers public or changing the Core/CLI contract.
    internal static string RequireExisting(string path)
    {
        if (path.Replace('/', '\\').StartsWith("\\\\", StringComparison.Ordinal))
            throw new GitException("Git executable, configuration and metadata must be local; WSL/network Git support is not implemented.");
        var files = new ViewerSession(path);
        files.OpenPath(path);
        return files.SelectedEntry is { } entry
            ? Path.Combine(files.RootPath!, entry.RelativePath) : files.RootPath!;
    }
}
