# Native Mermaid renderer milestone

`Miru.Diagrams` is connected to the WinUI Markdown view through a bounded asynchronous PNG adapter. Source appears immediately and remains available when preview is ready or unsupported. This is a C#/.NET + native graphics implementation, not a return to browser UI: no WebView, JavaScript, Node or localhost service is added.

## Deliberately small compatibility scope

The pinned independent **Mermaider 0.17.0** parser/layout engine accepts flowchart and sequence diagrams only in this milestone. It is not the Mermaid project's official renderer or a claim of GitHub/complete Mermaid parity. Other diagram types, source configuration/frontmatter, clickable links and authored styling fall back with an explanation. The source remains available in each block and the document Source tab. No source file is edited.

**Svg.Skia 5.2.3 / SkiaSharp 4.148.0** turn generated SVG into inert PNG bytes. Direct WinUI `SvgImageSource` was rejected because Direct2D's SVG subset does not render text. A successful PNG decode alone is also insufficient: initial compatibility probes displayed text/arrowheads but omitted outlines and connectors. The fixed renderer's generated `var()` / sRGB `color-mix()` expressions are now resolved into hex colors by a bounded adapter before rasterization. This is a small, fail-closed grammar for the pinned generated output, not a general CSS engine; unknown expressions refuse preview. All stylesheets are removed, and a fixed installed font is assigned.

Six finite Linux probe images (flowchart, sequence, Japanese labels, Light/Dark) were visually inspected with text, connectors and boxes after this correction. That does **not** accept Windows pixels, large diagrams, complete syntax or accessibility. The renderer selects a known installed font covering source characters; when none covers them it explains the fallback and never downloads fonts. The test records Japanese-font absence as an explicit fallback, not a rendered Japanese success.

## Safety and resource boundaries

- Public input is a source string, theme choice and cancellation token. Public output is PNG bytes/dimensions or an explanation. There is no file path, URI, command, callback or raw SVG API.
- Parser allowlist: flowchart and sequence. Mermaider's always-on SVG sanitizer is set to **Block**, with strict source styling. Input is capped at 12,000 characters / 200 parser lines, 150 elements, 600 post-layout nodes, nesting 16, 512 KiB output characters, and a cooperative two-second render deadline.
- Generated XML is parsed with DTD prohibited, no resolver and a character cap. A small element allowlist rejects images, use/foreignObject/script, filters, event attributes, namespaced attributes and href. Only bounded same-document marker references survive. CSS variables/mixes have expression/depth caps; unknown paint returns Source rather than silently dropping lines.
- Rasterization reads a memory stream with `SecureStatic`, `ExternalResources.Disabled`, no JavaScript/external JavaScript, SVG fonts, text references or navigation handler. CSS and all external resource surfaces are absent from the transformed model. There is no caller-provided base URI or resource loader.
- Declared dimensions are checked before rasterization; actual finite bounds are checked before allocating a surface. Output is at most 2,048 SVG units per side, two-times raster scale, four million pixels and 2 MiB PNG. Caps reject the entire preview, not a misleading cropped/truncated diagram.
- Call serially off the UI thread. Cancellation is propagated rather than converted to success; generation and native graphics calls are bounded/cooperative, **not** a hard process/memory sandbox or guaranteed preemptive cancellation of native code. The UI uses a latest-only serial session and invalidates navigation/theme/close results before decoding and again before publishing native controls. It generates at most four unique diagrams, with a retained PNG cap of 4 MiB and a decoded-dimension budget of eight million pixels per document. Repeated blocks reuse the decoded image. Superseded waiters are cancelled rather than accumulating render work. Native graphics memory may be released later by the OS; these are content/work bounds, not a guarantee of immediate memory reclamation.
- Fonts/native library loading are OS operations, not arbitrary Markdown resources. This is not proof that every OS syscall/provider is network-free. The private probe's optional `strace` observation was blocked by the environment before renderer execution; it was not bypassed and supplies no network-trace evidence.

## Verification and next integration

```bash
dotnet run --project native/tests/Miru.Diagrams.Tests -c Release -p:RestoreLockedMode=true
```

Finite tests cover Light/Dark PNG signatures/dimensions/nonblank output, font fallback, unsupported syntax/config/link/style, source/graph caps, cancellation, paint resolution/cycles/unknown color forms, and rejection of synthetic external image/file/entity/script/filter surfaces before rasterization. No external server is contacted by these tests. Nonblank pixel sampling is not diagram semantic or visual acceptance.

The native UI reads renderer PNG bytes through an in-memory stream with `BitmapImage.SetSourceAsync`, never through a URI or user SVG. It retains the current parsed file for theme changes without re-reading disk, preserves Preview/Source choice and scroll position, and leaves navigation responsive while diagrams are generated. Invalid image decoding shows a source fallback. Each rendered diagram has an automation label and a keyboard-accessible source expander; this is not a semantic description of every diagram relationship. High Contrast deliberately uses source-only system-colored text and responds to system changes.

The Windows publish script checks the managed/native graphics DLLs and copies the full `third_party/diagrams` notice directory, verifying each copied hash. Finite session tests cover overlapping requests, stale cancelled callbacks, navigation invalidation, close while native work is active, deduplication/count and aggregate PNG/pixel bounds.

Remaining: actual Windows WinUI PNG decode/display, repeated Preview/Source/theme/navigation/close interactions, screenshot/DPI, Narrator usability and large-document/WSL real-machine acceptance. Pure renderer or lifecycle tests are not a GUI test. Git and Core path boundaries are unchanged by this service.

## Dependencies and redistribution

Direct versions and resolved transitive hashes are retained in `packages.lock.json`; CI uses locked restore. Official NuGet is the only source, and production does not fetch dependencies. Skia/HarfBuzz add native graphics binaries, not a browser. Native library and font availability must be checked in the actual Windows package.

The dependency set is **not all MIT**: `Svg.Custom` is MS-PL. Exact package license declarations/source commits are in [`../third_party/diagrams/dependencies.json`](../third_party/diagrams/dependencies.json). Full notices are retained in that directory, including upstream Skia/HarfBuzz native third-party licenses and Sugiyama/ObjectPool notices. The publish script copies and verifies this whole notice directory alongside the application. No legal eligibility guarantee is inferred from the manifest.

Primary sources, checked 2026-11-15: [Mermaider fixed source](https://github.com/nullean/mermaider/tree/0.17.0), [Svg.Skia fixed source](https://github.com/wieslawsoltes/Svg.Skia/tree/v5.2.3), [Svg external-resource policy](https://github.com/wieslawsoltes/Svg.Skia/blob/v5.2.3/src/Svg.Custom/Svg2/SvgExternalResourcePolicy.cs), [Direct2D SVG support](https://learn.microsoft.com/en-us/windows/win32/direct2d/svg-support). These service policies and limits are MIRU choices, not upstream guarantees of complete Mermaid compatibility.
