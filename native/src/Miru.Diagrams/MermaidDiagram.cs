using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using Mermaider;
using Mermaider.Models;
using SkiaSharp;
using Svg;
using Svg.Model;
using Svg.Skia;

namespace Miru.Diagrams;

public sealed record DiagramResult(byte[]? Png, int Width, int Height, string? Error)
{
    public bool CanPreview => Png is not null;
}

/// <summary>Fixed offline diagram subset → inert PNG. Call off the UI thread and serially.</summary>
public static class MermaidDiagram
{
    public const int MaximumSourceCharacters = 12_000;
    public const int MaximumPixels = 4_000_000;
    private static readonly Regex SourceStyling = new(@"^\s*(?:click|style|classDef|linkStyle)\b", RegexOptions.Multiline | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    public static async Task<DiagramResult> RenderAsync(string source, bool dark, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        cancellationToken.ThrowIfCancellationRequested();
        if (source.Length > MaximumSourceCharacters || source.Count(c => c is '\n' or '\r') > 400)
            return Unavailable("Mermaid source exceeds the preview budget.");
        if (source.Contains("%%{", StringComparison.Ordinal) || source.TrimStart().StartsWith("---", StringComparison.Ordinal) || SourceStyling.IsMatch(source))
            return Unavailable("Mermaid configuration, links and source-authored styling are not supported.");
        try
        {
            var font = ChooseFont(source);
            var options = new RenderOptions
            {
                Bg = dark ? "#0d1117" : "#ffffff", Fg = dark ? "#e6edf3" : "#1f2328",
                Font = font, MonoFont = font, FontSize = "14px", Transparent = false,
                Style = DiagramStyle.Blueprint, Gradient = false, Elevation = 0,
                AllowedDiagrams = DiagramTypes.Flowchart | DiagramTypes.Sequence,
                Strict = new StrictStylingOptions { Mode = StrictStylingMode.Block }, SanitizeMode = SanitizeMode.Block,
                Limits = new ResourceLimits
                {
                    MaxInputLength = MaximumSourceCharacters, MaxLines = 200, MaxElements = 150,
                    MaxNodesAfterLayout = 600, MaxRecursionDepth = 16, MaxOutputLength = 512 * 1024,
                    RenderDeadline = TimeSpan.FromSeconds(2)
                }
            };
            using var svgBytes = new MemoryStream();
            await MermaidRenderer.RenderSvgAsync(source, svgBytes, options, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            var markup = GeneratedSvg.Resolve(Encoding.UTF8.GetString(svgBytes.ToArray()), font);
            using var svg = new SKSvg();
            svg.Settings.EnableJavaScript = false;
            svg.Settings.EnableExternalJavaScript = false;
            svg.Settings.EnableSvgFonts = false;
            svg.Settings.EnableTextReferences = false;
            svg.Settings.NavigationHandler = null;
            var parameters = new SvgParameters(null, null, null, new SvgDocumentLoadOptions
            {
                ProcessingMode = SvgProcessingMode.SecureStatic,
                ExternalResources = SvgExternalResourcePolicy.Disabled, PreserveUnknownElements = false
            });
            using var input = new MemoryStream(Encoding.UTF8.GetBytes(markup));
            var picture = svg.Load(input, parameters) ?? throw new InvalidDataException("Diagram graphics are unavailable.");
            cancellationToken.ThrowIfCancellationRequested();
            var box = picture.CullRect;
            if (!float.IsFinite(box.Left) || !float.IsFinite(box.Top) || !float.IsFinite(box.Width) || !float.IsFinite(box.Height) ||
                box.Width <= 0 || box.Height <= 0 || box.Width > 2048 || box.Height > 2048)
                throw new InvalidDataException("Diagram dimensions exceed the preview budget.");
            var width = (int)Math.Ceiling(box.Width * 2); var height = (int)Math.Ceiling(box.Height * 2);
            if ((long)width * height > MaximumPixels) throw new InvalidDataException("Diagram pixel budget exceeded.");
            using var surface = SKSurface.Create(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul))
                ?? throw new InvalidDataException("Native graphics surface is unavailable.");
            surface.Canvas.Clear(dark ? new SKColor(13, 17, 23) : SKColors.White);
            surface.Canvas.Scale(2); surface.Canvas.Translate(-box.Left, -box.Top); surface.Canvas.DrawPicture(picture);
            cancellationToken.ThrowIfCancellationRequested();
            using var image = surface.Snapshot(); using var png = image.Encode(SKEncodedImageFormat.Png, 100);
            if (png.Size > 2 * 1024 * 1024) throw new InvalidDataException("Diagram PNG budget exceeded.");
            return new(png.ToArray(), width, height, null);
        }
        catch (Exception error) when (error is MermaidParseException or MermaidRenderException or MermaidSvgException or
            InvalidDataException or XmlException or FormatException or ArgumentException or NotSupportedException or RegexMatchTimeoutException)
        { return Unavailable("Mermaid preview unavailable: " + error.Message); }
        catch (Exception error) when (error is DllNotFoundException or TypeInitializationException)
        { return Unavailable("The bundled native graphics runtime is unavailable. Use Source."); }
    }

    private static string ChooseFont(string source)
    {
        var text = string.Concat(source.Where(c => !char.IsControl(c)));
        foreach (var family in new[] { "Yu Gothic UI", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", "Noto Sans CJK SC", "Segoe UI", "DejaVu Sans" })
        {
            using var face = SKFontManager.Default.MatchFamily(family);
            if (face is null || !face.FamilyName.Equals(family, StringComparison.OrdinalIgnoreCase)) continue;
            using var font = new SKFont(face, 14);
            if (font.ContainsGlyphs(text)) return family;
        }
        throw new InvalidDataException("No installed font covers this diagram's characters. Fonts are not downloaded.");
    }

    private static DiagramResult Unavailable(string error) => new(null, 0, 0, error);
}
