using System.Xml.Linq;
using Miru.Diagrams;
using SkiaSharp;

var tests = 0; var assertions = 0; var fontFallbacks = 0;
void Check(bool value, string name) { assertions++; if (!value) throw new Exception(name); }
async Task Test(string name, Func<Task> body) { await body(); tests++; Console.WriteLine("PASS " + name); }
void RejectSvg(string body)
{
    try { _ = GeneratedSvg.Resolve(body, "DejaVu Sans"); throw new Exception("Unsafe generated SVG accepted"); }
    catch (Exception e) when (e is InvalidDataException or System.Xml.XmlException or FormatException) { assertions++; }
}
string Wrap(string body, string extra = "") => $"<svg xmlns='http://www.w3.org/2000/svg' width='100' height='50' {extra}>{body}</svg>";

await Test("light/dark flow and sequence produce bounded inert PNG", async () =>
{
    foreach (var source in new[] { "flowchart LR\n A[Start] --> B{Ready}\n B -->|yes| C[End]", "sequenceDiagram\n participant A as User\n participant B as MIRU\n A->>B: Open file\n B-->>A: Read only" })
    foreach (var dark in new[] { false, true })
    {
        var result = await MermaidDiagram.RenderAsync(source, dark);
        Check(result.CanPreview, result.Error ?? "missing PNG");
        Check(result.Png!.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }), "PNG signature");
        using var bitmap = SKBitmap.Decode(result.Png);
        Check(bitmap.Width == result.Width && bitmap.Height == result.Height, "dimension contract");
        Check((long)result.Width * result.Height <= MermaidDiagram.MaximumPixels, "pixel cap");
        var background = bitmap.GetPixel(0, 0);
        var samples = new HashSet<SKColor>();
        for (var y = 0; y < bitmap.Height; y += 3)
            for (var x = 0; x < bitmap.Width; x += 3) samples.Add(bitmap.GetPixel(x, y));
        Check(samples.Count > 16 && samples.Any(c => c != background), "nonblank bitmap (not visual acceptance)");
        Check(dark ? background.Red < 30 : background.Red > 240, "theme background");
    }
});
await Test("Japanese either renders with a covering installed font or explains fallback", async () =>
{
    var result = await MermaidDiagram.RenderAsync("flowchart LR\n A[開始] --> B[日本語の表示]", false);
    if (!result.CanPreview)
    {
        Check(result.Error!.Contains("No installed font"), result.Error);
        fontFallbacks++; Console.WriteLine("FONT FALLBACK Japanese font unavailable; no download attempted");
    }
    else Check(result.Png!.Length > 1000, "Japanese PNG produced, glyph/geometry acceptance is separate");
});
await Test("unsupported diagram, syntax and source configuration fail to source", async () =>
{
    foreach (var source in new[] {
        "pie\n\"A\": 20", "not-a-diagram", "%%{init: {'theme':'dark'}}%%\nflowchart LR\nA-->B",
        "flowchart LR\nA-->B\nclick A \"https://invalid.test\"", "flowchart LR\nA-->B\nstyle A fill:red",
        "---\nconfig:\n---\nflowchart LR\nA-->B" })
    {
        var result = await MermaidDiagram.RenderAsync(source, false);
        Check(!result.CanPreview && result.Error is not null, "unsupported source was not explained");
    }
});
await Test("source and graph budgets reject rather than truncate", async () =>
{
    foreach (var source in new[] { new string('x', MermaidDiagram.MaximumSourceCharacters + 1),
        "flowchart LR\n" + string.Join('\n', Enumerable.Range(0, 180).Select(i => $"A{i} --> A{i + 1}")) })
        Check(!(await MermaidDiagram.RenderAsync(source, false)).CanPreview, "budget failed");
});
await Test("cancelled request does not become success or fallback", async () =>
{
    using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
    try { await MermaidDiagram.RenderAsync("flowchart LR\nA-->B", false, cancellation.Token); throw new Exception("cancel ignored"); }
    catch (OperationCanceledException) { assertions++; }
});
await Test("generated paint resolves nested theme colors and strips all CSS", () =>
{
    var input = Wrap("<style>svg { --_line: color-mix(in srgb, var(--fg) 50%, var(--bg)); }</style><line x1='0' y1='0' x2='50' y2='40' stroke='var(--_line)'/><text font-size='var(--size)' fill='var(--fg)'>Text</text>",
        "style='--fg:#000000;--bg:#ffffff;--size:14px;'");
    var result = GeneratedSvg.Resolve(input, "DejaVu Sans");
    Check(result.Contains("#808080"), "line paint materialized");
    Check(!result.Contains("var(") && !result.Contains("color-mix(") && !result.Contains("<style") && !result.Contains("style="), "CSS removed");
    Check(result.Contains("font-family=\"DejaVu Sans\""), "trusted font set");
    return Task.CompletedTask;
});
await Test("active, network, local-file and entity SVG inputs fail before rasterization", () =>
{
    foreach (var source in new[] {
        Wrap("<script>alert(1)</script>"), Wrap("<foreignObject/>"), Wrap("<image href='https://invalid.test/a.png'/>"),
        Wrap("<use href='file:///outside.svg'/>"), Wrap("<text onload='x'>X</text>"),
        Wrap("<path stroke='url(https://invalid.test/p)'/>"), Wrap("<line filter='url(#f)'/>"),
        Wrap("<text style='background:url(file:///outside)'>X</text>"),
        "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///outside'>]>" + Wrap("<text>&x;</text>"),
        "<svg xmlns='http://www.w3.org/2000/svg' width='Infinity' height='20'/>",
        "<svg xmlns='http://www.w3.org/2000/svg' width='2049' height='20'/>" }) RejectSvg(source);
    return Task.CompletedTask;
});
await Test("unknown, cyclic, overly deep or non-sRGB paint refuses preview", () =>
{
    foreach (var source in new[] {
        Wrap("<path stroke='var(--missing)'/>"),
        Wrap("<path stroke='var(--x)'/>", "style='--x:var(--x);'"),
        Wrap("<path stroke='color-mix(in oklab, #000000 50%, #ffffff)'/>"),
        Wrap("<path stroke='color-mix(in srgb, #000000 200%, #ffffff)'/>"),
        Wrap(string.Concat(Enumerable.Repeat("<g/>", 3001))) }) RejectSvg(source);
    return Task.CompletedTask;
});
tests += await SessionCases.Run(Check);
Console.WriteLine($"PASS {tests} finite scenarios / {assertions} assertions / {fontFallbacks} explicit font fallbacks. Pure renderer only; no WinUI/WSL/Git or full Mermaid compatibility acceptance.");
