# Diagram dependency notices

These files accompany the fixed package versions listed in `dependencies.json` and `Miru.Diagrams/packages.lock.json`.

- Mermaider and Sugiyama 0.17.0: `Mermaider-LICENSE.txt` (MIT), plus Sugiyama upstream notice.
- Svg.Skia / Svg.Model / Svg.SceneGraph / Svg.Animation / ShimSkiaSharp 5.2.3: `Svg.Skia-LICENSE.txt` (MIT).
- Svg.Custom 5.2.3: `Svg.Custom-LICENSE.txt` (MS-PL), **not MIT**.
- ExCSS 4.3.1: `ExCSS-LICENSE.txt` (MIT).
- SkiaSharp 4.148.0 / HarfBuzzSharp 14.2.0 and their native assets: `SkiaSharp-LICENSE.txt` and `SkiaSharp-THIRD-PARTY-NOTICES.txt`, extracted from the fixed Win32 NuGet package. The HarfBuzzSharp Win32 package contains byte-identical copies of these two files; they are retained once here.
- Microsoft.Extensions.ObjectPool 11.0.0: `dotnet-LICENSE.txt` and the package's `dotnet-THIRD-PARTY-NOTICES.txt`.

Source license files were read from exact release tags/commits recorded in the manifest, not silently copied from a moving default branch. Native third-party notice text is retained verbatim. The product integration must distribute this directory in full with the application. No dependency here grants permission to read arbitrary files or access the network at runtime.
