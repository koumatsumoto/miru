# Native HTML preview

Files mode previews a small static subset of local `.html` and `.htm` documents.
**Source** always retains the exact text decoded by Core, up to its normal 2 MiB
file limit. This is independent of the more complete TypeScript HTML preview.

- Headings, paragraphs, emphasis, strikethrough, plain/code text, quotes, simple
  lists and tables are presented as existing native WinUI text and controls.
- Link labels are text; image alt text is labeled but the image isn't loaded.
  CSS, destinations, event handlers, forms, scripting, embedded documents, HTML
  templates, and SVG/MathML are not rendered. There is no external browser,
  WebView, URL resolution, resource fetch or launch path. No original markup is
  passed to WinUI; decoded entities are never interpreted a second time.
- Hidden elements and unknown subtrees are omitted. This is not browser layout:
  CSS visibility, widths, typography and other styling do not apply. Merged cells
  and custom numbering decline preview instead of inventing an arrangement.

Core scopes and reads the selected file first. On the viewer's worker, a fresh
AngleSharp 1.10.5 `HtmlParser` reads the string without a loader, requester,
scripting service or CSS integration. Allowed attributes are limited at
tokenization to alt text, explicit hidden state and a few list/table semantics.
Only an inert `DocumentPlan` is passed to the shell. The package's net10.0 target
has no transitive dependencies. See [NuGet](https://www.nuget.org/packages/AngleSharp/1.10.5)
and the [fixed MIT notice](https://github.com/AngleSharp/AngleSharp/blob/v1.10.5/LICENSE).

Limits: 200,000 UTF-16 characters and 8,000 parser tokens, limited parser nesting;
then at most 32 levels, 4,000 visited DOM nodes, 400 blocks/list items, and 512
table cells (32 columns). Out-of-budget inputs and unsupported layouts retain
Source without presenting a partial formatted document as complete. This is a
finite local preview, not a hard CPU/time/OS sandbox or a browser-compatibility claim.

Run `dotnet run --project native/tests/Miru.Documents.Tests -c Release` for
headless HTML parser/model tests. WinUI launch and actual Preview/Source visual
checks are separate.
