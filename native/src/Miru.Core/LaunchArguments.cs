namespace Miru.Core;

/// <summary>Shared argument contract. No shell, filesystem access, or path guessing.</summary>
public static class LaunchArguments
{
    public const string Help = "MIRU\n  miru             HOME\n  miru <path>      Read-only file/folder viewer\n  miru diff        Read-only repository changes (local Windows Git)\n  miru -- <path>   A literal path, including a file named diff\n";

    public static LaunchRequest Parse(IReadOnlyList<string> args, string cwd, string home)
    {
        ArgumentNullException.ThrowIfNull(args);
        if (args.Count > 0 && args[0] == "--target") return ParseForwarded(args);
        string? path = null;
        var mode = ViewerMode.File;
        var launcher = args.Count == 0;
        if (args.Count == 2 && args[0] == "--") path = args[1];
        else if (args.Count == 1 && args[0] == "diff") { path = cwd; mode = ViewerMode.Repository; }
        else if (args.Count == 1 && !args[0].StartsWith('-')) path = args[0];
        else if (args.Count != 0) throw new ViewerException("Usage: miru [path | diff], or miru -- <path>.");
        return new LaunchRequest(LocalPaths.FullPath(path ?? home, cwd),
            LocalPaths.FullPath(home, cwd), mode, launcher);
    }

    public static string[] ToArguments(LaunchRequest request) =>
        ["--target", request.TargetPath, "--home", request.HomePath,
         "--mode", request.Mode == ViewerMode.Repository ? "repository" : "file",
         "--launcher", request.IsLauncher ? "true" : "false"];

    private static LaunchRequest ParseForwarded(IReadOnlyList<string> args)
    {
        if (args.Count != 8 || args[2] != "--home" || args[4] != "--mode" || args[6] != "--launcher" ||
            args[5] is not ("file" or "repository") || args[7] is not ("true" or "false"))
            throw new ViewerException("Invalid MIRU launch arguments.");
        // The recipient validates its own platform's path semantics before accessing files.
        LocalPaths.ValidateText(args[1]);
        LocalPaths.ValidateText(args[3]);
        if (!Path.IsPathFullyQualified(args[1]) || !Path.IsPathFullyQualified(args[3]))
            throw new ViewerException("Forwarded paths must be absolute.");
        return new LaunchRequest(args[1], args[3], args[5] == "repository" ? ViewerMode.Repository : ViewerMode.File,
            args[7] == "true");
    }
}
