using System.Globalization;
using Markdig;
using Markdig.Extensions.EmphasisExtras;
using Markdig.Extensions.Tables;
using Markdig.Extensions.TaskLists;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using AstTable = Markdig.Extensions.Tables.Table;
using AstTableRow = Markdig.Extensions.Tables.TableRow;

namespace Miru.Documents;

/// <summary>Bounded Markdown AST to inert native presentation data. No I/O.</summary>
public static class MarkdownPreview
{
    public const int MaximumCharacters = 200_000;
    public const int MaximumLines = 10_000;
    public const int MaximumDepth = 32;
    public const int MaximumBlocks = 400;
    public const int MaximumInlineNodes = 4_000;
    public const int MaximumTableCells = 512;

    public static MarkdownResult Create(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (source.Length > MaximumCharacters || TooManyLines(source))
            return new(null, "Markdown preview limit reached. Use Source to read this file.");
        try
        {
            // Build per parse: Markdig documents a pipeline as not thread-safe.
            var pipeline = new MarkdownPipelineBuilder { MaximumNestingDepth = MaximumDepth }
                .UsePipeTables(new PipeTableOptions { UseGfmRules = true })
                .UseTaskLists()
                .UseEmphasisExtras(EmphasisExtraOptions.Strikethrough)
                .UseAutoLinks()
                .DisableHtml()
                .Build();
            var ast = Markdown.Parse(source, pipeline);
            var reader = new PlanReader(source);
            return new(new DocumentPlan(reader.ReadBlocks(ast, 0), reader.Notices.ToArray()), null);
        }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException)
        {
            // Do not render a partial document or interpolate parser errors into UI markup.
            return new(null, "Markdown exceeds the native preview limits. Use Source to read this file.");
        }
    }

    private static bool TooManyLines(string source)
    {
        var lines = 1;
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\r')
            {
                if (i + 1 < source.Length && source[i + 1] == '\n') i++;
                lines++;
            }
            else if (source[i] == '\n') lines++;
            if (lines > MaximumLines) return true;
        }
        return false;
    }

    private sealed class PlanReader(string source)
    {
        private int blocks;
        private int inlines;
        private int cells;
        internal HashSet<string> Notices { get; } = new(StringComparer.Ordinal);

        private static void CheckDepth(int depth)
        {
            if (depth > MaximumDepth) throw new InvalidOperationException("Nesting limit.");
        }

        internal DocumentBlock[] ReadBlocks(ContainerBlock container, int depth)
        {
            CheckDepth(depth);
            var result = new List<DocumentBlock>();
            foreach (var block in container)
            {
                if (++blocks > MaximumBlocks) throw new InvalidOperationException("Block limit.");
                switch (block)
                {
                    case HeadingBlock heading:
                        result.Add(new Heading(heading.Level, ReadRuns(heading.Inline, depth + 1)));
                        break;
                    case ParagraphBlock paragraph:
                        result.Add(new Paragraph(ReadRuns(paragraph.Inline, depth + 1)));
                        break;
                    case FencedCodeBlock fence:
                        var language = (fence.Info ?? "").Trim();
                        if (language.Length > 64) language = language[..64];
                        var isMermaid = language.Equals("mermaid", StringComparison.OrdinalIgnoreCase);
                        if (isMermaid) Notices.Add("Mermaid is not rendered in the native preview yet. Its source is shown.");
                        result.Add(new Code(language, fence.Lines.ToString(), isMermaid));
                        break;
                    case CodeBlock code:
                        result.Add(new Code("", code.Lines.ToString()));
                        break;
                    case QuoteBlock quote:
                        result.Add(new Quote(ReadBlocks(quote, depth + 1)));
                        break;
                    case ListBlock list:
                        var start = int.TryParse(list.OrderedStart, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : 1;
                        var items = new List<ListItem>();
                        foreach (var child in list)
                        {
                            if (child is not ListItemBlock item) continue;
                            if (++blocks > MaximumBlocks) throw new InvalidOperationException("List limit.");
                            var task = item.OfType<ParagraphBlock>().FirstOrDefault()?.Inline?.FirstChild as TaskList;
                            items.Add(new ListItem(ReadBlocks(item, depth + 1), task?.Checked));
                        }
                        result.Add(new ItemList(list.IsOrdered, start, items.ToArray()));
                        break;
                    case AstTable table:
                        result.Add(ReadTable(table, depth + 1));
                        break;
                    case ThematicBreakBlock:
                        result.Add(new Rule());
                        break;
                    case LinkReferenceDefinitionGroup:
                        break;
                    default:
                        // Preserve unsupported text, but never pass active markup through.
                        var from = Math.Clamp(block.Span.Start, 0, source.Length);
                        var length = Math.Clamp(block.Span.End + 1 - from, 0, source.Length - from);
                        result.Add(new Code("", source.Substring(from, length)));
                        Notices.Add("Some Markdown syntax is shown as source rather than formatted content.");
                        break;
                }
            }
            return result.ToArray();
        }

        private Table ReadTable(AstTable table, int depth)
        {
            CheckDepth(depth);
            var columns = table.ColumnDefinitions.Select(c => c.Alignment switch
            {
                TableColumnAlign.Center => ColumnAlignment.Center,
                TableColumnAlign.Right => ColumnAlignment.Right,
                _ => ColumnAlignment.Left
            }).ToArray();
            if (columns.Length > 32) throw new InvalidOperationException("Table column limit.");
            var rows = new List<TableRow>();
            foreach (var row in table.OfType<AstTableRow>())
            {
                var output = new List<IReadOnlyList<TextRun>>();
                foreach (var cell in row.OfType<TableCell>())
                {
                    if (++cells > MaximumTableCells) throw new InvalidOperationException("Table cell limit.");
                    var runs = new List<TextRun>();
                    foreach (var child in cell)
                    {
                        if (child is not LeafBlock leaf) throw new InvalidOperationException("Unsupported table cell.");
                        if (runs.Count != 0) runs.Add(new TextRun("\n"));
                        runs.AddRange(ReadRuns(leaf.Inline, depth + 1));
                    }
                    output.Add(runs.ToArray());
                }
                rows.Add(new TableRow(row.IsHeader, output.ToArray()));
            }
            return new Table(columns, rows.ToArray());
        }

        private TextRun[] ReadRuns(ContainerInline? parent, int depth, TextStyle style = TextStyle.Normal)
        {
            CheckDepth(depth);
            var result = new List<TextRun>();
            for (var inline = parent?.FirstChild; inline is not null; inline = inline.NextSibling)
            {
                if (++inlines > MaximumInlineNodes) throw new InvalidOperationException("Inline limit.");
                switch (inline)
                {
                    case LiteralInline literal:
                        result.Add(new TextRun(literal.Content.ToString(), style));
                        break;
                    case CodeInline code:
                        result.Add(new TextRun(code.Content, style | TextStyle.Code));
                        break;
                    case HtmlEntityInline entity:
                        // Decoded characters stay text. They are never reparsed as markup.
                        result.Add(new TextRun(entity.Transcoded.ToString(), style));
                        break;
                    case LineBreakInline line:
                        result.Add(new TextRun(line.IsHard ? "\n" : " ", style));
                        break;
                    case EmphasisInline emphasis:
                        var extra = emphasis.DelimiterChar == '~' ? TextStyle.Strike
                            : emphasis.DelimiterCount >= 2 ? TextStyle.Bold : TextStyle.Italic;
                        result.AddRange(ReadRuns(emphasis, depth + 1, style | extra));
                        break;
                    case LinkInline link:
                        if (link.IsImage)
                        {
                            result.Add(new TextRun("[image: ", style));
                            result.AddRange(ReadRuns(link, depth + 1, style));
                            result.Add(new TextRun("]", style));
                            Notices.Add("Images are represented by their alt text. No image URLs are loaded.");
                        }
                        else
                        {
                            result.AddRange(ReadRuns(link, depth + 1, style));
                            Notices.Add("Links are displayed as text and are not opened.");
                        }
                        break;
                    case AutolinkInline link:
                        result.Add(new TextRun(link.Url, style));
                        Notices.Add("Links are displayed as text and are not opened.");
                        break;
                    case TaskList:
                        break; // The list item's inert Checked property carries this state.
                    case ContainerInline nested:
                        result.AddRange(ReadRuns(nested, depth + 1, style));
                        break;
                    default:
                        throw new InvalidOperationException("Unsupported inline syntax.");
                }
            }
            return result.ToArray();
        }
    }
}
