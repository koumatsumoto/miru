using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Miru.Core;
using Miru.Documents;
using Miru.Git;

namespace Miru.App;

public sealed partial class MainWindow
{
    private const int VisibleChangeLimit = 3_000;
    private const int FolderNodeLimit = 3_000;
    private const int FolderDepthLimit = 32;
    private readonly Dictionary<TreeViewNode, GitChange> changeNodes = [];
    private GitRepository? repository;
    private GitChange? selectedChange;
    private bool applyingGit;
    private bool canHighlight;

    // Called only by the serialized worker. Files mode never opens Git.
    private async Task<ViewSnapshot> SnapshotAsync()
    {
        var root = Session.RootPath!;
        if (Session.Mode != ViewerMode.Repository)
        {
            repository = null;
            return new(root, Session.IsLauncher, Session.Mode, Session.List(),
                Session.SelectedEntry is { } selected ? PrepareFile(Session.Read(selected.Id)) : null);
        }
        try
        {
            if (repository?.TopPath != root) repository = await GitRepository.OpenAsync(root, lifetime.Token);
            var status = await repository.RefreshAsync(lifetime.Token);
            return new(root, false, ViewerMode.Repository, new([], false), null, status);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            repository = null;
            return new(root, false, ViewerMode.Repository, new([], false), null, GitError: error.Message);
        }
    }

    private void ClearRepositoryView()
    {
        changeNodes.Clear();
        ChangeTree.RootNodes.Clear();
        ChangeTree.Visibility = Visibility.Collapsed;
        FileTree.Visibility = Visibility.Visible;
        ExplorerTitle.Text = "EXPLORER";
        SetTopButton.Content = "Use selected folder as top";
        selectedChange = null;
        ComparisonLines.ItemsSource = null;
        BeforeText.Text = AfterText.Text = "";
        UpdateGitControls();
    }

    private void ApplyRepositorySnapshot(ViewSnapshot state)
    {
        ClearRepositoryView();
        ChangeTree.Visibility = Visibility.Visible;
        FileTree.Visibility = Visibility.Collapsed;
        ExplorerTitle.Text = "CHANGES";
        SetTopButton.Content = "Choose top in Files";
        SetTopButton.IsEnabled = false;
        if (state.Git is not { } status)
        {
            ShowEmpty("Git view unavailable", state.GitError ?? "Open a local Git working folder.");
            DocumentTitle.Text = "Repository";
            StatusText.Text = "Files remain available · no Git write operation";
            return;
        }
        var folders = new Dictionary<string, TreeViewNode>(StringComparer.Ordinal);
        var flattened = false;
        foreach (var change in status.Changes.Take(VisibleChangeLimit))
        {
            var parts = change.RelativePath.Replace('\\', '/').Split('/');
            TreeViewNode? parent = null;
            var key = "";
            // A small number of deeply nested paths must not manufacture an
            // unbounded tree. Keep the full path as a flat label when necessary.
            var flat = parts.Length - 1 > FolderDepthLimit || folders.Count + parts.Length - 1 > FolderNodeLimit;
            flattened |= flat;
            foreach (var part in flat ? Array.Empty<string>() : parts[..^1])
            {
                key += part + "/";
                if (!folders.TryGetValue(key, out var folder))
                {
                    folder = new TreeViewNode { Content = part, IsExpanded = true };
                    folders.Add(key, folder);
                    if (parent is null) ChangeTree.RootNodes.Add(folder); else parent.Children.Add(folder);
                }
                parent = folder;
            }
            var label = $"{change.IndexStatus}{change.WorktreeStatus}  {(flat ? change.RelativePath : parts[^1])}";
            var text = new TextBlock { Text = label, TextTrimming = TextTrimming.CharacterEllipsis };
            AutomationProperties.SetName(text, change.RelativePath + (change.IsConflict ? ", conflict" : "") +
                (change.IsStaged ? ", staged" : "") + (change.IsUnstaged ? ", unstaged" : ""));
            var node = new TreeViewNode { Content = text };
            changeNodes[node] = change;
            if (parent is null) ChangeTree.RootNodes.Add(node); else parent.Children.Add(node);
        }
        ShowEmpty(status.Changes.Count == 0 ? "No changes inside this top" : "Select a change",
            "Staged compares HEAD to index. Unstaged compares index to working files. Submodule working changes are not traversed. Files are never staged or edited.");
        DocumentTitle.Text = "Repository";
        StatusText.Text = $"{status.Changes.Count} changes · {status.Changes.Count(c => c.IsStaged)} staged · {status.Changes.Count(c => c.IsUnstaged)} unstaged";
        var notices = new List<string>();
        if (status.Changes.Count > VisibleChangeLimit)
            notices.Add($"Only the first {VisibleChangeLimit:N0} changes are displayed. Choose a narrower top in Files to see another subtree.");
        if (flattened) notices.Add("Some deep or numerous folders are flattened to full-path labels to keep the change tree bounded.");
        if (notices.Count != 0) ShowNotice(string.Join(" ", notices));
    }

