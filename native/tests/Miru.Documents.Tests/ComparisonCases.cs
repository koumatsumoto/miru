using Miru.Documents;

internal static class ComparisonCases
{
    internal static IEnumerable<(string Name, Action Run)> All()
    {
        yield return ("line comparison preserves both sides", () =>
        {
            foreach (var (before, after) in new[]
            {
                ("", ""), ("", "added\n"), ("removed\n", ""), ("same\n", "same\n"),
                ("a\nb\nc\n", "a\nB\nc\n"), ("start\nlast", "new\nstart\nlast\nend"),
                ("one\ntwo\none\n", "two\none\ntwo\n"), ("no newline", "no newline\n")
            })
            {
                var result = LineComparison.Create(before, after);
                Check(result.Lines is not null);
                Check(string.Join('\n', result.Lines!.Where(r => r.Kind != LineKind.Added).Select(r => r.Text)) == before);
                Check(string.Join('\n', result.Lines!.Where(r => r.Kind != LineKind.Removed).Select(r => r.Text)) == after);
                Check(result.Lines!.Where(r => r.BeforeNumber is not null).Select(r => r.BeforeNumber!.Value)
                    .SequenceEqual(Enumerable.Range(1, before.Length == 0 ? 0 : before.Count(c => c == '\n') + 1)));
            }
        });
        yield return ("line comparison has explicit markers and line numbers", () =>
        {
            var rows = LineComparison.Create("old", "new").Lines!;
            Check(rows.Count == 2 && rows[0].Marker == "−" && rows[1].Marker == "+");
            Check(rows[0].BeforeLabel == "1" && rows[0].AfterLabel == "" && rows[1].AfterLabel == "1");
        });
        yield return ("line endings and final newline differences are explained", () =>
        {
            var crlf = LineComparison.Create("a\r\n", "a\n");
            Check(crlf.Lines!.All(r => r.Kind == LineKind.Unchanged) && crlf.Notice!.Contains("CRLF"));
            Check(LineComparison.Create("a", "a\n").Notice!.Contains("End-of-file"));
        });
        yield return ("large common context is trimmed before matrix allocation", () =>
        {
            var head = string.Concat(Enumerable.Repeat("context\n", 2_000));
            var tail = string.Concat(Enumerable.Repeat("tail\n", 2_000));
            var diff = LineComparison.Create(head + "before\n" + tail, head + "after\n" + tail);
            Check(diff.CanCompare && diff.Lines!.Count(r => r.Kind != LineKind.Unchanged) == 2);
        });
        yield return ("adversarial matrix and line budgets fall back, not truncate", () =>
        {
            Check(!LineComparison.Create(new string('\n', LineComparison.MaximumLines), "").CanCompare);
            Check(!LineComparison.Create(string.Concat(Enumerable.Repeat("a\n", 1_001)),
                string.Concat(Enumerable.Repeat("b\n", 1_001))).CanCompare);
            Check(!LineComparison.Create(new string('x', 2 * 1024 * 1024 + 1), "").CanCompare);
        });
        yield return ("HTML and URI-shaped diff rows remain ordinary strings", () =>
        {
            var text = "<Image Source='https://evil.test'/>";
            Check(LineComparison.Create("", text).Lines!.Single().Text == text);
        });
    }

    private static void Check(bool value) { if (!value) throw new Exception("Line comparison assertion failed."); }
}
