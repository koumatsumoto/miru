using System.Reflection;
using Miru.App;
using Miru.Core;

// All inputs are synthetic and embedded. The Windows PDF engine is exercised
// headlessly; this is not a GUI, WSL or physical-display acceptance test.
if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This smoke must run on Windows.");
var token = CancellationToken.None;
var fixture = ReadFixture("two-pages.pdf");
var good = await NativePdfPreview.RenderFirstPageAsync(fixture, token);
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
foreach (var (input, message) in new (byte[], string)[]
{
    (ReadFixture("protected.pdf"), "Password-protected"),
    ("%PDF-1.4\nnot a document\n%%EOF"u8.ToArray(), "PDF"),
    ("not a PDF"u8.ToArray(), "PDF"),
    (new byte[ViewerSession.FileLimitBytes + 1], "2 MiB")
})
{
    var rejected = await NativePdfPreview.RenderFirstPageAsync(input, token);
    Check(rejected.Png is null && rejected.Error?.Contains(message, StringComparison.OrdinalIgnoreCase) == true,
        $"safe fallback: {message}");
}
using (var canceled = new CancellationTokenSource())
{
    canceled.Cancel();
    try { await NativePdfPreview.RenderFirstPageAsync(fixture, canceled.Token); throw new Exception("Cancellation was ignored."); }
    catch (OperationCanceledException) when (canceled.IsCancellationRequested) { }
}
Check((await NativePdfPreview.RenderFirstPageAsync(fixture, token)).Png is not null, "next render after failures / cancellation");
Console.WriteLine("PASS: Windows PDF render, first-page content and bounds, protected/malformed/oversize fallback, cancellation and repeat. No WinUI window launched.");

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
