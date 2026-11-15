namespace Miru.Core;

public enum ViewerMode { File, Repository }

public sealed record LaunchRequest(
    string TargetPath,
    string HomePath,
    ViewerMode Mode = ViewerMode.File,
    bool IsLauncher = false);

public sealed record ViewerEntry(
    string Id,
    string Name,
    bool IsDirectory,
    string RelativePath,
    bool IsLink = false);

public sealed record DirectoryListing(IReadOnlyList<ViewerEntry> Entries, bool Truncated);

public sealed record SearchResults(
    IReadOnlyList<ViewerEntry> Entries,
    bool Truncated,
    int VisitedEntries);

public sealed record FileContent(string Name, string Extension, byte[] Bytes, string? Text);

public sealed class ViewerException(string message) : IOException(message);
