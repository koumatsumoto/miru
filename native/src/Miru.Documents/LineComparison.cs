using System.Globalization;

namespace Miru.Documents;

public enum LineKind { Unchanged, Added, Removed }
public sealed record ComparisonLine(LineKind Kind, int? BeforeNumber, int? AfterNumber, string Text)
{
    public string BeforeLabel => BeforeNumber?.ToString(CultureInfo.InvariantCulture) ?? "";
    public string AfterLabel => AfterNumber?.ToString(CultureInfo.InvariantCulture) ?? "";
    public string Marker => Kind switch { LineKind.Added => "+", LineKind.Removed => "−", _ => " " };
}
public sealed record LineComparisonResult(IReadOnlyList<ComparisonLine>? Lines, string? Notice)
{
    public bool CanCompare => Lines is not null;
}

/// <summary>Bounded line-level display data, not a Git command or edit operation.</summary>
public static class LineComparison
{
    public const int MaximumLines = 6_000;
    public const int MaximumCells = 1_000_000;
    public const int MaximumRows = 10_000;

    public static LineComparisonResult Create(string before, string after)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(after);
        if (before.Length > 2 * 1024 * 1024 || after.Length > 2 * 1024 * 1024 ||
            TooManyLines(before) || TooManyLines(after)) return Fallback();
        var a = Split(before);
        var b = Split(after);
        var prefix = 0;
        while (prefix < a.Length && prefix < b.Length && a[prefix] == b[prefix]) prefix++;
        var suffix = 0;
        while (suffix < a.Length - prefix && suffix < b.Length - prefix &&
            a[a.Length - suffix - 1] == b[b.Length - suffix - 1]) suffix++;
        var n = a.Length - prefix - suffix;
        var m = b.Length - prefix - suffix;
        if ((long)(n + 1) * (m + 1) > MaximumCells || a.Length + b.Length - prefix - suffix > MaximumRows)
            return Fallback();
        var width = m + 1;
        // Common prefix/suffix first makes the usual small edit inexpensive. The
        // remaining dynamic-programming matrix has a fixed one-million-cell cap.
        var lcs = new ushort[(n + 1) * width];
        for (var i = n - 1; i >= 0; i--)
            for (var j = m - 1; j >= 0; j--)
                lcs[i * width + j] = a[prefix + i] == b[prefix + j]
                    ? (ushort)(lcs[(i + 1) * width + j + 1] + 1)
                    : Math.Max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
        var rows = new List<ComparisonLine>();
        for (var p = 0; p < prefix; p++) rows.Add(new(LineKind.Unchanged, p + 1, p + 1, a[p]));
        var x = 0;
        var y = 0;
        while (x < n || y < m)
        {
            if (x < n && y < m && a[prefix + x] == b[prefix + y])
            {
                rows.Add(new(LineKind.Unchanged, prefix + x + 1, prefix + y + 1, a[prefix + x])); x++; y++;
            }
            else if (x < n && (y == m || lcs[(x + 1) * width + y] >= lcs[x * width + y + 1]))
            { rows.Add(new(LineKind.Removed, prefix + x + 1, null, a[prefix + x])); x++; }
            else
            { rows.Add(new(LineKind.Added, null, prefix + y + 1, b[prefix + y])); y++; }
        }
        for (var s = suffix; s > 0; s--)
            rows.Add(new(LineKind.Unchanged, a.Length - s + 1, b.Length - s + 1, a[a.Length - s]));
        var notices = new List<string>();
        if (before.Contains("\r\n") || after.Contains("\r\n"))
            notices.Add("CRLF is displayed as LF in the highlighted comparison; use Versions to inspect both full texts.");
        if (before.EndsWith('\n') != after.EndsWith('\n')) notices.Add("End-of-file newline differs.");
        return new(rows.AsReadOnly(), notices.Count == 0 ? null : string.Join(" ", notices));
    }

    private static bool TooManyLines(string value)
    {
        var lines = value.Length == 0 ? 0 : 1;
        foreach (var c in value) if (c == '\n' && ++lines > MaximumLines) return true;
        return false;
    }

    private static string[] Split(string value) => value.Length == 0 ? [] : value.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
    private static LineComparisonResult Fallback() => new(null,
        "This change exceeds the highlighted comparison budget. Both complete text sides are shown without line highlighting.");
}
