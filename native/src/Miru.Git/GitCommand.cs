using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using Miru.Core;

namespace Miru.Git;

/// <summary>Fixed read-only commands only; no public arbitrary-command entry point.</summary>
internal sealed class GitCommand
{
    internal const int OutputLimit = 2 * 1024 * 1024;
    private readonly string executable;
    internal GitCommand(string? executable = null) => this.executable = executable ?? FindExecutable();

    internal async Task<byte[]> RunAsync(string directory, string[] arguments, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var info = BuildStartInfo(executable, directory, arguments);
        using var process = new Process { StartInfo = info };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(6));
        try
        {
            if (!process.Start()) throw new GitException("Git could not be started.");
        }
        catch (Win32Exception) { throw new GitException("Git could not be started. Install a current Git for Windows and restart MIRU."); }
        using var stop = timeout.Token.Register(() => Kill(process));
        try
        {
            process.StandardInput.Close();
            var output = ReadBoundedAsync(process.StandardOutput.BaseStream, OutputLimit, process, timeout.Token);
            var error = ReadBoundedAsync(process.StandardError.BaseStream, 64 * 1024, process, timeout.Token);
            await Task.WhenAll(output, error, process.WaitForExitAsync(timeout.Token)).ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                var detail = Encoding.UTF8.GetString(await error.ConfigureAwait(false)).Trim();
                if (detail.Length > 600) detail = detail[..600] + "…";
                throw new GitCommandException(process.ExitCode, detail);
            }
            return await output.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new GitException("Git exceeded the 6-second read limit. No automatic retry or fetch was attempted."); }
        finally
        {
            Kill(process);
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(1)).ConfigureAwait(false); }
            catch (TimeoutException) { /* OS process termination is not a hard real-time guarantee. */ }
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream stream, int limit, Process process, CancellationToken token)
    {
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, limit + 1 - (int)output.Length)), token).ConfigureAwait(false);
            if (count == 0) return output.ToArray();
            output.Write(buffer, 0, count);
            if (output.Length > limit)
            {
                Kill(process);
                throw new GitException("Git output exceeded the display limit; no partial diff is presented.");
            }
        }
    }

    private static void Kill(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }
    }

    internal static ProcessStartInfo BuildStartInfo(string executable, string directory, string[] arguments)
    {
        GitConfigurationPaths.ValidateKnownLocations(executable);
        var info = new ProcessStartInfo(executable)
        {
            WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
        };
        // Keep only explicit config-file overrides (also used by isolated tests). Do not
        // inherit repository, index, object directory, trace, executable, or -c injection.
        var config = new[] { "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM" }
            .ToDictionary(k => k, k => info.Environment.TryGetValue(k, out var value) ? value : null);
        foreach (var key in info.Environment.Keys.Where(k => k.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase)).ToArray())
            info.Environment.Remove(key);
        foreach (var (key, value) in config)
            if (value is not null)
            {
                if (key != "GIT_CONFIG_NOSYSTEM" && value != (OperatingSystem.IsWindows() ? "NUL" : "/dev/null"))
                {
                    if (!Path.IsPathFullyQualified(value)) throw new GitException("Explicit Git config overrides must be existing absolute local files.");
                    info.Environment[key] = GitPaths.RequireExisting(value);
                }
                else info.Environment[key] = value;
            }
        info.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        info.Environment["GIT_NO_LAZY_FETCH"] = "1";
        info.Environment["GIT_ALLOW_PROTOCOL"] = "";
        info.Environment["GIT_TERMINAL_PROMPT"] = "0";
        info.Environment["GIT_CONFIG_COUNT"] = "0";
        info.Environment["GIT_NO_REPLACE_OBJECTS"] = "1";
        info.Environment["GIT_PAGER"] = "";
        info.Environment["GIT_EXTERNAL_DIFF"] = "";
        info.Environment["LC_ALL"] = "C";
        foreach (var argument in new[]
        {
            "--no-pager", "--no-optional-locks", "--no-lazy-fetch", "--literal-pathspecs",
            "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
            "-c", "status.submoduleSummary=false", "-c", "diff.external=",
            "-c", "core.hooksPath=" + (OperatingSystem.IsWindows() ? "NUL" : "/dev/null"),
            "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", directory,
        }) info.ArgumentList.Add(argument);
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return info;
    }

    private static string FindExecutable()
    {
        var name = OperatingSystem.IsWindows() ? "git.exe" : "git";
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            // Never use implicit CWD lookup or a relative PATH entry for Git.
            if (!Path.IsPathFullyQualified(directory)) continue;
            try
            {
                var candidate = LocalPaths.FullPath(Path.Combine(directory, name));
                var actual = GitPaths.RequireExisting(candidate);
                if (File.Exists(actual)) return actual;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
        }
        throw new GitException("A local Git executable was not found on PATH. File browsing remains available.");
    }
}

internal sealed class GitCommandException(int exitCode, string detail)
    : GitException("Git could not complete this read" + (detail.Length == 0 ? "." : ": " + detail))
{
    internal int ExitCode { get; } = exitCode;
}
