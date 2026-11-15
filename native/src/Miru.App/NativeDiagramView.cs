using Microsoft.UI.Xaml.Media.Imaging;
using Miru.Diagrams;
using Windows.Storage.Streams;

namespace Miru.App;

internal sealed record DiagramVisual(BitmapImage? Bitmap, int Width, int Height, string? Error);

// Only PNG bytes from the bounded native renderer, never a document URI or SVG.
internal static class NativeDiagramView
{
    internal static async Task<IReadOnlyDictionary<string, DiagramVisual>> DecodeAsync(DiagramBatch batch, CancellationToken token)
    {
        var result = new Dictionary<string, DiagramVisual>(StringComparer.Ordinal);
        foreach (var (source, image) in batch.Diagrams)
        {
            token.ThrowIfCancellationRequested();
            if (image.Png is not { } png)
            { result[source] = new(null, 0, 0, image.Error); continue; }
            try
            {
                using var stream = new InMemoryRandomAccessStream();
                using (var writer = new DataWriter(stream))
                {
                    writer.WriteBytes(png);
                    await writer.StoreAsync().AsTask(token);
                    writer.DetachStream();
                }
                stream.Seek(0);
                var bitmap = new BitmapImage { DecodePixelWidth = image.Width, DecodePixelHeight = image.Height };
                await bitmap.SetSourceAsync(stream).AsTask(token);
                token.ThrowIfCancellationRequested();
                result[source] = new(bitmap, image.Width, image.Height, null);
            }
            catch (Exception error) when (error is IOException or ArgumentException or System.Runtime.InteropServices.COMException)
            { result[source] = new(null, 0, 0, "The generated diagram image could not be decoded. Read its source."); }
        }
        return result;
    }
}
