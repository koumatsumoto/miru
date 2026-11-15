using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Miru.Diagrams;

// Only the fixed Mermaider output is accepted, never a user-supplied SVG file.
// Resolves its tiny paint grammar, not general CSS. Unknown values fail closed.
internal static class GeneratedSvg
{
    private static readonly Regex Declaration = new(@"(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex Hex = new(@"^#[a-fA-F0-9]{6}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex Pixels = new(@"^[0-9]+(?:\.[0-9]+)?px$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    internal static string Resolve(string generatedSvg, string font)
    {
        if (generatedSvg.Length > 512 * 1024) throw new InvalidDataException("SVG budget");
        using var input = XmlReader.Create(new StringReader(generatedSvg), new XmlReaderSettings
        { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 512 * 1024 });
        var document = XDocument.Load(input);
        var root = document.Root ?? throw new InvalidDataException("No root");
        if (root.Name != XName.Get("svg", "http://www.w3.org/2000/svg")) throw new InvalidDataException("Unexpected SVG root");
        var all = root.DescendantsAndSelf().ToArray();
        if (all.Length > 3_000) throw new InvalidDataException("SVG element budget");
        Validate(all);
        var width = double.Parse((string?)root.Attribute("width") ?? "0", CultureInfo.InvariantCulture);
        var height = double.Parse((string?)root.Attribute("height") ?? "0", CultureInfo.InvariantCulture);
        if (!double.IsFinite(width) || !double.IsFinite(height) || width <= 0 || height <= 0 || width > 2048 || height > 2048)
            throw new InvalidDataException("Diagram dimensions exceed the preview budget.");
        var variables = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var style in all.Where(e => e.Name.LocalName == "style")) Add(style.Value);
        Add((string?)root.Attribute("style") + ";"); // caller's explicit theme wins
        foreach (var item in all)
        {
            foreach (var attribute in item.Attributes().ToArray())
            {
                if (attribute.Name.LocalName is "fill" or "stroke" or "stop-color" or "font-size")
                {
                    var value = attribute.Value;
                    if (value.Contains("var(", StringComparison.Ordinal) || value.Contains("color-mix(", StringComparison.Ordinal))
                        attribute.Value = Evaluate(value, 0);
                }
            }
            if (item.Name.LocalName is "text" or "tspan") item.SetAttributeValue("font-family", font);
        }
        foreach (var style in all.Where(e => e.Name.LocalName == "style")) style.Remove();
        root.Attribute("style")?.Remove();
        return document.ToString(SaveOptions.DisableFormatting);

        void Add(string text)
        {
            foreach (Match match in Declaration.Matches(text)) variables[match.Groups[1].Value] = match.Groups[2].Value.Trim();
        }
        string Evaluate(string expression, int depth)
        {
            if (depth > 16 || expression.Length > 1024) throw new InvalidDataException("Paint expression budget");
            expression = expression.Trim();
            if (Hex.IsMatch(expression) || Pixels.IsMatch(expression)) return expression;
            if (expression.StartsWith("var(", StringComparison.Ordinal) && expression.EndsWith(')'))
            {
                var parts = Split(expression[4..^1]);
                if (parts.Count is < 1 or > 2) throw new InvalidDataException("Unexpected variable expression");
                if (variables.TryGetValue(parts[0], out var value)) return Evaluate(value, depth + 1);
                if (parts.Count == 2) return Evaluate(parts[1], depth + 1);
                throw new InvalidDataException("Missing paint variable");
            }
            if (expression.StartsWith("color-mix(", StringComparison.Ordinal) && expression.EndsWith(')'))
            {
                var parts = Split(expression[10..^1]);
                if (parts.Count != 3 || parts[0] != "in srgb") throw new InvalidDataException("Unsupported mix");
                var separator = parts[1].LastIndexOf(' ');
                if (separator < 0 || !parts[1].EndsWith('%')) throw new InvalidDataException("Unsupported weight");
                var weight = double.Parse(parts[1][(separator + 1)..^1], CultureInfo.InvariantCulture) / 100;
                if (!double.IsFinite(weight) || weight is < 0 or > 1) throw new InvalidDataException("Invalid weight");
                var left = Evaluate(parts[1][..separator], depth + 1); var right = Evaluate(parts[2], depth + 1);
                if (!Hex.IsMatch(left) || !Hex.IsMatch(right)) throw new InvalidDataException("Noncolor mix");
                var color = "#";
                foreach (var index in new[] { 1, 3, 5 })
                {
                    var a = int.Parse(left.AsSpan(index, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                    var b = int.Parse(right.AsSpan(index, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                    color += ((int)Math.Round(a * weight + b * (1 - weight))).ToString("X2", CultureInfo.InvariantCulture);
                }
                return color;
            }
            throw new InvalidDataException("Unsupported generated paint value");
        }
    }
    private static void Validate(XElement[] elements)
    {
        string[] allowed = ["svg", "g", "defs", "style", "marker", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text", "tspan", "title", "desc"];
        var fragment = new Regex(@"^url\(#[A-Za-z0-9_-]{1,128}\)$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        foreach (var item in elements)
        {
            if (item.Name.NamespaceName != "http://www.w3.org/2000/svg" || !allowed.Contains(item.Name.LocalName))
                throw new InvalidDataException("Unsupported generated SVG element.");
            foreach (var attribute in item.Attributes())
            {
                if (attribute.IsNamespaceDeclaration) continue;
                var name = attribute.Name.LocalName;
                if (attribute.Name.NamespaceName.Length != 0 || name.StartsWith("on", StringComparison.OrdinalIgnoreCase) ||
                    name is "href" or "filter" || (name == "style" && item != elements[0]))
                    throw new InvalidDataException("Active or external SVG content is not allowed.");
                if (attribute.Value.Contains("url(", StringComparison.OrdinalIgnoreCase) && !fragment.IsMatch(attribute.Value))
                    throw new InvalidDataException("Only bounded same-document marker references are allowed.");
            }
        }
    }

    private static List<string> Split(string text)
    {
        var values = new List<string>(); var depth = 0; var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '(') depth++;
            else if (text[i] == ')') depth--;
            else if (text[i] == ',' && depth == 0) { values.Add(text[start..i].Trim()); start = i + 1; }
            if (depth is < 0 or > 16) throw new InvalidDataException("Paint nesting");
        }
        if (depth != 0) throw new InvalidDataException("Paint nesting");
        values.Add(text[start..].Trim()); return values;
    }
}
