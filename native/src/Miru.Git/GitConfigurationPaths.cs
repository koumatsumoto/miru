using Miru.Core;

namespace Miru.Git;

/// <summary>
/// Refuse static links in the standard Git configuration/attribute locations before
/// Git reads them. The installed executable and its platform layout remain trusted;
/// this is not discovery of arbitrary custom-compiled Git paths via an unsafe probe.
/// </summary>
internal static class GitConfigurationPaths
{
    internal static void ValidateKnownLocations(string executable)
    {
        var explicitGlobal = Environment.GetEnvironmentVariable("GIT_CONFIG_GLOBAL");
        var explicitSystem = Environment.GetEnvironmentVariable("GIT_CONFIG_SYSTEM");
        var home = Environment.GetEnvironmentVariable("HOME") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrEmpty(xdg)) xdg = Path.Combine(home, ".config");
        // Attributes use XDG even when an explicit global config file is selected.
        ValidateOptional(Path.Combine(xdg, "git", "attributes"));
        ValidateOptional(Path.Combine(xdg, "git", "ignore"));
        if (explicitGlobal is not null) ValidateOptional(explicitGlobal);
        else
        {
            ValidateOptional(Path.Combine(home, ".gitconfig"));
            ValidateOptional(Path.Combine(xdg, "git", "config"));
        }
        var skipSystem = Environment.GetEnvironmentVariable("GIT_CONFIG_NOSYSTEM")?.ToLowerInvariant() is "1" or "true" or "yes" or "on";
        if (!skipSystem && explicitSystem is not null) ValidateOptional(explicitSystem);

        foreach (var directory in StandardSystemDirectories(executable))
        {
            if (!skipSystem && explicitSystem is null) ValidateOptional(Path.Combine(directory, "gitconfig"));
            ValidateOptional(Path.Combine(directory, "gitattributes"));
        }
        // Legacy Git for Windows location, checked defensively as well. Current Git
        // supporting --no-lazy-fetch normally uses its installation's etc directory.
        if (OperatingSystem.IsWindows() && !skipSystem && explicitSystem is null &&
            Environment.GetEnvironmentVariable("PROGRAMDATA") is { Length: > 0 } programData)
            ValidateOptional(Path.Combine(programData, "Git", "config"));
    }

    private static IEnumerable<string> StandardSystemDirectories(string executable)
    {
        if (!OperatingSystem.IsWindows())
        {
            yield return "/etc";
            yield return "/usr/local/etc";
            yield break;
        }
        var directory = Path.GetDirectoryName(executable);
        if (directory is null) yield break;
        // Standard installer/portable layouts: <root>/cmd/git.exe,
        // <root>/bin/git.exe, or <root>/mingw64/bin/git.exe.
        if (Path.GetFileName(directory).Equals("cmd", StringComparison.OrdinalIgnoreCase) ||
            Path.GetFileName(directory).Equals("bin", StringComparison.OrdinalIgnoreCase))
        {
            var root = Path.GetDirectoryName(directory);
            if (root is null) yield break;
            if (Path.GetFileName(root).StartsWith("mingw", StringComparison.OrdinalIgnoreCase))
                root = Path.GetDirectoryName(root);
            if (root is null) yield break;
            yield return Path.Combine(root, "etc");
            yield return Path.Combine(root, "mingw64", "etc");
            yield return Path.Combine(root, "mingw32", "etc");
        }
        else if (Path.GetFileName(executable).Equals("git.exe", StringComparison.OrdinalIgnoreCase))
            throw new GitException("This Git installation layout is not supported by native Git view. Use a standard Git for Windows installation; Files view remains available.");
    }

    internal static void ValidateOptional(string path)
    {
        if (path == (OperatingSystem.IsWindows() ? "NUL" : "/dev/null")) return;
        if (!Path.IsPathFullyQualified(path)) throw new GitException("Git config locations must be absolute local paths.");
        try
        {
            // Core checks ancestors in order, so a missing file below a linked parent
            // is rejected without probing through that link first.
            var actual = GitPaths.RequireExisting(path);
            if (Directory.Exists(actual)) throw new GitException("Git config/attribute locations must be ordinary files.");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }
}
