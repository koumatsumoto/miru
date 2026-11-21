# Native still image preview

Open a PNG, JPEG, full-canvas single-frame GIF or uncompressed 24/32-bit BMP in Files. Supported
raster files display as pixels, not source or an external app. This does **not**
enable images embedded in Markdown/HTML, active SVG, animation, RAW, TIFF,
WebP, AVIF, or arbitrary installed codecs.

Core checks the selected opaque ID and file handle and reads at most 2 MiB.
The serialized preview worker passes those bytes (never the path or a URI) to a
fixed Windows codec after checking the signature. The source is limited to 8192
pixels per side and 16 million pixels; previews scale proportionally to at most
2048 pixels per side. Only single-frame pictures are admitted. A GIF must fill its declared logical
canvas from (0, 0) in both its dimensions and its frame metadata. Offset or cropped
frames and unavailable geometry are not previewed; the raw frame is not mistaken
for a composited image. Animated PNG chunks and BMP extended headers are refused.
Color management and EXIF rotation are not applied. The result is premultiplied
BGRA pixels, not document markup. Decoding uses Windows codecs and cooperative
cancellation, not a hardened OS sandbox.

The Windows CI fixture test (not a GUI test) exercises real PNG/JPEG/GIF/BMP
decodes, output pixels, size limits and rejected data. On a real Windows screen,
check transparent PNG, a JPEG, unsupported animation, switching between images
and text/Repository/HOME, refresh after file changes, DPI layout, and closing
during decode. Input files must remain unchanged.

[Explicit Windows decoder](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.bitmapdecoder.createasync) · [Bounded pixel transform](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.bitmapdecoder.getpixeldataasync)
[Windows GIF frame metadata](https://learn.microsoft.com/en-us/windows/win32/wic/-wic-native-image-format-metadata-queries#gif-metadata)
