using Microsoft.UI.Xaml;

namespace Miru.App;

public partial class App : Application
{
    private MainWindow? window;
    // The Windows smoke redirects stderr for its own disposable fixture. Nothing
    // is persisted or sent, and the normal viewer does not enable diagnostics.
    private static readonly bool TraceStartup =
        Environment.GetEnvironmentVariable("MIRU_CI_TRACE_STARTUP") == "1";

    public App()
    {
        if (TraceStartup)
            UnhandledException += (_, e) => ReportFailure("UI dispatcher", e.Exception, staticShell: false);
        AtStartup("App.InitializeComponent", InitializeComponent, staticShell: true);
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Do not split a command line string. Preserve argv, spaces and Unicode.
        AtStartup("MainWindow construction",
            () => window = new MainWindow(Environment.GetCommandLineArgs().Skip(1).ToArray()), staticShell: true);
        AtStartup("MainWindow.Activate", () => window!.Activate(), staticShell: false);
    }

    private static void AtStartup(string phase, Action work, bool staticShell)
    {
        if (!TraceStartup) { work(); return; }
        Console.Error.WriteLine($"MIRU startup: {phase}: begin");
        try { work(); }
        catch (Exception error) { ReportFailure(phase, error, staticShell); throw; }
        Console.Error.WriteLine($"MIRU startup: {phase}: complete");
    }

    private static void ReportFailure(string phase, Exception? error, bool staticShell)
    {
        for (var n = 0; error is not null && n < 3; n++, error = error.InnerException)
        {
            Console.Error.WriteLine($"MIRU startup: {phase}: {error.GetType().FullName} 0x{error.HResult:X8}");
            // Only static app/shell construction messages, never document body or argv.
            if (staticShell)
                Console.Error.WriteLine(error.Message[..Math.Min(error.Message.Length, 600)]);
            if (error.StackTrace is { } stack)
                Console.Error.WriteLine(string.Join("\n", stack.Split('\n').Take(12)));
        }
    }
}
