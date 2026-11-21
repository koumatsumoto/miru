using System.Buffers.Binary;
using Miru.App;

static void Check(bool condition, string name)
{
    if (!condition) throw new InvalidOperationException("Raster test failed: " + name);
}

static byte[] B64(string value) => Convert.FromBase64String(value);
static async Task Reject(string ext, byte[] bytes, string name)
{
    var frame = await NativeRasterPreview.DecodeAsync(ext, bytes, default);
    Check(frame.Pixels is null && !string.IsNullOrWhiteSpace(frame.Error), name);
}

// Tiny neutral test inputs: two red pixels per image. This exercises the real Windows codecs, not WinUI.
var png = B64("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR42mP8z8DAwMAAAAYIAQFyPMoyAAAAAElFTkSuQmCC");
var jpg = B64("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCLAGVxf//Z");
var gif = B64("R0lGODdhAgABAIEAAP8AAAAAAAAAAAAAACwAAAAAAgABAAAIBQABAAgIADs=");
var bmp = B64("Qk0+AAAAAAAAADYAAAAoAAAAAgAAAAEAAAABABgAAAAAAAgAAADEDgAAxA4AAAAAAAAAAAAAAAD/AAD/AAA=");

foreach (var (ext, bytes) in new[] { (".png", png), (".jpg", jpg), (".jpeg", jpg), (".gif", gif), (".bmp", bmp) })
{
    var frame = await NativeRasterPreview.DecodeAsync(ext, bytes, default);
    Check(frame is { Width: 2, Height: 1, OriginalWidth: 2, OriginalHeight: 1, Pixels.Length: 8 }, ext + " dimensions");
    var pixels = frame.Pixels ?? throw new InvalidOperationException(ext + ": pixel data missing");
    Check(pixels[0] < 20 && pixels[1] < 20 && pixels[2] > 230 && pixels[3] == 255, ext + " BGRA");
}
// The original 2x1 frame is unchanged, but a 3x2 canvas makes it a partial image.
var croppedGif = gif.ToArray();
BinaryPrimitives.WriteUInt16LittleEndian(croppedGif.AsSpan(6, 2), 3);
BinaryPrimitives.WriteUInt16LittleEndian(croppedGif.AsSpan(8, 2), 2);
var crop = await NativeRasterPreview.DecodeAsync(".gif", croppedGif, default);
Check(crop is { Pixels: null, Error: "GIF preview requires a single frame covering the whole canvas." }, "smaller frame at origin");

// The descriptor follows the fixture's 12-byte global color table; this 2x1 frame still
// fits the declared 3x2 canvas after moving one pixel right and down.
var offsetGif = croppedGif.ToArray();
Check(offsetGif[25] == 0x2c, "fixture GIF image descriptor");
BinaryPrimitives.WriteUInt16LittleEndian(offsetGif.AsSpan(26, 2), 1);
BinaryPrimitives.WriteUInt16LittleEndian(offsetGif.AsSpan(28, 2), 1);
await Reject(".gif", offsetGif, "valid offset subframe");

await Reject(".png", jpg, "extension and data must match");
await Reject(".svg", "<svg/>"u8.ToArray(), "SVG has no raster decoder");
await Reject(".png", "<svg/>"u8.ToArray(), "renamed text never interpreted");
await Reject(".png", png[..^5], "truncated data");
await Reject(".bmp", new byte[2 * 1024 * 1024 + 1], "encoded byte limit");
await Reject(".png", [], "empty input");
var huge = png.ToArray();
BinaryPrimitives.WriteUInt32BigEndian(huge.AsSpan(16), 8193);
await Reject(".png", huge, "edge limit");
BinaryPrimitives.WriteUInt32BigEndian(huge.AsSpan(16), 4096);
BinaryPrimitives.WriteUInt32BigEndian(huge.AsSpan(20), 4096);
await Reject(".png", huge, "pixel limit");
var profileBmp = bmp.ToArray();
BinaryPrimitives.WriteUInt32LittleEndian(profileBmp.AsSpan(14), 124);
await Reject(".bmp", profileBmp, "extended BMP headers not interpreted");
await Reject(".gif", B64("R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABAAgIACH5BAEKAAEALAAAAAACAAEAgQAA/wAAAAAAAAAAAAgFAAEACAgAOw=="), "multi-frame GIF");
await Reject(".png", B64("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAQAAAAAAAAAAAAEACgAA+Sm2eQAAAA9JREFUeJxj/M/AwMDAAAAGCAEBy0d2dQAAABpmY1RMAAAAAQAAAAIAAAABAAAAAAAAAAAAAQAKAABiWlytAAAAE2ZkQVQAAAACeJxjZGD4z8DAAAAECgEBAZKCvQAAAABJRU5ErkJggg=="), "animated PNG");
var scaled = await NativeRasterPreview.DecodeAsync(".png", B64("iVBORw0KGgoAAAANSUhEUgAACPwAAAAKCAIAAAClwUVxAAAAdElEQVR42u3ZMQ0AMAzAsHX8Obc4ItkQ8mb2AQAAAAAAQNuXAAAAAAAAgDrTCwAAAAAAgDzTCwAAAAAAgDzTCwAAAAAAgDzTCwAAAAAAgDzTCwAAAAAAgDzTCwAAAAAAgDzTCwAAAAAAgDzTCwAAAAAAgLwDKR0BE8f+qL0AAAAASUVORK5CYII="), default);

Check(scaled is { OriginalWidth: 2300, OriginalHeight: 10, Width: 2048, Height: 8 } && scaled.Pixels?.Length == 2048 * 8 * 4, "output size limit");
using var canceled = new CancellationTokenSource();
canceled.Cancel();
try
{
    await NativeRasterPreview.DecodeAsync(".png", png, canceled.Token);
    throw new InvalidOperationException("Canceled preview ran.");
}
catch (OperationCanceledException) when (canceled.IsCancellationRequested) { }
Console.WriteLine("Native raster Windows codec tests passed; no GUI was launched.");
