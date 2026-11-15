"""Static UI contract checks. These do NOT launch or render WinUI."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
ns = {"p": "http://schemas.microsoft.com/winfx/2006/xaml/presentation"}
x = "{http://schemas.microsoft.com/winfx/2006/xaml}"
shell = ET.parse(root / "src/Miru.App/MainWindow.xaml").getroot()
named = {e.get(x + "Name"): e for e in shell.iter() if e.get(x + "Name")}
assert named["SourceText"].get("IsReadOnly") == "True"
assert named["SourceText"].get("TextWrapping") == "NoWrap"
for prop in ("CanDragItems", "CanReorderItems", "AllowDrop"):
    assert named["FileTree"].get(prop) == "False"
for control in ("PathInput", "FileTree", "HomeSearch", "SourceText", "ThemeButton"):
    assert named[control].get("AutomationProperties.Name")
assert not any(e.tag.rsplit("}", 1)[-1] in {"WebView", "WebView2", "HyperlinkButton"} for e in shell.iter())

themes = ET.parse(root / "src/Miru.App/Themes/Colors.xaml").getroot()
dictionaries = {e.get(x + "Key"): e for e in themes.iter() if e.tag.endswith("ResourceDictionary") and e.get(x + "Key")}
assert set(dictionaries) == {"Light", "Default", "HighContrast"}

def luminance(color):
    values = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
    return sum(v * weight for v, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

for name in ("Light", "Default"):
    colors = {e.get(x + "Key"): e.get("Color") for e in dictionaries[name]}
    for foreground in ("MiruForeground", "MiruMuted", "MiruAccent"):
        for background in ("MiruCanvas", "MiruSidebar"):
            a, b = sorted((luminance(colors[foreground]), luminance(colors[background])))
            contrast = (b + 0.05) / (a + 0.05)
            assert contrast >= 4.5, (name, foreground, background, contrast)
for brush in dictionaries["HighContrast"]:
    assert brush.get("Color", "").startswith("{ThemeResource SystemColor")

code = (root / "src/Miru.App/MainWindow.xaml.cs").read_text()
# Native shell owns presentation, not filesystem or process operations.
assert not re.search(r"\b(?:File|Directory|Process|HttpClient)\.", code)
assert "Task.Run(work, lifetime.Token)" in code
assert "if (busy || closed) return" in code
for panel in ("PathControls", "Explorer", "HomePanel"):
    assert f"{panel}.IsEnabled" not in code
for control in ("PathInput", "OpenPathButton", "FileTree", "HomeSearch", "HomeEntries"):
    assert f"{control}.IsEnabled" in code
assert "Native Git status and diffs are not available yet" in code
assert "Native Markdown, Mermaid and document previews are still being ported" in code
print("Native shell static contracts and 12 theme contrast pairs passed; WinUI not launched.")
