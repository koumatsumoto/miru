using System.Globalization;
using System.Text;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using AngleSharp.Html.Parser.Tokens.Struct;

namespace Miru.Documents;

public sealed record HtmlResult(DocumentPlan? Document, string? Error)
{
    public bool CanPreview => Document is not null;
}

/// <summary>In-memory HTML syntax to a bounded, inert native document plan.</summary>
public static class HtmlPreview
{
    public const int MaximumCharacters = 200_000;
    public const int MaximumTokens = 8_000;
    private const string HtmlNamespace = "http://www.w3.org/1999/xhtml";
    private const string ModeNotice = "Static HTML preview. Styles, links, scripts and embedded resources are inactive. Use Source for the original HTML.";
    private const string LimitNotice = "HTML exceeds the native preview limits. Use Source to read this file.";

    public static HtmlResult Create(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (source.Length > MaximumCharacters) return new(null, LimitNotice);
        try
        {
            var tokens = 0;
            var parser = new HtmlParser(new HtmlParserOptions
            {
                // Do not supply a browsing context, loader, requester, CSS or scripting service.
                // Filter even the parser's attributes: it never receives href, src, handlers, etc.
                IsScripting = false,
                MaximumDepth = MarkdownPreview.MaximumDepth + 4,
                ShouldEmitAttribute = static (ref StructHtmlToken _, ReadOnlyMemory<char> name) =>
                    name.Span is "alt" or "start" or "hidden" or "colspan" or "rowspan" or "reversed" or "value",
                SkipComments = true,
                SkipProcessingInstructions = true,
                SkipScriptText = true,
                SkipRawText = true,
                OnToken = (_, _) => { if (++tokens > MaximumTokens) throw new PreviewUnavailable(LimitNotice); }
            });
            using var document = parser.ParseDocument(source);
            if (document.DocumentElement?.HasAttribute("hidden") == true ||
                document.Body is not { } body || body.HasAttribute("hidden"))
                return Empty();
            var reader = new PlanReader();
            var blocks = reader.ReadBlocks(body, 0);
            return blocks.Length == 0 ? Empty() : new(new DocumentPlan(blocks, reader.Notices()), null);
        }
        catch (PreviewUnavailable error) { return new(null, error.Message); }
        catch (Exception error) when (error is HtmlParseException or InvalidOperationException or ArgumentException)
        {
            return new(null, "HTML could not be previewed. Use Source to read this file.");
        }
    }

    private static HtmlResult Empty() => new(null, "There is no supported visible HTML content. Use Source to read this file.");
    private sealed class PreviewUnavailable(string message) : Exception(message);

    private static string? VisibleTag(IElement element) =>
        element.NamespaceUri == HtmlNamespace && !element.HasAttribute("hidden") ? element.LocalName : null;

    private static bool IsContainer(string tag) => tag is "div" or "article" or "section" or "main" or
        "header" or "footer" or "nav" or "aside" or "figure" or "figcaption";

    private sealed class PlanReader
    {
        private int nodes;
        private int blocks;
        private int cells;
        private bool omitted;

        internal string[] Notices() => omitted
            ? [ModeNotice, "Some HTML content is not in the supported subset. See Source for omitted content."]
            : [ModeNotice];

        private void Visit(int depth)
        {
            if (depth > MarkdownPreview.MaximumDepth || ++nodes > MarkdownPreview.MaximumInlineNodes)
                throw new PreviewUnavailable(LimitNotice);
        }

        private void ChargeBlock()
        {
            if (++blocks > MarkdownPreview.MaximumBlocks) throw new PreviewUnavailable(LimitNotice);
        }

        internal DocumentBlock[] ReadBlocks(INode parent, int depth)
        {
            var output = new List<DocumentBlock>();
            var pending = new InlineRuns(false);
            foreach (var node in parent.ChildNodes)
            {
                Visit(depth);
                if (node is IText text) { pending.Add(text.Data, TextStyle.Normal); continue; }
                if (node is not IElement element) continue;
                var tag = VisibleTag(element);
                if (tag is null) { omitted = true; continue; }
                switch (tag)
                {
                    case "h1" or "h2" or "h3" or "h4" or "h5" or "h6":
                        Flush();
                        var heading = ReadRuns(element, depth + 1);
                        if (heading.Length != 0) Add(new Heading(tag[1] - '0', heading));
                        break;
                    case "p":
                        Flush();
                        var runs = ReadRuns(element, depth + 1);
                        if (runs.Length != 0) Add(new Paragraph(runs));
                        break;
                    case "pre":
                        Flush();
                        var code = string.Concat(ReadRuns(element, depth + 1, preserve: true).Select(run => run.Text));
                        if (code.Length != 0) Add(new Code("", code));
                        break;
                    case "blockquote":
                        Flush();
                        var quote = ReadBlocks(element, depth + 1);
                        if (quote.Length != 0) Add(new Quote(quote));
                        break;
                    case "hr": Flush(); Add(new Rule()); break;
                    case "ul" or "ol":
                        Flush();
                        var list = ReadList(element, tag == "ol", depth + 1);
                        if (list.Items.Count != 0) Add(list);
                        break;
                    case "table":
                        Flush();
                        if (ReadTable(element, depth + 1) is { } table) Add(table);
                        break;
                    default:
                        if (IsContainer(tag)) { Flush(); output.AddRange(ReadBlocks(element, depth + 1)); }
                        else ReadInline(element, tag, pending, depth, TextStyle.Normal);
                        break;
                }
            }
            Flush();
            return output.ToArray();

            void Add(DocumentBlock block) { ChargeBlock(); output.Add(block); }
            void Flush()
            {
                var runs = pending.Drain();
                if (runs.Length != 0) Add(new Paragraph(runs));
            }
        }

