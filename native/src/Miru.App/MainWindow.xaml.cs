using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Miru.Core;
using Miru.Documents;
using Miru.Git;
using Windows.System;

namespace Miru.App;

/// <summary>Native presentation only. Filesystem and Git access belong to their services.</summary>
public sealed partial class MainWindow : Window
{
    private readonly string[] arguments;
    private readonly Dictionary<TreeViewNode, ViewerEntry> nodes = [];
    private readonly CancellationTokenSource lifetime = new();
    private ViewerSession? session;
    private bool initialized;
    private bool busy;
    private bool closed;
    private bool navigating;
    private bool applyingSnapshot;
    private bool showingSearch;
    private bool applyingDocument;

    private ViewerSession Session => session ?? throw new ViewerException("Open a folder first.");

    public MainWindow(string[] arguments)
    {
        this.arguments = arguments;
        InitializeComponent();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 820));
        StartContrastTracking();
        Shell.ActualThemeChanged += (_, _) => { if (initialized && !closed) StartDiagrams(); };
        Closed += (_, _) => { closed = true; lifetime.Cancel(); CancelDiagrams(); diagrams.Dispose(); StopContrastTracking(); };
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
        await NavigateAsyncWork(() =>
        {
            var request = LaunchArguments.Parse(arguments, Environment.CurrentDirectory,
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            session = new ViewerSession(request.HomePath);
            Session.Open(request);
            return SnapshotAsync();
        }, ApplySnapshot);
    }

    private async Task NavigateAsyncWork<T>(Func<Task<T>> work, Action<T> apply, Action<Exception>? onError = null)
    {
        if (busy || closed) return;
        // Navigation invalidates old diagrams before filesystem or Git I/O. Theme
        // callbacks must not restart the old document while a new view is pending.
        navigating = true;
        CancelDiagrams();
        try
        {
            await RunAsyncWork(work, result => { navigating = false; apply(result); }, onError ?? ApplyFailedNavigation);
        }
        finally { navigating = false; }
    }

    private void ApplyFailedNavigation(Exception error)
    {
        // The worker may already have changed root/mode and invalidated entry IDs.
        // Do not leave the old tree, comparison or document under the new controls.
        repository = null;
        ApplySnapshot(new(session?.RootPath ?? "", false, session?.Mode ?? ViewerMode.File,
            new([], false), null, Error: error.Message));
    }

    // One filesystem operation at a time. Repeated clicks cannot queue unbounded work.
    // Slow WSL I/O runs off the UI thread; closing the window remains available.
    private Task RunAsync<T>(Func<T> work, Action<T> apply) => RunAsyncWork(() => Task.FromResult(work()), apply);

    private async Task RunAsyncWork<T>(Func<Task<T>> work, Action<T> apply, Action<Exception>? onError = null)
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
            if (!closed)
            {
                if (onError is null) ShowNotice(ex.Message, InfoBarSeverity.Error);
                else onError(ex);
            }
        }
        finally { if (!closed) SetBusy(false); }
    }

    private void SetBusy(bool value)
    {
        busy = value;
        // WinUI panels are not Controls and have no IsEnabled property. Disable the
        // actual interactive controls, including keyboard entry, while I/O is pending.
        HomeButton.IsEnabled = PathInput.IsEnabled = OpenPathButton.IsEnabled = !value;
        ParentButton.IsEnabled = RefreshButton.IsEnabled = FileTree.IsEnabled = !value;
        HomeSearch.IsEnabled = HomeEntries.IsEnabled = !value;
        ChangeTree.IsEnabled = !value;
        FileMode.IsEnabled = RepositoryMode.IsEnabled = FilesRail.IsEnabled = SearchRail.IsEnabled = !value;
        SetTopButton.IsEnabled = !value && CanUseSelectedFolder();
        UpdateGitControls();
        UpdatePdfControls();
        BusyBar.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
        BusyBar.IsIndeterminate = value;
        if (value) StatusText.Text = "Reading local files…";
    }

    private sealed record ViewSnapshot(string Root, bool IsLauncher, ViewerMode Mode,
        DirectoryListing Listing, FilePresentation? File, GitStatus? Git = null, string? Error = null);

    private sealed record FilePresentation(FileContent File, MarkdownResult? Markdown, RasterFrame? Picture = null,
        uint PdfPageCount = 0, HtmlResult? Html = null);

    private async Task<FilePresentation> PrepareFileAsync(FileContent file)
    {
        if (file.Extension == ".pdf")
        {
            var page = await PreparePdfPageAsync(file.Bytes, 0, lifetime.Token);
            return new(file, null, page.Frame, page.Count);
        }
        if (NativeRasterPreview.Supports(file.Extension))
            return new(file, null, await NativeRasterPreview.DecodeAsync(file.Extension, file.Bytes, lifetime.Token));
        if (file.Text is not null && file.Extension is ".html" or ".htm")
            return new(file, null, Html: HtmlPreview.Create(file.Text));
        return new(file, file.Text is not null && file.Extension is ".md" or ".markdown" ? MarkdownPreview.Create(file.Text) : null);
    }

    private void ApplySnapshot(ViewSnapshot state)
    {
        CancelDiagrams();
        displayedFile = null;
        applyingSnapshot = true;
        FileMode.IsChecked = state.Mode == ViewerMode.File;
        RepositoryMode.IsChecked = state.Mode == ViewerMode.Repository;
        applyingSnapshot = false;
        PathInput.Text = state.Root;
        TopLabel.Text = state.Root;
        ToolTipService.SetToolTip(TopLabel, state.Root);
        Title = state.Root.Length == 0 ? "MIRU" : $"MIRU · {state.Root}";
        showingSearch = false;
        HomeSearch.Text = "";
        nodes.Clear();
        FileTree.RootNodes.Clear();
        foreach (var entry in state.Listing.Entries) FileTree.RootNodes.Add(CreateNode(entry));
        SetTopButton.IsEnabled = false;
        HomeEntries.ItemsSource = state.Listing.Entries;
        SourceText.Text = "";
        MarkdownBlocks.Children.Clear();
        StatusText.Text = state.Listing.Truncated
            ? $"First {state.Listing.Entries.Count:N0} entries · listing limited"
            : $"{state.Listing.Entries.Count:N0} entries · read only";
        if (state.Mode == ViewerMode.Repository)
        {
            ApplyRepositorySnapshot(state);
        }
        else if (state.Error is { } error) ShowFileFailure(error);
        else if (state.File is not null) ShowFile(state.File);
        else if (state.IsLauncher)
        {
            ShowPanel(HomePanel);
            DocumentTitle.Text = "Home";
        }
        else ShowEmpty("Select a file", "Browse the tree on the left. Files are never edited.");
        if (state.Mode != ViewerMode.Repository) ClearRepositoryView();
        if (state.Listing.Truncated && state.Error is null) ShowNotice("This folder contains more than 10,000 entries. Only the first bounded listing is shown.");
    }

    private void ShowFileFailure(string error)
    {
        SourceText.Text = "";
        MarkdownBlocks.Children.Clear();
        ShowEmpty("Could not display this item", "Choose another item, refresh this folder, or open a different path.");
        ShowNotice(error, InfoBarSeverity.Error);
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
        if (panel != DocumentPanel) { CancelDiagrams(); displayedFile = null; }
        HomePanel.Visibility = panel == HomePanel ? Visibility.Visible : Visibility.Collapsed;
        DocumentPanel.Visibility = panel == DocumentPanel ? Visibility.Visible : Visibility.Collapsed;
        EmptyPanel.Visibility = panel == EmptyPanel ? Visibility.Visible : Visibility.Collapsed;
        GitPanel.Visibility = panel == GitPanel ? Visibility.Visible : Visibility.Collapsed;
        PicturePanel.Visibility = panel == PicturePanel ? Visibility.Visible : Visibility.Collapsed;
        if (panel != PicturePanel) ClearPicture();
    }

    private void ShowEmpty(string title, string description)
    {
        ShowPanel(EmptyPanel);
        EmptyTitle.Text = title;
        EmptyDescription.Text = description;
        DocumentTitle.Text = "Files";
    }

    private void ShowFile(FilePresentation presentation)
    {
        CancelDiagrams();
        displayedFile = presentation;
        var file = presentation.File;
        DocumentTitle.Text = file.Name;
        StatusText.Text = $"{file.Bytes.Length:N0} bytes · read only";
        MarkdownBlocks.Children.Clear();
        MarkdownScroll.Visibility = Visibility.Collapsed;
        SourceText.Visibility = Visibility.Visible;
        DocumentViews.Visibility = Visibility.Collapsed;
        if (presentation.Picture is { } frame)
        {
            var pdf = presentation.PdfPageCount == 0 ? null : new PdfSelection(file.Name, file.Bytes, 0, presentation.PdfPageCount);
            ShowPicture(file.Name, frame, pdf);
            return;
        }
        if (file.Text is null)
        {
            ShowEmpty("No preview for this file type", "This binary format is not supported by the native viewer.");
            DocumentTitle.Text = file.Name;
            return;
        }
        SourceText.Text = file.Text;
        ShowPanel(DocumentPanel);
        if (presentation.Markdown is not null || presentation.Html is not null)
        {
            var document = presentation.Markdown?.Document ?? presentation.Html?.Document;
            var caption = presentation.Html is not null ? "Static HTML · active content blocked" : "Native Markdown · links and images inactive";
            applyingDocument = true;
            DocumentPreviewCaption.Text = caption;
            DocumentViews.Visibility = Visibility.Visible;
            PreviewView.IsEnabled = document is not null;
            PreviewView.IsChecked = document is not null;
            SourceView.IsChecked = document is null;
            applyingDocument = false;
            if (document is not null)
            {
                NativeDocumentView.Render(MarkdownBlocks, document);
                MarkdownScroll.ChangeView(null, 0, null, true);
                DocumentView_Checked(this, new RoutedEventArgs());
                if (document.Notices.Count != 0) ShowNotice(string.Join(" ", document.Notices));
                if (presentation.Markdown is not null) StartDiagrams();
            }
            else ShowNotice(presentation.Markdown?.Error ?? presentation.Html?.Error ?? "Use Source to read this file.");
        }
        else if (file.Extension == ".svg")
            ShowNotice("SVG is source only. Scripts, links and external resources are not executed.");
    }

    private void DocumentView_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingDocument || MarkdownScroll is null || SourceText is null) return;
        var preview = PreviewView.IsEnabled && PreviewView.IsChecked == true;
        MarkdownScroll.Visibility = preview ? Visibility.Visible : Visibility.Collapsed;
        SourceText.Visibility = preview ? Visibility.Collapsed : Visibility.Visible;
    }

    private void ShowNotice(string message, InfoBarSeverity severity = InfoBarSeverity.Informational)
    {
        Notice.Severity = severity;
        Notice.Message = message;
        Notice.IsOpen = true;
        if (severity == InfoBarSeverity.Error) StatusText.Text = "Could not open this item";
    }

    private async void Home_Click(object sender, RoutedEventArgs e) =>
        await NavigateAsyncWork(() => { Session.OpenHome(); return SnapshotAsync(); }, ApplySnapshot);

    private async void Parent_Click(object sender, RoutedEventArgs e) =>
        await NavigateAsyncWork(() => { Session.Parent(); return SnapshotAsync(); }, ApplySnapshot);

    private async void Refresh_Click(object sender, RoutedEventArgs e) =>
        await NavigateAsyncWork(() => { Session.Refresh(); return SnapshotAsync(); }, ApplySnapshot);

    private async void OpenPath_Click(object sender, RoutedEventArgs e)
    {
        var text = PathInput.Text;
        var cwd = session?.RootPath ?? Environment.CurrentDirectory;
        await NavigateAsyncWork(() =>
        {
            session ??= new ViewerSession(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            var request = LaunchArguments.Parse(["--", text], cwd, Session.HomePath);
            Session.Open(request);
            return SnapshotAsync();
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
        await NavigateAsyncWork(() => { Session.SetTop(entry.Id); return SnapshotAsync(); }, ApplySnapshot);
    }

    private bool CanUseSelectedFolder() => FileMode.IsChecked == true && FileTree.SelectedNode is { } node &&
        nodes.TryGetValue(node, out var entry) && entry.IsDirectory && !entry.IsLink;

    private void Tree_SelectionChanged(TreeView sender, TreeViewSelectionChangedEventArgs args) =>
        SetTopButton.IsEnabled = !busy && CanUseSelectedFolder();

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
        await NavigateAsyncWork(() => PrepareFileAsync(Session.Read(entry.Id)), ShowFile, error => ShowFileFailure(error.Message));
    }

    private async void Home_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not ViewerEntry entry) return;
        if (entry.IsLink) { ShowNotice("Links and junctions are not followed in this native milestone."); return; }
        if (showingSearch)
            await NavigateAsyncWork(() => { Session.OpenSearch(entry.Id); return SnapshotAsync(); }, ApplySnapshot);
        else if (entry.IsDirectory)
            await NavigateAsyncWork(() => { Session.SetTop(entry.Id); return SnapshotAsync(); }, ApplySnapshot);
        else await NavigateAsyncWork(() => PrepareFileAsync(Session.Read(entry.Id)), ShowFile, error => ShowFileFailure(error.Message));
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

    private async void SearchHome_Click(object sender, RoutedEventArgs e)
    {
        await NavigateAsyncWork(() => { Session.OpenHome(); return SnapshotAsync(); }, ApplySnapshot);
        // Focus after the input control is re-enabled, not while it is disabled.
        if (!busy && !closed) HomeSearch.Focus(FocusState.Keyboard);
    }

    private void Files_Click(object sender, RoutedEventArgs e) => FileMode.IsChecked = true;

    private async void FileMode_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingSnapshot || !initialized || session is null) return;
        await NavigateAsyncWork(() => { Session.Mode = ViewerMode.File; return SnapshotAsync(); }, ApplySnapshot);
    }

    private async void RepositoryMode_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingSnapshot || !initialized || session is null) return;
        await NavigateAsyncWork(() => { Session.Mode = ViewerMode.Repository; return SnapshotAsync(); }, ApplySnapshot);
    }

    private void Theme_Click(object sender, RoutedEventArgs e)
    {
        Shell.RequestedTheme = Shell.ActualTheme == ElementTheme.Dark ? ElementTheme.Light : ElementTheme.Dark;
        ThemeButton.Content = new FontIcon { Glyph = Shell.RequestedTheme == ElementTheme.Dark ? "\uE706" : "\uE793", FontSize = 16 };
        StartDiagrams();
    }
}
