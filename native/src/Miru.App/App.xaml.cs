using Microsoft.UI.Xaml;

namespace Miru.App;

public partial class App : Application
{
    private MainWindow? window;

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Do not split a command line string. Preserve argv, spaces and Unicode.
        window = new MainWindow(Environment.GetCommandLineArgs().Skip(1).ToArray());
        window.Activate();
    }
}
