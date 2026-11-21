using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Miru.App;

public sealed partial class MainWindow
{
    // Only bounded premultiplied BGRA pixels enter XAML. Never pass a file or URL to Image.
    private void ShowPicture(string name, RasterFrame frame, string? caption)
    {
        if (frame.Pixels is not { } pixels)
        {
            ShowEmpty("Preview unavailable", frame.Error ?? "This image cannot be displayed.");
            DocumentTitle.Text = name;
            return;
        }
        var bitmap = new WriteableBitmap(frame.Width, frame.Height);
        using (var target = bitmap.PixelBuffer.AsStream()) target.Write(pixels, 0, pixels.Length);
        bitmap.Invalidate();
        ShowPanel(PicturePanel);
        PictureImage.Source = bitmap;
        PictureImage.MaxWidth = frame.Width;
        PictureImage.MaxHeight = frame.Height;
        AutomationProperties.SetName(PictureImage, name);
        PictureCaption.Text = caption ?? $"{frame.OriginalWidth:N0} × {frame.OriginalHeight:N0} pixels · read only";
    }
}
