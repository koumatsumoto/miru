using Miru.Documents;

var cases = new List<(string Name, Action Run)>();
void Test(string name, Action action) => cases.Add((name, action));
void Check(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
DocumentPlan Parse(string source) => MarkdownPreview.Create(source).Document ?? throw new Exception("Expected preview");
string Text(IEnumerable<TextRun> runs) => string.Concat(runs.Select(x => x.Text));

Test("headings and nested emphasis", () =>
{
    var plan = Parse("# Read **bold and *italic***\n\nHello 日本語");
    var heading = (Heading)plan.Blocks[0];
    Check(heading.Level == 1 && Text(heading.Runs) == "Read bold and italic");
    Check(heading.Runs.Any(x => x.Style.HasFlag(TextStyle.Bold) && x.Style.HasFlag(TextStyle.Italic)));
    Check(Text(((Paragraph)plan.Blocks[1]).Runs) == "Hello 日本語");
});
Test("GFM strike, code and escapes", () =>
{
    var p = (Paragraph)Parse("~~old~~ `x < y` &amp; \\*literal\\*").Blocks[0];
    Check(p.Runs.Any(x => x.Text == "old" && x.Style.HasFlag(TextStyle.Strike)));
    Check(p.Runs.Any(x => x.Text == "x < y" && x.Style.HasFlag(TextStyle.Code)));
    Check(Text(p.Runs).Contains("& *literal*"));
});
Test("GFM task lists are inert state", () =>
{
    var list = (ItemList)Parse("- [x] done\n- [ ] next\n- plain").Blocks[0];
    Check(!list.Ordered && list.Items.Count == 3);
    Check(list.Items[0].Checked == true && list.Items[1].Checked == false && list.Items[2].Checked is null);
});
Test("ordered list preserves start and nested quote", () =>
{
    var list = (ItemList)Parse("3. third\n4. fourth\n\n> quote").Blocks[0];
    Check(list.Ordered && list.Start == 3);
    Check(Parse("> quote").Blocks[0] is Quote);
});
Test("GFM table heading, escaped pipe and alignment", () =>
{
    var table = (Table)Parse("| A | B |\n| :- | -: |\n| a\\|b | **bold** |").Blocks[0];
    Check(table.Columns.SequenceEqual([ColumnAlignment.Left, ColumnAlignment.Right]));
    Check(table.Rows.Count == 2 && table.Rows[0].IsHeader && !table.Rows[1].IsHeader);
    Check(Text(table.Rows[1].Cells[0]) == "a|b");
    Check(table.Rows[1].Cells[1].Any(x => x.Style.HasFlag(TextStyle.Bold)));
});
Test("fenced code and Mermaid remain source, never execute", () =>
{
    var plan = Parse("```csharp\nConsole.WriteLine(1);\n```\n\n```mermaid\nflowchart TD\n A-->B\n```");
    Check(plan.Blocks[0] is Code { Language: "csharp", IsMermaid: false });
    Check(plan.Blocks[1] is Code { IsMermaid: true });
    Check(plan.Notices.Any(x => x.Contains("Mermaid")));
});
Test("hostile HTML is literal text, never active markup", () =>
{
    var plan = Parse("<script>fetch('https://evil.test')</script>\n\n<iframe src='file:///secret'></iframe>");
    Check(plan.Blocks.All(x => x is Paragraph));
    Check(Text(((Paragraph)plan.Blocks[0]).Runs).Contains("<script>"));
});
Test("links and image targets are not carried as capabilities", () =>
{
    var plan = Parse("[click](javascript:alert(1)) ![secret](file:///C:/secret) ![net](https://evil.test/x.png)");
    var text = Text(((Paragraph)plan.Blocks[0]).Runs);
    Check(text.Contains("click") && text.Contains("[image: secret]") && text.Contains("[image: net]"));
    Check(!text.Contains("javascript:") && !text.Contains("file://") && !text.Contains("https://"));
    Check(plan.Notices.Count == 2);
});
Test("empty document, rules, code block", () =>
{
    Check(Parse("").Blocks.Count == 0);
    Check(Parse("---").Blocks[0] is Rule);
    Check(Parse("    code").Blocks[0] is Code);
});
Test("source length and line budgets reject without partial render", () =>
{
    Check(!MarkdownPreview.Create(new string('x', MarkdownPreview.MaximumCharacters + 1)).CanPreview);
    Check(!MarkdownPreview.Create(new string('\n', MarkdownPreview.MaximumLines)).CanPreview);
    Check(!MarkdownPreview.Create(new string('\r', MarkdownPreview.MaximumLines)).CanPreview);
    Check(MarkdownPreview.Create(string.Concat(Enumerable.Repeat("\r\n", MarkdownPreview.MaximumLines - 1))).CanPreview);
});
Test("entities become text rather than second-pass markup", () =>
{
    var text = Text(((Paragraph)Parse("&lt;Image Source='https://evil.test' /&gt; &#x1f600;").Blocks[0]).Runs);
    Check(text == "<Image Source='https://evil.test' /> 😀");
});
Test("reference links retain labels only and definitions disappear", () =>
{
    var plan = Parse("[safe][target]\n\n[target]: https://evil.test/secret \"title\"");
    Check(plan.Blocks.Count == 1 && Text(((Paragraph)plan.Blocks[0]).Runs) == "safe");
});
Test("autolinks remain selectable plain text", () =>
{
    var plan = Parse("<https://example.test/x> https://example.test/y user@example.test");
    var text = Text(((Paragraph)plan.Blocks[0]).Runs);
    Check(text.Contains("https://example.test/x") && text.Contains("user@example.test"));
    Check(plan.Notices.Any(x => x.Contains("not opened")));
});
Test("hard breaks and soft breaks are distinguished", () =>
{
    Check(Text(((Paragraph)Parse("one\ntwo  \nthree\\\nfour").Blocks[0]).Runs) == "one two\nthree\nfour");
});
Test("nested lists and task state preserve surrounding text", () =>
{
    var list = (ItemList)Parse("- [x] parent\n  - child\n  - [ ] next").Blocks[0];
    Check(list.Items[0].Checked == true);
    var child = (ItemList)list.Items[0].Blocks[1];
    Check(child.Items.Count == 2 && child.Items[1].Checked == false);
});
Test("unsupported GitHub additions do not become active content", () =>
{
    var plan = Parse("> [!NOTE]\n> ordinary quote\n\n$$math$$\n\n<!-- markdig:extensions=advanced -->");
    Check(plan.Blocks[0] is Quote);
    Check(Text(((Paragraph)plan.Blocks[^1]).Runs).Contains("markdig:extensions"));
});
Test("empty table cells and surplus cells stay bounded", () =>
{
    var table = (Table)Parse("a|b\n-|-\nx\nx|y|ignored").Blocks[0];
    Check(table.Rows.Count == 3 && table.Rows.All(x => x.Cells.Count == 2));
});
Test("block and inline budgets reject without partial render", () =>
{
    Check(!MarkdownPreview.Create(string.Concat(Enumerable.Repeat("p\n\n", MarkdownPreview.MaximumBlocks + 1))).CanPreview);
    Check(!MarkdownPreview.Create(string.Concat(Enumerable.Repeat("*x* ", MarkdownPreview.MaximumInlineNodes))).CanPreview);
});
Test("table cells are bounded", () =>
{
    var text = "a|b\n-|-\n" + string.Concat(Enumerable.Repeat("x|y\n", 300));
    Check(!MarkdownPreview.Create(text).CanPreview);
});
Test("nesting is bounded", () =>
{
    Check(!MarkdownPreview.Create(string.Concat(Enumerable.Repeat("> ", 100)) + "deep").CanPreview);
});
Test("source plan carries no path, URI, or callback types", () =>
{
    var assembly = typeof(DocumentPlan).Assembly;
    Check(!assembly.GetExportedTypes().SelectMany(x => x.GetProperties()).Any(x => x.PropertyType == typeof(Uri) || typeof(Delegate).IsAssignableFrom(x.PropertyType)));
});
Test("repeat and parallel parses have independent configuration", () =>
{
    Parallel.For(0, 20, i =>
    {
        var plan = Parse($"# pass {i}\n\n<script>no execute</script>");
        Check(plan.Blocks.Count == 2 && plan.Blocks[1] is Paragraph);
    });
});

cases.AddRange(ComparisonCases.All());
var failed = 0;
foreach (var test in cases)
{
    try { test.Run(); Console.WriteLine("PASS " + test.Name); }
    catch (Exception error) { failed++; Console.Error.WriteLine("FAIL " + test.Name + ": " + error); }
}
Console.WriteLine($"{cases.Count - failed}/{cases.Count} passed. Pure parser/model only, not WinUI rendering or Mermaid support.");
return failed == 0 ? 0 : 1;
