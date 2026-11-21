using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Miru.App;

public sealed partial class MainWindow
{
    private sealed record PdfSelection(string Name, byte[] Bytes, uint Index, uint Count);
    private PdfSelection? pdfSelection;

    private static async Task<(RasterFrame Frame, uint Count)> PreparePdfPageAsync(byte[] bytes, uint index, CancellationToken token)
    {
        var result = await NativePdfPreview.RenderPageAsync(bytes, index, token).ConfigureAwait(false);
        var frame = result.Png is { } png
            ? await NativeRasterPreview.DecodeRenderedPdfPageAsync(png, token).ConfigureAwait(false)
            : RasterFrame.Unavailable(result.Error ?? "The PDF page could not be rendered.");
        return (frame, result.PageCount);
    }

    // Only bounded premultiplied BGRA pixels enter XAML. Never pass a file or URL to Image.
    private void ShowPicture(string name, RasterFrame frame, PdfSelection? pdf)
    {
        if (frame.Pixels is null && pdf is null)
        {
            ShowEmpty("Preview unavailable", frame.Error ?? "This image cannot be displayed.");
            DocumentTitle.Text = name;
            return;
        }
        ShowPanel(PicturePanel);
        pdfSelection = pdf;
        PdfPager.Visibility = pdf is { Count: > 1 } ? Visibility.Visible : Visibility.Collapsed;
        UpdatePdfControls();
        PictureCaption.Text = pdf is not null ? $"PDF · page {pdf.Index + 1:N0} of {pdf.Count:N0}"
            : $"{frame.OriginalWidth:N0} × {frame.OriginalHeight:N0} pixels · read only";
        if (pdf is not null) StatusText.Text = $"{pdf.Bytes.Length:N0} bytes · read only";
        PictureImage.Source = null;
        if (frame.Pixels is not { } pixels)
        {
            // The page remains navigable, but never show the previous page under its number.
            ShowNotice(frame.Error ?? "This PDF page cannot be displayed.", InfoBarSeverity.Error);
            return;
        }

        var bitmap = new WriteableBitmap(frame.Width, frame.Height);
        using (var target = bitmap.PixelBuffer.AsStream()) target.Write(pixels, 0, pixels.Length);
        bitmap.Invalidate();
        PictureImage.Source = bitmap;
        PictureImage.MaxWidth = frame.Width;
        PictureImage.MaxHeight = frame.Height;
        AutomationProperties.SetName(PictureImage, pdf is not null ? name + $", page {pdf.Index + 1}" : name);
    }

    private void ClearPicture()
    {
        pdfSelection = null;
        PictureImage.Source = null;
        PictureCaption.Text = "";
        PdfPager.Visibility = Visibility.Collapsed;
        UpdatePdfControls();
    }

    private void UpdatePdfControls()
    {
        PdfPrevious.IsEnabled = !busy && pdfSelection is { Index: > 0 };
        PdfNext.IsEnabled = !busy && pdfSelection is { } pdf && pdf.Index + 1 < pdf.Count;
    }

    private async Task ChangePdfPageAsync(bool next)
    {
        if (busy || closed || PicturePanel.Visibility != Visibility.Visible || pdfSelection is not { } current) return;
        if (next ? current.Index + 1 >= current.Count : current.Index == 0) return;
        var index = next ? current.Index + 1 : current.Index - 1;

        // No eager pages or reopens from disk. Refresh/re-open replaces the source
        // bytes; the same serialized worker takes exactly one page of this selection.
        await RunAsyncWork(() => PreparePdfPageAsync(current.Bytes, index, lifetime.Token), result =>
        {
            if (!ReferenceEquals(pdfSelection, current) || PicturePanel.Visibility != Visibility.Visible) return;
            var frame = result.Count != 0 && result.Count != current.Count
                ? RasterFrame.Unavailable("The PDF page count did not match this preview. Refresh to reopen it.")
                : result.Frame;
            ShowPicture(current.Name, frame, current with { Index = index });
        });
    }

    private async void PdfPrevious_Click(object sender, RoutedEventArgs e) => await ChangePdfPageAsync(false);
    private async void PdfNext_Click(object sender, RoutedEventArgs e) => await ChangePdfPageAsync(true);
}
