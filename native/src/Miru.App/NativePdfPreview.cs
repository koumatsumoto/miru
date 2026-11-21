using System.Buffers.Binary;
using Miru.Core;
using Windows.Data.Pdf;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Miru.App;

internal sealed record PdfPreviewResult(byte[]? Png, int Width, int Height, uint PageCount, string? Error);

// A static raster preview, not a PDF viewer. Input is the already scoped Core read;
// there is no filename, URI, external handler, scripting or navigation surface here.
internal static class NativePdfPreview
{
    internal const int MaxEdge = 1536;
    internal const int MaxEncodedBytes = 12 * 1024 * 1024;
    private static readonly SemaphoreSlim Renderer = new(1, 1);
    private const int WrongPassword = unchecked((int)0x8007052B);
    private const int InvalidPassword = unchecked((int)0x80070056);

    internal static async Task<PdfPreviewResult> RenderFirstPageAsync(byte[] bytes, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (bytes.Length > ViewerSession.FileLimitBytes) return Failure("PDF exceeds the 2 MiB input limit.");
        if (!bytes.AsSpan().StartsWith("%PDF-"u8)) return Failure("Not a supported PDF document.");

        // Do not accumulate simultaneous native decoders on repeated opens. WinRT
        // cancellation is cooperative, not a hard OS sandbox or CPU-time limit.
        await Renderer.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var input = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(input))
            {
                writer.WriteBytes(bytes);
                var saved = await writer.StoreAsync().AsTask(token).ConfigureAwait(false);
                if (saved != (uint)bytes.Length) return Failure("Could not read the complete PDF.");
                writer.DetachStream();
            }
            input.Seek(0);
            var document = await PdfDocument.LoadFromStreamAsync(input).AsTask(token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (document.IsPasswordProtected) return Failure("Password-protected PDFs cannot be previewed.");
            var count = document.PageCount;
            if (count == 0) return Failure("The PDF has no pages.");
            using var page = document.GetPage(0);
            var size = page.Size;
            if (!double.IsFinite(size.Width) || !double.IsFinite(size.Height) || size.Width <= 0 || size.Height <= 0)
                return Failure("The PDF page has unsupported dimensions.");
            var scale = Math.Min(1d, MaxEdge / (double)Math.Max(size.Width, size.Height));
            var width = Math.Clamp((int)Math.Round(size.Width * scale), 1, MaxEdge);
            var height = Math.Clamp((int)Math.Round(size.Height * scale), 1, MaxEdge);
            var settings = new PdfPageRenderOptions
            {
                DestinationWidth = (uint)width,
                DestinationHeight = (uint)height,
                BitmapEncoderId = BitmapEncoder.PngEncoderId
            };
            using var output = new InMemoryRandomAccessStream();
            await page.RenderToStreamAsync(output, settings).AsTask(token).ConfigureAwait(false);
            var length = output.Size;
            if (length is < 33 or > MaxEncodedBytes) return Failure("The rendered PDF page exceeds preview limits.");
            using var reader = new DataReader(output.GetInputStreamAt(0));
            if (await reader.LoadAsync((uint)length).AsTask(token).ConfigureAwait(false) != (uint)length)
                return Failure("The rendered PDF page is incomplete.");
            var png = new byte[(int)length];
            reader.ReadBytes(png);
            token.ThrowIfCancellationRequested();
            // Validate the actual output too, before handing bytes to any UI decoder.
            if (!png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ||
                !png.AsSpan(12, 4).SequenceEqual("IHDR"u8) ||
                BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16, 4)) != (uint)width ||
                BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20, 4)) != (uint)height)
                return Failure("The rendered PDF image has unsupported dimensions.");
            return new(png, width, height, count, null);
        }
        catch (Exception error) when (error.HResult is WrongPassword or InvalidPassword)
        {
            token.ThrowIfCancellationRequested();
            return Failure("Password-protected PDFs cannot be previewed.");
        }
        catch (Exception error) when (error is not (OperationCanceledException or OutOfMemoryException or
            StackOverflowException or AccessViolationException))
        {
            token.ThrowIfCancellationRequested();
            return Failure("This PDF is damaged, protected, or not supported by the Windows PDF renderer.");
        }
        finally { Renderer.Release(); }
    }

    private static PdfPreviewResult Failure(string message) => new(null, 0, 0, 0, message);
}
