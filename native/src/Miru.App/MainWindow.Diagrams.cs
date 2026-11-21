using Microsoft.UI.Xaml;
using Miru.Diagrams;
using Miru.Documents;
using System.Runtime.InteropServices;
using DesktopThemeSettings = Microsoft.UI.System.ThemeSettings;

namespace Miru.App;

public sealed partial class MainWindow
{
    private readonly DiagramSession diagrams = new();
    private DesktopThemeSettings? contrastSettings;
    private CancellationTokenSource? diagramDecode;
    private FilePresentation? displayedFile;

    private void CancelDiagrams()
    {
        diagrams.Invalidate();
        diagramDecode?.Cancel();
        diagramDecode?.Dispose();
        diagramDecode = null;
    }

    // The desktop theme API is scoped to this top-level WinUI window. Some
    // environments cannot provide notifications; the viewer still opens and
    // leaves diagram sources readable instead of guessing the contrast mode.
    private void StartContrastTracking()
    {
        try
        {
            var settings = DesktopThemeSettings.CreateForWindowId(AppWindow.Id);
            settings.Changed += Contrast_Changed;
            contrastSettings = settings;
        }
        catch (COMException) { contrastSettings = null; }
    }

    private void StopContrastTracking()
    {
        var settings = contrastSettings;
        contrastSettings = null;
        if (settings is null) return;
        try { settings.Changed -= Contrast_Changed; }
        catch (COMException) { /* The window's theme provider may already be gone. */ }
    }

    private bool? ReadHighContrast()
    {
        try { return contrastSettings?.HighContrast; }
        catch (COMException) { return null; }
    }

    private void Contrast_Changed(DesktopThemeSettings sender, object args) =>
        DispatcherQueue.TryEnqueue(() => { if (!closed) StartDiagrams(); });

    private void StartDiagrams()
    {
        CancelDiagrams();
        if (displayedFile is not { Markdown.Document: { } document } presentation || closed) return;
        var sources = MermaidSources(document.Blocks).Take(400).ToArray();
        if (sources.Length == 0) return;
        // Remove old-theme images immediately. Text/source remain selectable while
        // the off-thread renderer works; navigation is not blocked by generation.
        var offset = MarkdownScroll.VerticalOffset;
        NativeDocumentView.Render(MarkdownBlocks, document);
        MarkdownScroll.ChangeView(null, offset, null, true);
        if (navigating) return;
        var highContrast = ReadHighContrast();
        if (highContrast != false)
        {
            ShowNotice(highContrast == true
                ? "Mermaid uses source-only display in High Contrast so system text colors remain readable."
                : "Mermaid uses source-only display when Windows contrast settings are unavailable.");
            return;
        }
        diagramDecode = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        ShowNotice("Mermaid preview is rendering locally. Source remains available.");
        var dark = Shell.RequestedTheme == ElementTheme.Dark ||
            (Shell.RequestedTheme == ElementTheme.Default && Shell.ActualTheme == ElementTheme.Dark);
        _ = RenderDiagramsAsync(presentation, sources, dark, diagramDecode.Token);
    }

    private async Task RenderDiagramsAsync(FilePresentation presentation, IReadOnlyList<string> sources, bool dark, CancellationToken token)
    {
        try
        {
            var batch = await Task.Run(() => diagrams.RenderLatestAsync(sources, dark, token), token);
            if (!Current()) return;
            var images = await NativeDiagramView.DecodeAsync(batch, token);
            if (!Current()) return;
            var offset = MarkdownScroll.VerticalOffset;
            NativeDocumentView.Render(MarkdownBlocks, presentation.Markdown!.Document!, images);
            MarkdownScroll.ChangeView(null, offset, null, true);
            if (sources.Distinct(StringComparer.Ordinal).Count() > DiagramSession.MaximumDiagrams || images.Values.Any(x => x.Error is not null))
                ShowNotice("Some Mermaid diagrams are source-only. Each block explains its limit or unsupported content.");
            else ShowNotice("Local Mermaid subset: flowchart / sequence. Expand a block or choose Source to read its text.");

            bool Current() => !closed && !navigating && !token.IsCancellationRequested && diagrams.IsCurrent(batch.Version) &&
                ReferenceEquals(displayedFile, presentation) && DocumentPanel.Visibility == Visibility.Visible;
        }
        catch (OperationCanceledException) { /* Superseded navigation/theme/close is not an error. */ }
        catch (Exception error) when (error is IOException or ArgumentException or NotSupportedException or System.Runtime.InteropServices.COMException)
        {
            if (!closed && !token.IsCancellationRequested && ReferenceEquals(displayedFile, presentation))
                ShowNotice("Mermaid preview is unavailable. Its source remains readable.");
        }
    }

    private static IEnumerable<string> MermaidSources(IReadOnlyList<DocumentBlock> blocks)
    {
        foreach (var block in blocks)
        {
            if (block is Code { IsMermaid: true } code) yield return code.Text;
            else if (block is Quote quote)
                foreach (var source in MermaidSources(quote.Blocks)) yield return source;
            else if (block is ItemList list)
                foreach (var item in list.Items)
                    foreach (var source in MermaidSources(item.Blocks)) yield return source;
        }
    }
}
