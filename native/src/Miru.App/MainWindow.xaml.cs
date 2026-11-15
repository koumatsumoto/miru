using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Miru.Core;
using Windows.System;

namespace Miru.App;

/// <summary>Native presentation only. All filesystem access belongs to Miru.Core.</summary>
public sealed partial class MainWindow : Window
{
    private readonly string[] arguments;
    private readonly Dictionary<TreeViewNode, ViewerEntry> nodes = [];
    private readonly CancellationTokenSource lifetime = new();
    private ViewerSession? session;
    private bool initialized;
    private bool busy;
    private bool closed;
    private bool applyingSnapshot;
    private bool showingSearch;

    private ViewerSession Session => session ?? throw new ViewerException("Open a folder first.");

    public MainWindow(string[] arguments)
    {
        this.arguments = arguments;
        InitializeComponent();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 820));
        Closed += (_, _) => { closed = true; lifetime.Cancel(); };
        AddShortcut(VirtualKey.L, VirtualKeyModifiers.Control, () => { PathInput.Focus(FocusState.Keyboard); PathInput.SelectAll(); });
        AddShortcut(VirtualKey.F5, VirtualKeyModifiers.None, () => Refresh_Click(this, new RoutedEventArgs()));
        AddShortcut(VirtualKey.Up, VirtualKeyModifiers.Menu, () => Parent_Click(this, new RoutedEventArgs()));
        AddShortcut(VirtualKey.Home, VirtualKeyModifiers.Control, () => Home_Click(this, new RoutedEventArgs()));
    }

    private void AddShortcut(VirtualKey key, VirtualKeyModifiers modifiers, Action action)
    {
        var shortcut = new KeyboardAccelerator { Key = key, Modifiers = modifiers };
        shortcut.Invoked += (_, e) => { if (!busy) action(); e.Handled = true; };
        Shell.KeyboardAccelerators.Add(shortcut);
    }

    private async void Shell_Loaded(object sender, RoutedEventArgs e)
    {
        if (initialized) return;
        initialized = true;
        await RunAsync(() =>
        {
            var request = LaunchArguments.Parse(arguments, Environment.CurrentDirectory,
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            session = new ViewerSession(request.HomePath);
            Session.Open(request);
            return Snapshot();
        }, ApplySnapshot);
    }

    // One filesystem operation at a time. Repeated clicks cannot queue unbounded work.
    // Slow WSL I/O runs off the UI thread; closing the window remains available.
    private async Task RunAsync<T>(Func<T> work, Action<T> apply)
    {
        if (busy || closed) return;
        SetBusy(true);
        Notice.IsOpen = false;
        try
        {
            var result = await Task.Run(work, lifetime.Token);
            if (!closed) apply(result);
        }
        catch (OperationCanceledException) when (closed) { }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            if (!closed) ShowNotice(ex.Message, InfoBarSeverity.Error);
        }
        finally { if (!closed) SetBusy(false); }
    }

    private void SetBusy(bool value)
    {
        busy = value;
        HomeButton.IsEnabled = PathControls.IsEnabled = Explorer.IsEnabled = HomePanel.IsEnabled = !value;
        FileMode.IsEnabled = RepositoryMode.IsEnabled = FilesRail.IsEnabled = SearchRail.IsEnabled = !value;
        BusyBar.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
        BusyBar.IsIndeterminate = value;
        if (value) StatusText.Text = "Reading local files…";
    }

    private sealed record ViewSnapshot(string Root, bool IsLauncher, ViewerMode Mode,
        DirectoryListing Listing, FileContent? File);

    private ViewSnapshot Snapshot() => new(Session.RootPath!, Session.IsLauncher, Session.Mode,
        Session.List(), Session.Mode == ViewerMode.File && Session.SelectedEntry is { } selected ? Session.Read(selected.Id) : null);

    private void ApplySnapshot(ViewSnapshot state)
    {
        applyingSnapshot = true;
        FileMode.IsChecked = state.Mode == ViewerMode.File;
        RepositoryMode.IsChecked = state.Mode == ViewerMode.Repository;
        applyingSnapshot = false;
        PathInput.Text = state.Root;
        TopLabel.Text = state.Root;
        ToolTipService.SetToolTip(TopLabel, state.Root);
        Title = $"MIRU · {state.Root}";
        showingSearch = false;
        HomeSearch.Text = "";
        nodes.Clear();
        FileTree.RootNodes.Clear();
        foreach (var entry in state.Listing.Entries) FileTree.RootNodes.Add(CreateNode(entry));
        SetTopButton.IsEnabled = false;
        HomeEntries.ItemsSource = state.Listing.Entries;
        SourceText.Text = "";
        StatusText.Text = state.Listing.Truncated
            ? $"First {state.Listing.Entries.Count:N0} entries · listing limited"
            : $"{state.Listing.Entries.Count:N0} entries · read only";
        if (state.Mode == ViewerMode.Repository)
        {
            ShowEmpty("Repository view is being ported", "Native Git status and diffs are not available yet. Switch to Files to browse. No Git commands are run in this milestone.");
            DocumentTitle.Text = "Repository";
        }
        else if (state.File is not null) ShowFile(state.File);
        else if (state.IsLauncher)
        {
            ShowPanel(HomePanel);
            DocumentTitle.Text = "Home";
        }
        else ShowEmpty("Select a file", "Browse the tree on the left. Files are never edited.");
        if (state.Listing.Truncated) ShowNotice("This folder contains more than 10,000 entries. Only the first bounded listing is shown.");
    }

    private TreeViewNode CreateNode(ViewerEntry entry)
    {
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        content.Children.Add(new FontIcon { Glyph = entry.IsDirectory ? "\uE8B7" : "\uE8A5", FontSize = 14 });
        content.Children.Add(new TextBlock { Text = entry.Name + (entry.IsLink ? " (link unavailable)" : ""), TextTrimming = TextTrimming.CharacterEllipsis });
        AutomationProperties.SetName(content, entry.Name + (entry.IsDirectory ? ", folder" : ", file"));
        var node = new TreeViewNode { Content = content, HasUnrealizedChildren = entry.IsDirectory && !entry.IsLink };
        nodes[node] = entry;
        return node;
    }

    private void ShowPanel(UIElement panel)
    {
        HomePanel.Visibility = panel == HomePanel ? Visibility.Visible : Visibility.Collapsed;
        DocumentPanel.Visibility = panel == DocumentPanel ? Visibility.Visible : Visibility.Collapsed;
        EmptyPanel.Visibility = panel == EmptyPanel ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ShowEmpty(string title, string description)
    {
        ShowPanel(EmptyPanel);
        EmptyTitle.Text = title;
        EmptyDescription.Text = description;
        DocumentTitle.Text = "Files";
    }

    private void ShowFile(FileContent file)
    {
        DocumentTitle.Text = file.Name;
        StatusText.Text = $"{file.Bytes.Length:N0} bytes · read only";
        if (file.Text is null)
        {
            ShowEmpty("Binary preview is being ported", "This native milestone displays UTF-8 and UTF-16 text. Image and PDF preview are not available yet.");
            DocumentTitle.Text = file.Name;
            return;
        }
        SourceText.Text = file.Text;
        ShowPanel(DocumentPanel);
        if (file.Extension is ".md" or ".markdown" or ".html" or ".htm" or ".svg")
            ShowNotice("Source only for now. Native Markdown, Mermaid and document previews are still being ported. Scripts, links and external resources are not executed.");
    }

    private void ShowNotice(string message, InfoBarSeverity severity = InfoBarSeverity.Informational)
    {
        Notice.Severity = severity;
        Notice.Message = message;
        Notice.IsOpen = true;
        if (severity == InfoBarSeverity.Error) StatusText.Text = "Could not open this item";
    }

    private async void Home_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(() => { Session.OpenHome(); return Snapshot(); }, ApplySnapshot);

    private async void Parent_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(() => { Session.Parent(); return Snapshot(); }, ApplySnapshot);

    private async void Refresh_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(() => { Session.Refresh(); return Snapshot(); }, ApplySnapshot);

    private async void OpenPath_Click(object sender, RoutedEventArgs e)
    {
        var text = PathInput.Text;
        var cwd = session?.RootPath ?? Environment.CurrentDirectory;
        await RunAsync(() =>
        {
            session ??= new ViewerSession(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            var request = LaunchArguments.Parse(["--", text], cwd, Session.HomePath);
            Session.Open(request);
            return Snapshot();
        }, ApplySnapshot);
    }

    private void Path_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        OpenPath_Click(sender, new RoutedEventArgs());
        e.Handled = true;
    }

    private async void SetTop_Click(object sender, RoutedEventArgs e)
    {
        if (FileTree.SelectedNode is not { } node || !nodes.TryGetValue(node, out var entry)) return;
        await RunAsync(() => { Session.SetTop(entry.Id); return Snapshot(); }, ApplySnapshot);
    }

    private void Tree_SelectionChanged(TreeView sender, TreeViewSelectionChangedEventArgs args) =>
        SetTopButton.IsEnabled = sender.SelectedNode is { } node && nodes.TryGetValue(node, out var entry) && entry.IsDirectory && !entry.IsLink;

    private async void Tree_Expanding(TreeView sender, TreeViewExpandingEventArgs args)
    {
        var node = args.Node;
        if (!node.HasUnrealizedChildren || !nodes.TryGetValue(node, out var entry)) return;
        await RunAsync(() => Session.List(entry.Id), listing =>
        {
            node.Children.Clear();
            foreach (var child in listing.Entries) node.Children.Add(CreateNode(child));
            node.HasUnrealizedChildren = false;
            StatusText.Text = $"{listing.Entries.Count:N0} entries · read only";
            if (listing.Truncated) ShowNotice("This folder listing is limited to 10,000 entries.");
        });
    }

    private async void Tree_ItemInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
    {
        if (args.InvokedItem is not TreeViewNode node || !nodes.TryGetValue(node, out var entry)) return;
        if (entry.IsLink) { ShowNotice("Links and junctions are not followed in this native milestone."); return; }
        if (entry.IsDirectory || Session.Mode != ViewerMode.File) return;
        await RunAsync(() => Session.Read(entry.Id), ShowFile);
    }

    private async void Home_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not ViewerEntry entry) return;
        if (entry.IsLink) { ShowNotice("Links and junctions are not followed in this native milestone."); return; }
        if (showingSearch)
            await RunAsync(() => { Session.OpenSearch(entry.Id); return Snapshot(); }, ApplySnapshot);
        else if (entry.IsDirectory)
            await RunAsync(() => { Session.SetTop(entry.Id); return Snapshot(); }, ApplySnapshot);
        else await RunAsync(() => Session.Read(entry.Id), ShowFile);
    }

    private async void Search_Submitted(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
    {
        var query = args.QueryText;
        await RunAsync(() => Session.SearchHome(query, lifetime.Token), result =>
        {
            showingSearch = true;
            HomeEntries.ItemsSource = result.Entries;
            StatusText.Text = $"{result.Entries.Count} matches · {result.VisitedEntries:N0} visited";
            if (query.Trim().Length < 2) ShowNotice("Enter at least 2 characters to search HOME.");
            else if (result.Truncated) ShowNotice("Search limit reached. These are partial results, not a complete index.");
            else if (result.Entries.Count == 0) ShowNotice("No matching files or folders found in HOME.");
        });
    }

    private async void SearchHome_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(() => { Session.OpenHome(); return Snapshot(); }, state => { ApplySnapshot(state); HomeSearch.Focus(FocusState.Keyboard); });

    private void Files_Click(object sender, RoutedEventArgs e) => FileMode.IsChecked = true;

    private async void FileMode_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingSnapshot || !initialized || session is null) return;
        await RunAsync(() => { Session.Mode = ViewerMode.File; return Snapshot(); }, ApplySnapshot);
    }

    private async void RepositoryMode_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingSnapshot || !initialized || session is null) return;
        await RunAsync(() => { Session.Mode = ViewerMode.Repository; return Snapshot(); }, ApplySnapshot);
    }

    private void Theme_Click(object sender, RoutedEventArgs e)
    {
        Shell.RequestedTheme = Shell.ActualTheme == ElementTheme.Dark ? ElementTheme.Light : ElementTheme.Dark;
        ThemeButton.Content = new FontIcon { Glyph = Shell.RequestedTheme == ElementTheme.Dark ? "\uE706" : "\uE793", FontSize = 16 };
    }
}
