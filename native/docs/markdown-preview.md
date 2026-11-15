# Native Markdown preview boundary

This is a native, read-only GFM-oriented preview, not a GitHub.com renderer and not
a complete port of MIRU's TypeScript document viewer. Markdown source remains
available. Mermaid diagrams remain an outstanding migration requirement.

## Pipeline and supported subset

`Miru.Core` reads the selected ordinary file within the current scope. A worker
passes its decoded text to `Miru.Documents`, which uses **Markdig 1.6.0**, fixed in
the project and restored only from official nuget.org. The configured parser has
CommonMark headings, paragraphs, emphasis, code, lists, quotes and rules, with GFM
pipe tables, task lists, strikethrough and autolink recognition enabled. Author
text cannot enable more extensions. Each parse has its own pipeline.

Only a data-only `DocumentPlan` reaches `Miru.App`. The adapter creates known WinUI
TextBlock/Run, Grid, Border and ScrollViewer controls. Text is assigned through
text properties, never passed to XAML parsing or an HTML renderer. There is no
WebView, HTTP server, JavaScript runtime or shell invocation in this path.

- Heading levels are exposed to UI Automation. Text is selectable, not editable.
- Task state is an inert symbol and accessible label, not an editable checkbox.
- Tables retain their header, alignment and cells. They are visual native grids,
  not yet a fully semantic screen-reader table implementation.
- Code is monochrome, selectable text. Language names are labels only.
- ThemeResource styles follow Light, Dark and OS High Contrast.

## Deliberate differences and incomplete features

- All raw HTML is displayed as text, including tags GitHub might allow. Decoded
  entities remain text and are never parsed again as markup.
- Links, including autolinks, are inactive text. Markdown link destinations do
  not enter the presentation model. Relative link navigation, heading anchors,
  hover destinations and opening a browser are not implemented.
- Images display alt text only, including local images. No image URL is loaded.
  This prevents an implicit external or out-of-scope resource read.
- A `mermaid` fence displays its source plus an explicit incomplete-feature
  notice. **It does not render a diagram.** The TS renderer has not been silently
  embedded in a WebView and is not claimed as native functionality.
- GitHub alerts, footnotes, math, syntax highlighting, emoji substitution and
  repository-aware issue/commit mentions are not provided by this first subset.
- This bounded adapter has not been certified against the entire GFM conformance
  suite. Do not label it fully GitHub-compatible based on the finite fixtures.

## Resource bounds

Before parsing: at most 200,000 UTF-16 characters and 10,000 lines (LF, CR or CRLF).
The configured maximum nesting depth is 32. During conversion: at most 400 block
nodes (including list items), 4,000 inline nodes, 512 table cells and 32 table
columns. Unsupported inline structures or exceeded limits decline the entire
formatted preview with an explanation; Source stays available. No partially
formatted document is presented as complete.

Parsing runs off the UI thread and has finite input/structure bounds. These are
**not** a hard CPU/memory or preemptive execution-time sandbox. UI controls are
constructed synchronously from the bounded plan. Large-document responsiveness,
selection and display remain Windows acceptance checks.

## Verification

`dotnet run --project native/tests/Miru.Documents.Tests -c Release` is a finite,
cross-platform parser/model self-test. It covers representative GFM features,
literal hostile HTML/XAML-shaped content, encoded entities, inactive URI targets,
Mermaid source fallback, LF/CRLF limits, structures, and concurrent independent
parses. `verify_shell.py` also statically checks that the adapter does not create
an active URI, image, WebView or dynamic XAML reader.

These tests do not launch WinUI, prove absence of every possible side effect, or
constitute pixel/Narrator acceptance. Windows compilation, source/preview toggles,
repeated navigation, close while parsing, large tables/code, Light/Dark/High
Contrast and 100/150/200% DPI are separate checks.

Primary references, checked 2026-11-15:

- [GFM specification](https://github.github.com/gfm/), including GitHub's additional
  post-processing distinction.
- [Markdig 1.6.0](https://github.com/xoofx/markdig/releases/tag/1.6.0) and its
  [license](https://github.com/xoofx/markdig/blob/1.6.0/license.txt).
- [WinUI TextBlock](https://learn.microsoft.com/en-us/windows/apps/design/controls/text-block)
  and [UI Automation headings](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.automation.automationproperties.headinglevel).
