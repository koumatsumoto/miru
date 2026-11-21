using System.Buffers.Binary;
using System.Runtime.InteropServices;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Miru.App;

// No paths, URIs, generic codec discovery, or UI objects. Called on the serialized worker.
internal sealed record RasterFrame(byte[]? Pixels, int Width, int Height, uint OriginalWidth, uint OriginalHeight, string? Error)
{
    internal static RasterFrame Unavailable(string message) => new(null, 0, 0, 0, 0, message);
}

internal static class NativeRasterPreview
{
    private const int MaxFileBytes = 2 * 1024 * 1024;
    private const uint MaxEdge = 8192, PreviewEdge = 2048;
    private const ulong MaxPixels = 16_000_000;

    internal static bool Supports(string extension) => extension is ".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp";

    internal static Task<RasterFrame> DecodeAsync(string extension, byte[] bytes, CancellationToken token) =>
        DecodeCoreAsync(extension, bytes, MaxFileBytes, token);

    // Rendered page PNGs come from the bounded Windows PDF service, not from a selected image.
    // Keep the file-read limit on DecodeAsync; only an already rendered page gets the larger allowance.
    internal static Task<RasterFrame> DecodeRenderedPdfPageAsync(byte[] png, CancellationToken token) =>
        DecodeCoreAsync(".png", png, 12 * 1024 * 1024, token);

