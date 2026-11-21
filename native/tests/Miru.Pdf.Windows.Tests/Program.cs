using System.Reflection;
using Miru.App;
using Miru.Core;

// All inputs are synthetic and embedded. The Windows PDF engine is exercised
// headlessly; this is not a GUI, WSL or physical-display acceptance test.
if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This smoke must run on Windows.");
var token = CancellationToken.None;
var fixture = ReadFixture("two-pages.pdf");
var good = await NativePdfPreview.RenderPageAsync(fixture, 0, token);
Check(good.Png is not null && good.Error is null && good.PageCount == 2, "two-page document / first page");
Check(good.Width == NativePdfPreview.MaxEdge && good.Height == good.Width / 2, "aspect and raster bound");
Check(good.Png!.Length <= NativePdfPreview.MaxEncodedBytes, "encoded output budget");
var raster = await NativeRasterPreview.DecodeRenderedPdfPageAsync(good.Png!, token);
Check(raster.Width == good.Width && raster.Height == good.Height && raster.Error is null,
    "the production image path accepts the rendered PNG");
var pixels = raster.Pixels ?? throw new InvalidOperationException("No rendered pixels.");
var left = 4 * ((good.Height / 2) * good.Width + good.Width / 4);
var right = 4 * ((good.Height / 2) * good.Width + 3 * good.Width / 4);
Check(!pixels.AsSpan(left, 4).SequenceEqual(pixels.AsSpan(right, 4)), "first page contains its two distinct halves");
// Page two is a small, square gray image in the same synthetic document.
var second = await NativePdfPreview.RenderPageAsync(fixture, 1, token);
Check(second.Png is not null && second.Error is null && second.PageCount == 2, "second page selection");
Check(second.Width == second.Height && second.Width is > 0 and < 256, "second page dimensions rather than page one");
var secondRaster = await NativeRasterPreview.DecodeRenderedPdfPageAsync(second.Png!, token);
Check(secondRaster.Error is null && secondRaster.Width == second.Width && secondRaster.Height == second.Height,
    "the second page passes the same production decode path");
var secondPixels = secondRaster.Pixels ?? throw new InvalidOperationException("No second page pixels.");
var center = 4 * ((second.Height / 2) * second.Width + second.Width / 2);
Check(secondPixels[center] is > 63 and < 224 &&
    secondPixels[center] == secondPixels[center + 1] && secondPixels[center] == secondPixels[center + 2] &&
    secondPixels[center + 3] == 255, "second page has its own gray content");

foreach (var index in new uint[] { 2, uint.MaxValue })
{
    var invalid = await NativePdfPreview.RenderPageAsync(fixture, index, token);
    Check(invalid.Png is null && invalid.PageCount == 2 && invalid.Error?.Contains("outside this document", StringComparison.Ordinal) == true,
        "out-of-range page refused before render");
}
foreach (var (input, message) in new (byte[], string)[]
{
    (ReadFixture("protected.pdf"), "Password-protected"),
    ("%PDF-1.4\nnot a document\n%%EOF"u8.ToArray(), "PDF"),
    ("not a PDF"u8.ToArray(), "PDF"),
    (new byte[ViewerSession.FileLimitBytes + 1], "2 MiB")
})
{
    var rejected = await NativePdfPreview.RenderPageAsync(input, 0, token);
    Check(rejected.Png is null && rejected.Error?.Contains(message, StringComparison.OrdinalIgnoreCase) == true,
        $"safe fallback: {message}");
}
using (var canceled = new CancellationTokenSource())
{
    canceled.Cancel();
    try { await NativePdfPreview.RenderPageAsync(fixture, 0, canceled.Token); throw new Exception("Cancellation was ignored."); }
    catch (OperationCanceledException) when (canceled.IsCancellationRequested) { }
}
var back = await NativePdfPreview.RenderPageAsync(fixture, 0, token);
Check(back.Png is not null && back.Width == good.Width && back.Height == good.Height, "back to page one after failures / cancellation");
Console.WriteLine("PASS: Windows PDF render, distinct pages, index bounds, protected/malformed/oversize fallback, cancellation and repeat. No WinUI window launched.");

static byte[] ReadFixture(string name)
{
    using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
        ?? throw new InvalidOperationException($"Missing embedded synthetic PDF: {name}");
    using var bytes = new MemoryStream();
    resource.CopyTo(bytes);
    return bytes.ToArray();
}

static void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException($"PDF smoke failed: {description}.");
}
