namespace Miru.Documents;

// Data only: strings may contain markup/path-looking text, but never carry
// an active HTML/XAML node, a navigable URI, filesystem access or a callback.
[Flags]
public enum TextStyle { Normal = 0, Bold = 1, Italic = 2, Strike = 4, Code = 8 }
public sealed record TextRun(string Text, TextStyle Style = TextStyle.Normal);
public abstract record DocumentBlock;
public sealed record Paragraph(IReadOnlyList<TextRun> Runs) : DocumentBlock;
public sealed record Heading(int Level, IReadOnlyList<TextRun> Runs) : DocumentBlock;
public sealed record Code(string Language, string Text, bool IsMermaid = false) : DocumentBlock;
public sealed record Quote(IReadOnlyList<DocumentBlock> Blocks) : DocumentBlock;
public sealed record Rule : DocumentBlock;
public sealed record ListItem(IReadOnlyList<DocumentBlock> Blocks, bool? Checked);
public sealed record ItemList(bool Ordered, int Start, IReadOnlyList<ListItem> Items) : DocumentBlock;
public enum ColumnAlignment { Left, Center, Right }
public sealed record TableRow(bool IsHeader, IReadOnlyList<IReadOnlyList<TextRun>> Cells);
public sealed record Table(IReadOnlyList<ColumnAlignment> Columns, IReadOnlyList<TableRow> Rows) : DocumentBlock;
public sealed record DocumentPlan(IReadOnlyList<DocumentBlock> Blocks, IReadOnlyList<string> Notices);
public sealed record MarkdownResult(DocumentPlan? Document, string? Error)
{
    public bool CanPreview => Document is not null;
}
