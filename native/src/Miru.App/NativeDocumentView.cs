using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Miru.Documents;
using Windows.UI.Text;
using FontWeights = Microsoft.UI.Text.FontWeights;
using Paragraph = Miru.Documents.Paragraph;

namespace Miru.App;

/// <summary>Only constructs fixed native controls. Document strings are text, never UI markup.</summary>
internal static class NativeDocumentView
{
    internal static void Render(Panel target, DocumentPlan document)
    {
        target.Children.Clear();
        foreach (var block in document.Blocks) target.Children.Add(RenderBlock(block));
    }

    private static Style Style(string key) => (Style)Application.Current.Resources[key];

    private static TextBlock Text(IReadOnlyList<TextRun> runs, bool strong = false)
    {
        var text = new TextBlock { Style = Style("MarkdownText") };
        foreach (var item in runs)
        {
            var run = new Run { Text = item.Text };
            if (strong || item.Style.HasFlag(TextStyle.Bold)) run.FontWeight = FontWeights.SemiBold;
            if (item.Style.HasFlag(TextStyle.Italic)) run.FontStyle = FontStyle.Italic;
            if (item.Style.HasFlag(TextStyle.Strike)) run.TextDecorations = TextDecorations.Strikethrough;
            if (item.Style.HasFlag(TextStyle.Code)) run.FontFamily = new FontFamily("Cascadia Mono,Consolas");
            text.Inlines.Add(run);
        }
        return text;
    }

    private static StackPanel Blocks(IReadOnlyList<DocumentBlock> blocks)
    {
        var panel = new StackPanel { Spacing = 10 };
        foreach (var block in blocks) panel.Children.Add(RenderBlock(block));
        return panel;
    }

    private static FrameworkElement RenderBlock(DocumentBlock block)
    {
        switch (block)
        {
            case Paragraph paragraph:
                return Text(paragraph.Runs);
            case Heading heading:
                var title = Text(heading.Runs, strong: true);
                title.FontSize = heading.Level switch { 1 => 32, 2 => 24, 3 => 20, 4 => 18, 5 => 16, _ => 14 };
                title.LineHeight = title.FontSize * 1.35;
                title.Margin = new Thickness(0, 8, 0, 4);
                AutomationProperties.SetHeadingLevel(title, heading.Level switch
                {
                    1 => AutomationHeadingLevel.Level1,
                    2 => AutomationHeadingLevel.Level2,
                    3 => AutomationHeadingLevel.Level3,
                    4 => AutomationHeadingLevel.Level4,
                    5 => AutomationHeadingLevel.Level5,
                    _ => AutomationHeadingLevel.Level6
                });
                if (heading.Level > 2) return title;
                return new Border { Style = Style("MarkdownHeadingBorder"), Child = title };
            case Code code:
                var codeText = new TextBlock { Style = Style("MarkdownCode"), Text = code.Text };
                AutomationProperties.SetName(codeText, code.IsMermaid ? "Mermaid source, diagram not available" : "Code block");
                var codeScroll = new ScrollViewer
                {
                    Content = codeText, MaxHeight = 480,
                    HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto
                };
                var codePanel = new StackPanel { Spacing = 8 };
                if (!string.IsNullOrEmpty(code.Language))
                    codePanel.Children.Add(new TextBlock { Style = Style("MarkdownCaption"), Text = code.IsMermaid ? "MERMAID · SOURCE ONLY" : code.Language });
                codePanel.Children.Add(codeScroll);
                return new Border { Style = Style("MarkdownSurface"), Child = codePanel };
            case Quote quote:
                return new Border { Style = Style("MarkdownQuote"), Child = Blocks(quote.Blocks) };
            case ItemList list:
                var listPanel = new StackPanel { Spacing = 8 };
                for (var i = 0; i < list.Items.Count; i++)
                {
                    var item = list.Items[i];
                    var row = new Grid { ColumnSpacing = 10 };
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    var marker = item.Checked is { } check ? check ? "☑" : "☐"
                        : list.Ordered ? ((long)list.Start + i).ToString(CultureInfo.InvariantCulture) + "." : "•";
                    var label = Text([new TextRun(marker)]);
                    label.MinWidth = 22;
                    if (item.Checked is { } value) AutomationProperties.SetName(label, value ? "Completed task" : "Incomplete task");
                    row.Children.Add(label);
                    var body = Blocks(item.Blocks);
                    Grid.SetColumn(body, 1);
                    row.Children.Add(body);
                    listPanel.Children.Add(row);
                }
                return listPanel;
            case Table table:
                var grid = new Grid();
                foreach (var _ in table.Columns) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                for (var r = 0; r < table.Rows.Count; r++)
                {
                    grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                    var row = table.Rows[r];
                    for (var c = 0; c < row.Cells.Count; c++)
                    {
                        var cell = Text(row.Cells[c], row.IsHeader);
                        cell.MinWidth = 80;
                        cell.MaxWidth = 320;
                        cell.TextAlignment = c < table.Columns.Count ? table.Columns[c] switch
                        {
                            ColumnAlignment.Center => TextAlignment.Center,
                            ColumnAlignment.Right => TextAlignment.Right,
                            _ => TextAlignment.Left
                        } : TextAlignment.Left;
                        var box = new Border { Style = Style(row.IsHeader ? "MarkdownTableHeader" : "MarkdownTableCell"), Child = cell };
                        Grid.SetRow(box, r);
                        Grid.SetColumn(box, c);
                        grid.Children.Add(box);
                    }
                }
                AutomationProperties.SetName(grid, $"Table, {table.Rows.Count} rows, {table.Columns.Count} columns");
                return new ScrollViewer { Content = grid, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
            case Rule:
                return new Border { Style = Style("MarkdownRule") };
            default:
                throw new InvalidOperationException("Unsupported document presentation block.");
        }
    }
}
