using System.Diagnostics;
using Miru.Core;

namespace Miru.Cli;

public static class GuiLauncher
{
    public static ProcessStartInfo BuildStartInfo(string executable, LaunchRequest request)
    {
        LocalPaths.ValidateText(executable);
        var info = new ProcessStartInfo(executable) { UseShellExecute = false };
        foreach (var argument in LaunchArguments.ToArguments(request)) info.ArgumentList.Add(argument);
        return info;
    }
}

public static class WslPaths
{
    public static string ParseOutput(string value)
    {
        // wslpath emits one line. Do not Trim away meaningful spaces or accept extra lines.
        if (value.EndsWith('\n')) value = value[..^1];
        if (value.EndsWith('\r')) value = value[..^1];
        if (value.Length > 32768) throw new ViewerException("The converted WSL path is too long.");
        return LocalPaths.ValidateWindowsPath(value);
    }

    public static async Task<string> ToWindowsAsync(string path)
    {
        if (!OperatingSystem.IsLinux() || !Path.IsPathFullyQualified(path))
            throw new ViewerException("WSL conversion requires an absolute Linux path.");
        LocalPaths.ValidateText(path);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo("/usr/bin/wslpath")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true
            }
        };
        process.StartInfo.ArgumentList.Add("-w");
        process.StartInfo.ArgumentList.Add(path);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try
        {
            if (!process.Start()) throw new ViewerException("wslpath could not be started.");
            var outputTask = ReadBoundedAsync(process.StandardOutput, timeout.Token);
            var errorTask = ReadBoundedAsync(process.StandardError, timeout.Token);
            await Task.WhenAll(outputTask, errorTask, process.WaitForExitAsync(timeout.Token));
            if (process.ExitCode != 0) throw new ViewerException("wslpath could not convert this path.");
            return ParseOutput(await outputTask);
        }
        catch (OperationCanceledException)
        {
            throw new ViewerException("WSL path conversion timed out.");
        }
        finally
        {
            try { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } }
            catch (InvalidOperationException) { }
        }
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var result = new System.Text.StringBuilder();
        var buffer = new char[1024];
        while (true)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (count == 0) return result.ToString();
            if (result.Length + count > 32768) throw new ViewerException("WSL converter output exceeded its limit.");
            result.Append(buffer, 0, count);
        }
    }
}