    private static async Task<RasterFrame> DecodeCoreAsync(string extension, byte[] bytes, int byteLimit, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (bytes.Length == 0 || bytes.Length > byteLimit)
            return RasterFrame.Unavailable("The image is empty or exceeds the preview byte limit.");
        try
        {
            var decoderId = SelectDecoder(extension, bytes);
            if (decoderId is null)
                return RasterFrame.Unavailable("Unsupported or malformed image. Use a static PNG, JPEG, GIF or uncompressed 24/32-bit BMP within the size limits.");
            using var input = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(input))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync().AsTask(token).ConfigureAwait(false);
                writer.DetachStream();
            }
            input.Seek(0);
            // A fixed built-in codec (not automatic arbitration or file association).
            var decoder = await BitmapDecoder.CreateAsync(decoderId.Value, input).AsTask(token).ConfigureAwait(false);
            var width = decoder.PixelWidth;
            var height = decoder.PixelHeight;
            if (!WithinDimensions(width, height))
                return RasterFrame.Unavailable("The image exceeds 8192 pixels on one side or 16 million pixels in total.");
            if (decoder.FrameCount != 1)
                return RasterFrame.Unavailable("Animated and multi-frame images are not previewed.");
            // The GIF decoder returns a raw frame, not a composited logical screen.
            // Treat missing or mismatched metadata as unsupported rather than cropping silently.
            if (extension == ".gif" && !await CoversGifCanvasAsync(decoder, bytes, width, height, token).ConfigureAwait(false))
                return RasterFrame.Unavailable("GIF preview requires a single frame covering the whole canvas.");
            var largest = Math.Max(width, height);
            var w = largest <= PreviewEdge ? width : Math.Max(1u, width * PreviewEdge / largest);
            var h = largest <= PreviewEdge ? height : Math.Max(1u, height * PreviewEdge / largest);
            var transform = new BitmapTransform { ScaledWidth = w, ScaledHeight = h };
            token.ThrowIfCancellationRequested();
            var data = await decoder.GetPixelDataAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
                transform, ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage)
                .AsTask(token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            var pixels = data.DetachPixelData();
            if ((ulong)pixels.LongLength != (ulong)w * h * 4)
                return RasterFrame.Unavailable("The decoded image did not match its bounded dimensions.");
            return new(pixels, (int)w, (int)h, width, height, null);
        }
        catch (Exception error) when (error is IOException or ArgumentException or NotSupportedException or InvalidOperationException or COMException ||
            ((uint)error.HResult >> 16) == 0x8898) // WINCODEC_ERR_* projections
        { return RasterFrame.Unavailable("The local Windows decoder could not read this image."); }
    }

    private static async Task<bool> CoversGifCanvasAsync(
        BitmapDecoder decoder, byte[] bytes, uint frameWidth, uint frameHeight, CancellationToken token)
    {
        // The signature and the logical screen header have already been checked.
        var width = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(6, 2));
        var height = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(8, 2));
        if (frameWidth != width || frameHeight != height) return false;

        const string left = "/imgdesc/Left", top = "/imgdesc/Top", w = "/imgdesc/Width", h = "/imgdesc/Height";
        var frame = await decoder.BitmapProperties.GetPropertiesAsync(new[] { left, top, w, h })
            .AsTask(token).ConfigureAwait(false);
        return Matches(left, 0) && Matches(top, 0) && Matches(w, width) && Matches(h, height);

        bool Matches(string key, ushort expected) =>
            frame.TryGetValue(key, out var property) && property.Value is ushort value && value == expected;
    }

    private static bool WithinDimensions(uint w, uint h) =>
        w is > 0 and <= MaxEdge && h is > 0 and <= MaxEdge && (ulong)w * h <= MaxPixels;

    private static Guid? SelectDecoder(string extension, ReadOnlySpan<byte> data)
    {
        if (extension is ".jpg" or ".jpeg" && data.Length >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff)
            return BitmapDecoder.JpegDecoderId;
        if (extension == ".gif" && data.Length >= 13 && (data.StartsWith("GIF87a"u8) || data.StartsWith("GIF89a"u8)) &&
            WithinDimensions(BinaryPrimitives.ReadUInt16LittleEndian(data[6..]), BinaryPrimitives.ReadUInt16LittleEndian(data[8..])))
            return BitmapDecoder.GifDecoderId;
        // BITMAPINFOHEADER, uncompressed RGB only. Extended headers can reference color profiles.
        if (extension == ".bmp" && data.Length >= 54 && data.StartsWith("BM"u8) &&
            BinaryPrimitives.ReadUInt32LittleEndian(data[14..]) == 40 && BinaryPrimitives.ReadUInt16LittleEndian(data[26..]) == 1 &&
            BinaryPrimitives.ReadUInt16LittleEndian(data[28..]) is 24 or 32 && BinaryPrimitives.ReadUInt32LittleEndian(data[30..]) == 0)
        {
            var w = BinaryPrimitives.ReadInt32LittleEndian(data[18..]);
            var h = BinaryPrimitives.ReadInt32LittleEndian(data[22..]);
            if (w > 0 && h != int.MinValue && WithinDimensions((uint)w, (uint)Math.Abs(h))) return BitmapDecoder.BmpDecoderId;
        }
        if (extension == ".png" && IsStaticPng(data)) return BitmapDecoder.PngDecoderId;
        return null;
    }

    private static bool IsStaticPng(ReadOnlySpan<byte> data)
    {
        ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (data.Length < 33 || !data.StartsWith(signature) || BinaryPrimitives.ReadUInt32BigEndian(data[8..]) != 13 ||
            !data.Slice(12, 4).SequenceEqual("IHDR"u8) ||
            !WithinDimensions(BinaryPrimitives.ReadUInt32BigEndian(data[16..]), BinaryPrimitives.ReadUInt32BigEndian(data[20..]))) return false;
        // WIC versions differ in APNG support; never accidentally present one frame as the whole image.
        var offset = 8;
        for (var chunks = 0; chunks < 4096 && data.Length - offset >= 12; chunks++)
        {
            var length = BinaryPrimitives.ReadUInt32BigEndian(data[offset..]);
            if (length > data.Length - offset - 12) return false;
            var type = data.Slice(offset + 4, 4);
            if (type.SequenceEqual("acTL"u8) || type.SequenceEqual("fcTL"u8) || type.SequenceEqual("fdAT"u8)) return false;
            offset += (int)length + 12;
            if (type.SequenceEqual("IEND"u8)) return length == 0 && offset == data.Length;
        }
        return false;
    }
}