        private ItemList ReadList(IElement list, bool ordered, int depth)
        {
            var start = ordered && int.TryParse(list.GetAttribute("start"), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out var value) ? value : 1;
            if (ordered && list.HasAttribute("reversed"))
                throw new PreviewUnavailable("Reversed HTML lists are not supported. Use Source to read this file.");
            var items = new List<ListItem>();
            foreach (var item in list.Children)
            {
                Visit(depth);
                if (VisibleTag(item) != "li") { omitted = true; continue; }
                if (ordered && item.HasAttribute("value"))
                    throw new PreviewUnavailable("Custom HTML list item numbers are not supported. Use Source to read this file.");
                ChargeBlock();
                items.Add(new ListItem(ReadBlocks(item, depth + 1), null));
            }
            return new ItemList(ordered, start, items.ToArray());
        }

        private Table? ReadTable(IElement table, int depth)
        {
            var rows = new List<TableRow>();
            var width = 0;
            Rows(table, depth);
            return rows.Count == 0 ? null : new Table(new ColumnAlignment[width], rows.ToArray());

            void Rows(IElement section, int rowDepth)
            {
                foreach (var row in section.Children)
                {
                    Visit(rowDepth);
                    switch (VisibleTag(row))
                    {
                        case "thead" or "tbody" or "tfoot" when section == table:
                            Rows(row, rowDepth + 1);
                            break;
                        case "tr":
                            var header = true;
                            var output = new List<IReadOnlyList<TextRun>>();
                            foreach (var cell in row.Children)
                            {
                                Visit(rowDepth + 1);
                                var tag = VisibleTag(cell);
                                if (tag is not ("td" or "th")) { omitted = true; continue; }
                                if (cell.GetAttribute("colspan") is not (null or "1") ||
                                    cell.GetAttribute("rowspan") is not (null or "1"))
                                    throw new PreviewUnavailable("Merged HTML table cells are not supported. Use Source to read this file.");
                                if (++cells > MarkdownPreview.MaximumTableCells || output.Count == 32)
                                    throw new PreviewUnavailable(LimitNotice);
                                header &= tag == "th";
                                output.Add(ReadRuns(cell, rowDepth + 2));
                            }
                            if (output.Count != 0)
                            {
                                width = Math.Max(width, output.Count);
                                rows.Add(new TableRow(header, output.ToArray()));
                            }
                            break;
                        default: omitted = true; break; // Including captions and colgroups.
                    }
                }
            }
        }

        private TextRun[] ReadRuns(INode parent, int depth, bool preserve = false)
        {
            var output = new InlineRuns(preserve);
            ReadRunChildren(parent, output, depth, TextStyle.Normal);
            return output.Drain();
        }

        private void ReadRunChildren(INode parent, InlineRuns output, int depth, TextStyle style)
        {
            foreach (var node in parent.ChildNodes)
            {
                Visit(depth);
                if (node is IText text) output.Add(text.Data, style);
                else if (node is IElement element)
                {
                    if (VisibleTag(element) is { } tag) ReadInline(element, tag, output, depth, style);
                    else omitted = true;
                }
            }
        }

        private void ReadInline(IElement element, string tag, InlineRuns output, int depth, TextStyle style)
        {
            switch (tag)
            {
                case "strong" or "b": style |= TextStyle.Bold; break;
                case "em" or "i": style |= TextStyle.Italic; break;
                case "s" or "strike" or "del": style |= TextStyle.Strike; break;
                case "code" or "kbd" or "samp": style |= TextStyle.Code; break;
                case "a" or "span" or "small" or "mark" or "abbr" or "sub" or "sup" or "u" or "var": break;
                case "br": output.Break(); return;
                case "img":
                    if (element.GetAttribute("alt") is { Length: > 0 } alt) output.Add($"[image: {alt}]", style);
                    return;
                case "p" or "div":  // Blocks inside a simple table cell.
                    if (output.HasTextOnLine) output.Break();
                    ReadRunChildren(element, output, depth + 1, style);
                    if (output.HasTextOnLine) output.Break();
                    return;
                default:
                    // Drop whole subtrees, not merely tag wrappers. This includes scripts,
                    // styles, templates, embedded documents, forms and foreign namespaces.
                    omitted = true;
                    return;
            }
            ReadRunChildren(element, output, depth + 1, style);
        }
    }

    private sealed class InlineRuns(bool preserve)
    {
        private readonly List<TextRun> runs = [];
        private bool pendingSpace;
        internal bool HasTextOnLine { get; private set; }

        internal void Add(string text, TextStyle style)
        {
            if (text.Length == 0) return;
            if (!preserve)
            {
                var value = new StringBuilder(text.Length);
                foreach (var c in text)
                {
                    if (c is ' ' or '\t' or '\n' or '\r' or '\f') { pendingSpace = HasTextOnLine; continue; }
                    if (pendingSpace) { value.Append(' '); pendingSpace = false; }
                    value.Append(c);
                    HasTextOnLine = true;
                }
                if (value.Length != 0) runs.Add(new(value.ToString(), style));
            }
            else { runs.Add(new(text, style)); HasTextOnLine = text[^1] != '\n'; }
        }

        internal void Break()
        {
            pendingSpace = false;
            HasTextOnLine = false;
            runs.Add(new("\n"));
        }

        internal TextRun[] Drain()
        {
            var output = runs.ToArray();
            runs.Clear();
            pendingSpace = false;
            HasTextOnLine = false;
            return output;
        }
    }
}
