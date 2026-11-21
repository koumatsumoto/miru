using System.Diagnostics;
using System.Text;

namespace Miru.Core;

/// <summary>
/// A single native window's read-only scope. Call serially (the UI may use Task.Run).
/// Only explicit Open/Home/Parent/Top/Search-result actions change the current top.
/// </summary>
public sealed class ViewerSession
{
    public const int FileLimitBytes = BoundedFileReader.MaxBytes;
    public const int DirectoryEntryLimit = 10_000;
    private readonly Dictionary<string, string> entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> searchEntries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> pathIds = new(StringComparer.Ordinal);

    public string HomePath { get; private set; }
    public string? RootPath { get; private set; }
    public bool IsLauncher { get; private set; }
    public ViewerEntry? SelectedEntry { get; private set; }
    public ViewerMode Mode { get; set; }

    public ViewerSession(string homeDirectory) => HomePath = LocalPaths.FullPath(homeDirectory);

    public void Open(LaunchRequest request)
    {
        var home = LocalPaths.FullPath(request.HomePath);
        OpenPath(request.TargetPath);
        HomePath = home;
        Mode = request.Mode;
        IsLauncher = request.IsLauncher && SelectedEntry is null;
    }

    public void OpenPath(string path)
    {
        var target = LocalPaths.RequireExisting(path);
        var isDirectory = (File.GetAttributes(target) & FileAttributes.Directory) != 0;
        var root = isDirectory ? target : LocalPaths.RequireExisting(Path.GetDirectoryName(target)!);
        RootPath = root;
        Invalidate();
        IsLauncher = false;
        if (!isDirectory) SelectedEntry = MakeEntry(target, root);
    }

    public void OpenHome()
    {
        if (!Directory.Exists(LocalPaths.RequireExisting(HomePath))) throw new ViewerException("HOME must be a folder.");
        OpenPath(HomePath);
        IsLauncher = true;
        Mode = ViewerMode.File;
    }

    public void Parent()
    {
        var root = RequireRoot();
        OpenPath(Path.GetDirectoryName(root) ?? root);
    }

    public void SetTop(string id)
    {
        var path = Resolve(id);
        if ((File.GetAttributes(path) & FileAttributes.Directory) == 0)
            throw new ViewerException("Select a folder to use as the top.");
        OpenPath(path);
    }

    public void Refresh()
    {
        var root = LocalPaths.RequireExisting(RequireRoot());
        var selectedPath = SelectedEntry is null ? null : entries.GetValueOrDefault(SelectedEntry.Id);
        var launcher = IsLauncher;
        OpenPath(root);
        IsLauncher = launcher;
        if (selectedPath is not null && File.Exists(selectedPath))
        {
            try
            {
                var selected = LocalPaths.RequireExisting(selectedPath);
                if (LocalPaths.IsInside(root, selected)) SelectedEntry = MakeEntry(selected, root);
            }
            catch (IOException) { /* A changed/deleted/linked selection is no longer selected. */ }
            catch (UnauthorizedAccessException) { }
        }
    }

