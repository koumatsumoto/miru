namespace Miru.Core;

/// <summary>Path syntax and read-only scope checks; never probes remote UNC hosts.</summary>
public static class LocalPaths
{
    public static void ValidateText(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Any(c => char.IsControl(c)))
            throw new ViewerException("A non-empty path without control characters is required.");
    }

    public static string FullPath(string value, string? baseDirectory = null)
    {
        ValidateText(value);
        if (OperatingSystem.IsWindows())
        {
            // Do not resolve an arbitrary UNC share, device path, or drive-relative path.
            if (value.StartsWith('\\') || value.StartsWith('/') ||
                (value.Length > 1 && value[1] == ':')) ValidateWindowsPath(value);
            var full = Path.GetFullPath(value, baseDirectory ?? Environment.CurrentDirectory);
            return ValidateWindowsPath(full);
        }
        if (value.StartsWith("\\", StringComparison.Ordinal) ||
            (value.Length > 1 && char.IsAsciiLetter(value[0]) && value[1] == ':'))
            throw new ViewerException("Use a Linux path in WSL; Windows paths are not guessed or translated.");
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(value, baseDirectory ?? Environment.CurrentDirectory));
    }

    /// <summary>Pure Windows syntax check, also used on the WSL side before launching Windows.</summary>
    public static string ValidateWindowsPath(string value)
    {
        ValidateText(value);
        value = value.Replace('/', '\\');
        string remainder;
        if (value.Length >= 3 && char.IsAsciiLetter(value[0]) && value[1] == ':' && value[2] == '\\')
            remainder = value[3..];
        else if (value.StartsWith("\\\\", StringComparison.Ordinal))
        {
            var parts = value[2..].Split('\\');
            if (parts.Length < 2 ||
                !(parts[0].Equals("wsl.localhost", StringComparison.OrdinalIgnoreCase) ||
                  parts[0].Equals("wsl$", StringComparison.OrdinalIgnoreCase)) ||
                string.IsNullOrWhiteSpace(parts[1]) || parts[1] is "." or "..")
                throw new ViewerException("Only local drives and explicit WSL distribution paths are supported; network shares are not opened.");
            ValidateWindowsSegment(parts[1]);
            remainder = string.Join('\\', parts.Skip(2));
        }
        else throw new ViewerException("Use an absolute drive path or an explicit \\\\wsl.localhost\\<distribution> path.");

        foreach (var segment in remainder.Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            if (segment is "." or "..") continue;
            ValidateWindowsSegment(segment);
        }
        return value;
    }

    private static void ValidateWindowsSegment(string segment)
    {
        if (segment.IndexOfAny([':', '"', '<', '>', '|', '?', '*']) >= 0 ||
            segment.EndsWith(' ') || segment.EndsWith('.'))
            throw new ViewerException("Device names, streams, and ambiguous Windows path aliases are not supported.");
        var stem = segment.Split('.')[0].TrimEnd(' ');
        if (stem.Equals("CON", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("PRN", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("AUX", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("NUL", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("CONIN$", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("CONOUT$", StringComparison.OrdinalIgnoreCase) ||
            (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) ||
             stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) &&
             (stem[3] is >= '1' and <= '9' or '¹' or '²' or '³')))
            throw new ViewerException("Windows device names are not supported.");
    }

    public static bool IsWslPath(string path) =>
        path.StartsWith("\\\\wsl.localhost\\", StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith("\\\\wsl$\\", StringComparison.OrdinalIgnoreCase);

    public static bool IsInside(string root, string target)
    {
        // Deliberately case-sensitive, including WSL and case-sensitive Windows directories.
        // All issued paths are derived from the same root spelling; a false negative is safer
        // than widening a scope to a differently cased sibling.
        root = Path.TrimEndingDirectorySeparator(root);
        return target.Equals(root, StringComparison.Ordinal) ||
            target.StartsWith(Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar,
                StringComparison.Ordinal);
    }

    /// <summary>Reject links/junctions, including ancestors, before any content is opened.</summary>
    internal static string RequireExisting(string path)
    {
        path = FullPath(path);
        var root = Path.GetPathRoot(path) ?? throw new ViewerException("Invalid path root.");
        if (OperatingSystem.IsWindows() && !IsWslPath(path) && new DriveInfo(root).DriveType == DriveType.Network)
            throw new ViewerException("Mapped network drives are not opened by the offline native viewer.");
        RejectReparsePoints(path, root);
        var canonical = OperatingSystem.IsWindows() ? WindowsPathIdentity.Canonicalize(path) : path;
        RejectReparsePoints(path, root);
        return canonical;
    }

    private static void RejectReparsePoints(string path, string root)
    {
        var cursor = root;
        RejectReparsePoint(cursor);
        foreach (var part in path[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            cursor = Path.Combine(cursor, part);
            RejectReparsePoint(cursor);
        }
    }

    private static void RejectReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new ViewerException("Links and junctions are not opened by this native MVP. Select the real target path explicitly.");
    }
}
