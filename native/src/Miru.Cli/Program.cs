using Miru.Core;
using Miru.Cli;

if (args is ["--help"] or ["-h"])
{
    Console.WriteLine(LaunchArguments.Help);
    return 0;
}
try
{
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var request = LaunchArguments.Parse(args, Environment.CurrentDirectory, home);
    var inWsl = OperatingSystem.IsLinux() && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("WSL_DISTRO_NAME"));
    if (!OperatingSystem.IsWindows() && !inWsl)
        throw new ViewerException("The native viewer requires Windows. From WSL, set MIRU_APP_PATH to the installed Windows Miru.App.exe.");
    if (inWsl)
    {
        request = request with
        {
            TargetPath = await WslPaths.ToWindowsAsync(request.TargetPath),
            HomePath = await WslPaths.ToWindowsAsync(request.HomePath)
        };
    }
    var appPath = Environment.GetEnvironmentVariable("MIRU_APP_PATH") ?? Path.Combine(AppContext.BaseDirectory, "Miru.App.exe");
    appPath = LocalPaths.FullPath(appPath);
    if (!File.Exists(appPath) || !Path.GetExtension(appPath).Equals(".exe", StringComparison.OrdinalIgnoreCase))
        throw new ViewerException("Miru.App.exe was not found. Install it beside the CLI or set MIRU_APP_PATH to its explicit path.");
    using var process = System.Diagnostics.Process.Start(GuiLauncher.BuildStartInfo(appPath, request))
        ?? throw new ViewerException("The Windows viewer could not be started.");
    return 0;
}
catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or
    System.ComponentModel.Win32Exception or InvalidOperationException or PlatformNotSupportedException)
{
    Console.Error.WriteLine($"MIRU: {error.Message}");
    return 1;
}