    public DirectoryListing List(string? directoryId = null)
    {
        var root = RequireRoot();
        var directory = directoryId is null ? LocalPaths.RequireExisting(root) : Resolve(directoryId);
        if (!LocalPaths.IsInside(root, directory) || (File.GetAttributes(directory) & FileAttributes.Directory) == 0)
            throw new ViewerException("Select a folder inside the current top.");
        var result = new List<ViewerEntry>();
        var truncated = false;
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            if (result.Count >= DirectoryEntryLimit) { truncated = true; break; }
            try { result.Add(MakeEntry(path, root)); }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            catch (UnauthorizedAccessException) { }
        }
        return new DirectoryListing(result.OrderByDescending(x => x.IsDirectory)
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ThenBy(x => x.Name, StringComparer.Ordinal).ToArray(), truncated);
    }

    public FileContent Read(string id)
    {
        // A failed selection is not the previously displayed file.
        SelectedEntry = null;
        var path = Resolve(id);
        var bytes = BoundedFileReader.Read(path, RequireRoot());
        SelectedEntry = MakeEntry(path, RequireRoot());
        return new FileContent(Path.GetFileName(path), Path.GetExtension(path).ToLowerInvariant(), bytes, DecodeText(bytes));
    }

    /// <summary>Keep a valid listing usable even if its selected file has changed since the last view.</summary>
    public FilesViewContents ReadFilesView()
    {
        var listing = List();
        if (SelectedEntry is not { } selected) return new(listing, null, null);
        try { return new(listing, Read(selected.Id), null); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        { return new(listing, null, error.Message); }
    }

    public SearchResults SearchHome(string query, CancellationToken cancellationToken = default)
    {
        var clock = Stopwatch.StartNew();
        return SearchHome(query, cancellationToken, () => clock.ElapsedMilliseconds);
    }

    // The clock is injectable only for finite tests. Filesystem access and scope
    // checks are still the production implementation, not an in-memory substitute.
    internal SearchResults SearchHome(string query, CancellationToken cancellationToken, Func<long> elapsedMilliseconds)
    {
        searchEntries.Clear(); // Even invalid/empty queries invalidate previous results.
        query = query.Trim().Replace('\\', '/');
        if (query.Length < 2) return new SearchResults([], false, 0);
        if (query.Length > 256) throw new ViewerException("Use a search query of at most 256 characters.");
        var home = LocalPaths.RequireExisting(HomePath);
        if (!Directory.Exists(home)) throw new ViewerException("HOME must be a folder.");
        var pending = new Stack<string>();
        pending.Push(home);
        var matches = new List<ViewerEntry>();
        var visited = 0;
        while (pending.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            // Empty or inaccessible folders may take time without producing an
            // entry. Do not start another folder after the budget.
            if (elapsedMilliseconds() >= 1800) return new SearchResults(matches, true, visited);
            var directory = pending.Pop();
            try
            {
                LocalPaths.RequireExisting(directory);
                foreach (var path in Directory.EnumerateFileSystemEntries(directory))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (++visited > 30_000 || elapsedMilliseconds() >= 1800 || matches.Count >= 100)
                        return new SearchResults(matches, true, visited);
                    FileAttributes attributes;
                    try { attributes = File.GetAttributes(path); }
                    catch (IOException) { continue; }
                    catch (UnauthorizedAccessException) { continue; }
                    if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                    var name = Path.GetFileName(path);
                    if (name is ".git" or "node_modules") continue;
                    var relative = Path.GetRelativePath(home, path);
                    var isDirectory = (attributes & FileAttributes.Directory) != 0;
                    if (relative.Replace(Path.DirectorySeparatorChar, '/').Contains(query, StringComparison.OrdinalIgnoreCase))
                    {
                        var id = Guid.NewGuid().ToString("N");
                        searchEntries[id] = path;
                        matches.Add(new ViewerEntry(id, name, isDirectory, relative));
                    }
                    if (isDirectory) pending.Push(path);
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        // The final enumeration may also cross the deadline with no next entry
        // or pending folder at which to observe it. Report partial, not complete.
        return new SearchResults(matches, elapsedMilliseconds() >= 1800, visited);
    }

    public void OpenSearch(string id)
    {
        if (!searchEntries.TryGetValue(id, out var path)) throw Expired();
        var home = LocalPaths.RequireExisting(HomePath);
        path = LocalPaths.RequireExisting(path);
        if (!LocalPaths.IsInside(home, path)) throw Expired();
        OpenPath(path);
    }

    private string Resolve(string id)
    {
        if (!entries.TryGetValue(id, out var path)) throw Expired();
        var actual = LocalPaths.RequireExisting(path);
        if (!LocalPaths.IsInside(RequireRoot(), actual)) throw Expired();
        return actual;
    }

    private ViewerEntry MakeEntry(string path, string root)
    {
        if (!LocalPaths.IsInside(root, path)) throw Expired();
        var attributes = File.GetAttributes(path);
        if (!pathIds.TryGetValue(path, out var id))
        {
            id = Guid.NewGuid().ToString("N");
            entries[id] = path;
            pathIds[path] = id;
        }
        return new ViewerEntry(id, Path.GetFileName(path), (attributes & FileAttributes.Directory) != 0,
            Path.GetRelativePath(root, path), (attributes & FileAttributes.ReparsePoint) != 0);
    }

    private void Invalidate()
    {
        entries.Clear();
        pathIds.Clear();
        searchEntries.Clear();
        SelectedEntry = null;
    }

    private string RequireRoot() => RootPath ?? throw new ViewerException("Open a folder first.");
    private static ViewerException Expired() => new("This item is no longer in the current view. Refresh the folder.");

    private static string? DecodeText(byte[] bytes)
    {
        try
        {
            var text = bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe
                ? new UnicodeEncoding(false, true, true).GetString(bytes, 2, bytes.Length - 2)
                : bytes.Length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff
                    ? new UnicodeEncoding(true, true, true).GetString(bytes, 2, bytes.Length - 2)
                    : new UTF8Encoding(false, true).GetString(bytes).TrimStart('\ufeff');
            return text.Contains('\0') ? null : text;
        }
        catch (DecoderFallbackException) { return null; }
    }
}