    private sealed record GitPresentation(GitChange Change, GitStage Stage, GitDiff Diff, LineComparisonResult? Comparison);

    private async Task OpenChangeAsync(GitChange change, GitStage stage)
    {
        if (busy || closed) return;
        var current = repository;
        if (current is null) return;
        // A changed selection/stage must not leave the old text under a new label,
        // including when the later read fails. The content returns only on success.
        GitContent.Visibility = Visibility.Collapsed;
        GitMessage.Text = "Reading comparison…";
        GitMessage.Visibility = Visibility.Visible;
        DocumentTitle.Text = change.RelativePath;
        ShowPanel(GitPanel);
        await RunAsyncWork(async () =>
        {
            try
            {
                var diff = await current.ReadDiffAsync(change.Id, stage, lifetime.Token);
                return new GitPresentation(change, stage, diff,
                    !diff.Binary && diff.Message is null ? LineComparison.Create(diff.Before, diff.After) : null);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            { return new GitPresentation(change, stage, new("", "", false, error.Message), null); }
        }, ShowGitDiff);
    }

    private async void ChangeTree_ItemInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
    {
        if (args.InvokedItem is not TreeViewNode node || !changeNodes.TryGetValue(node, out var change)) return;
        await OpenChangeAsync(change, change.IsStaged ? GitStage.Staged : GitStage.Unstaged);
    }

    private void ShowGitDiff(GitPresentation state)
    {
        selectedChange = state.Change;
        DocumentTitle.Text = state.Change.RelativePath;
        applyingGit = true;
        GitStaged.IsChecked = state.Stage == GitStage.Staged;
        GitUnstaged.IsChecked = state.Stage == GitStage.Unstaged;
        BeforeTitle.Text = state.Stage == GitStage.Staged ? "HEAD" : "INDEX";
        AfterTitle.Text = state.Stage == GitStage.Staged ? "INDEX" : "WORKING FILE";
        BeforeText.Text = state.Diff.Before;
        AfterText.Text = state.Diff.After;
        ComparisonLines.ItemsSource = state.Comparison?.Lines;
        canHighlight = state.Comparison?.CanCompare == true;
        GitHighlight.IsEnabled = canHighlight;
        GitHighlight.IsChecked = canHighlight;
        GitVersions.IsChecked = !canHighlight;
        GitMessage.Text = state.Diff.Message ?? "";
        GitMessage.Visibility = state.Diff.Message is null ? Visibility.Collapsed : Visibility.Visible;
        GitContent.Visibility = state.Diff.Message is null ? Visibility.Visible : Visibility.Collapsed;
        applyingGit = false;
        ShowPanel(GitPanel);
        GitDisplay_Checked(this, new RoutedEventArgs());
        UpdateGitControls();
        StatusText.Text = (state.Stage == GitStage.Staged ? "HEAD → index" : "Index → working file") + " · read only";
        var notes = new[] { state.Diff.Notice, state.Comparison?.Notice,
            state.Change.OriginalRelativePath is { } original ? "Renamed from " + original : null };
        var notice = string.Join(" ", notes.Where(x => !string.IsNullOrWhiteSpace(x)));
        if (notice.Length != 0) ShowNotice(notice);
    }

    private void UpdateGitControls()
    {
        GitStaged.IsEnabled = !busy && selectedChange?.IsStaged == true;
        GitUnstaged.IsEnabled = !busy && selectedChange?.IsUnstaged == true;
    }

    private async void GitStage_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingGit || busy || selectedChange is not { } change) return;
        await OpenChangeAsync(change, GitStaged.IsChecked == true ? GitStage.Staged : GitStage.Unstaged);
    }

    private void GitDisplay_Checked(object sender, RoutedEventArgs e)
    {
        if (applyingGit || ComparisonLines is null || VersionColumns is null) return;
        var highlighted = canHighlight && GitHighlight.IsChecked == true;
        ComparisonLines.Visibility = highlighted ? Visibility.Visible : Visibility.Collapsed;
        VersionColumns.Visibility = highlighted ? Visibility.Collapsed : Visibility.Visible;
    }

    private void Comparison_ContainerContentChanging(ListViewBase sender, ContainerContentChangingEventArgs args)
    {
        if (args.InRecycleQueue || args.Item is not ComparisonLine line) return;
        var key = line.Kind switch { LineKind.Added => "GitAddedItem", LineKind.Removed => "GitRemovedItem", _ => "GitLineItem" };
        args.ItemContainer.Style = (Style)Application.Current.Resources[key];
    }
}
