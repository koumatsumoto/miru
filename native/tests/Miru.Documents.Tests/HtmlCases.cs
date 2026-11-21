using System.Text.Json;
using Miru.Documents;

internal static class HtmlCases
{
    internal static IEnumerable<(string Name, Action Run)> All()
    {
        yield return ("HTML document and fragment become semantic text", () =>
        {
            var plan = Preview("<!doctype html><html><head><title>Not body</title></head><body>" +
                "<main><h2>日本語 &amp; &#128512;</h2><p>Intro <strong>bold and <em>italic</em></strong> " +
                "<s>removed</s><br>line &lt;b&gt; &nbsp; next</p></main></body></html>");
            Check(plan.Blocks is [Heading { Level: 2 }, Paragraph]);
            var heading = (Heading)plan.Blocks[0];
            var prose = (Paragraph)plan.Blocks[1];
            Check(Text(heading.Runs) == "日本語 & 😀");
            Check(Text(prose.Runs) == "Intro bold and italic removed\nline <b> \u00a0 next");
            Check(prose.Runs.Any(run => run.Text.Contains("italic") &&
                run.Style.HasFlag(TextStyle.Bold | TextStyle.Italic)));
            Check(prose.Runs.Any(run => run.Text.Contains("removed") && run.Style == TextStyle.Strike));
            Check(Text(((Paragraph)Preview("visible <code>local</code>").Blocks.Single()).Runs) == "visible local");
        });
        yield return ("HTML lists, quote, rules and whitespace-sensitive code", () =>
        {
            var plan = Preview("<ol start='3'><li>third<li>fourth<ul><li>nested</li></ul></ol>" +
                "<blockquote><p>quote</p></blockquote><pre><code>a &lt; b\n  c</code></pre><hr>");
            var list = (ItemList)plan.Blocks[0];
            Check(list.Ordered && list.Start == 3 && list.Items.Count == 2 && list.Items.All(item => item.Checked is null));
            Check(list.Items[1].Blocks[1] is ItemList);
            Check(plan.Blocks[1] is Quote && plan.Blocks[3] is Rule);
            Check(plan.Blocks[2] is Code { Text: "a < b\n  c", IsMermaid: false });
        });
        yield return ("HTML simple table preserves headers and cells", () =>
        {
            var table = (Table)Preview("<table><thead><tr><th>Name<th>Value</thead>" +
                "<tr><td>頂点<td><em>3</em></table>").Blocks.Single();
            Check(table.Columns.Count == 2 && table.Rows.Count == 2);
            Check(table.Rows[0].IsHeader && !table.Rows[1].IsHeader);
            Check(Text(table.Rows[1].Cells[0]) == "頂点" && table.Rows[1].Cells[1].Single() is { Text: "3", Style: TextStyle.Italic });
        });
        yield return ("HTML links, media, embedded or hidden content are inactive and never projected as destinations", () =>
        {
            var plan = Preview("""
                <head><base href="https://example.invalid/base"><meta http-equiv="refresh" content="0; url=elsewhere">
                <link href="https://example.invalid/style.css" rel="stylesheet"></head>
                <main><p><a href="https://example.invalid/link" onclick="unused()">link label</a>
                <img src="file:///not-read.png" srcset="https://example.invalid/a" alt="image alt">
                &lt;Image Source="plain text" /&gt;</p>
                <script>unrendered-script</script><style>unrendered-css</style>
                <iframe src="https://example.invalid/frame">unrendered-frame</iframe>
                <form action="/not-submitted"><label>unrendered-form</label></form>
                <svg><text>unrendered-svg</text></svg><math><mi>unrendered-math</mi></math>
                <template shadowrootmode="open"><p>unrendered-template</p></template>
                <details><summary>unrendered-details</summary></details><p hidden>unrendered-hidden</p></main>
                """);
            Check(plan.Blocks.Count == 1 && Text(((Paragraph)plan.Blocks[0]).Runs) ==
                "link label [image: image alt] <Image Source=\"plain text\" />");
            var data = JsonSerializer.Serialize(plan.Blocks.Cast<object>());
            Check(!data.Contains("example.invalid") && !data.Contains("unrendered-") && !data.Contains("not-read.png"));
            Check(plan.Notices.Any(notice => notice.Contains("inactive")));
        });
        yield return ("HTML unsupported and empty content reads as source only", () =>
        {
            foreach (var input in new[] { "", "<script>text</script>", "<body hidden><p>text</p>", "<html hidden><body><p>text</p></body></html>", "<table><tr><td colspan='2'>merged", "<ol reversed><li>item</li></ol>" })
            {
                var result = HtmlPreview.Create(input);
                Check(!result.CanPreview && result.Error?.Contains("Source", StringComparison.Ordinal) == true);
            }
        });
        yield return ("HTML input, parser, nesting, block and table limits decline the entire preview", () =>
        {
            foreach (var input in new[]
            {
                new string('x', HtmlPreview.MaximumCharacters + 1),
                string.Concat(Enumerable.Repeat("<meta>", HtmlPreview.MaximumTokens + 1)) + "<p>must not render",
                string.Concat(Enumerable.Repeat("<div>", MarkdownPreview.MaximumDepth + 8)) + "<p>too deep",
                string.Concat(Enumerable.Repeat("<p>p</p>", MarkdownPreview.MaximumBlocks + 1)),
                "<table>" + string.Concat(Enumerable.Repeat("<tr><td>a<td>b</tr>", MarkdownPreview.MaximumTableCells / 2 + 1))
            })
            {
                var result = HtmlPreview.Create(input);
                Check(!result.CanPreview && result.Error?.Contains("Source", StringComparison.Ordinal) == true);
            }
        });
        yield return ("HTML repeated parses neither share state nor project HTML as Mermaid", () =>
        {
            Parallel.For(0, 16, i =>
            {
                var plan = Preview($"<h1>{i}</h1><pre class='mermaid'>flowchart LR</pre>");
                Check(Text(((Heading)plan.Blocks[0]).Runs) == i.ToString(System.Globalization.CultureInfo.InvariantCulture));
                Check(plan.Blocks[1] is Code { IsMermaid: false });
            });
        });
    }

    private static DocumentPlan Preview(string html) => HtmlPreview.Create(html).Document ??
        throw new InvalidOperationException("Expected a static HTML preview.");
    private static string Text(IEnumerable<TextRun> runs) => string.Concat(runs.Select(run => run.Text));
    private static void Check(bool condition)
    {
        if (!condition) throw new InvalidOperationException("HTML assertion failed.");
    }
}
