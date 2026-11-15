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
for tree in ("FileTree", "ChangeTree"):
    for prop in ("CanDragItems", "CanReorderItems", "AllowDrop"):
        assert named[tree].get(prop) == "False"
for control in ("PathInput", "FileTree", "HomeSearch", "SourceText", "ThemeButton", "ChangeTree", "ComparisonLines", "GitStaged", "GitUnstaged", "GitHighlight", "GitVersions"):
    assert named[control].get("AutomationProperties.Name")
for control in ("BeforeText", "AfterText"):
    assert named[control].get("IsReadOnly") == "True"
    assert named[control].get("TextWrapping") == "NoWrap"
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
    for background in ("MiruAdded", "MiruRemoved"):
        a, b = sorted((luminance(colors["MiruForeground"]), luminance(colors[background])))
        assert (b + 0.05) / (a + 0.05) >= 4.5, (name, background)
for brush in dictionaries["HighContrast"]:
    assert brush.get("Color", "").startswith("{ThemeResource SystemColor")

code = (root / "src/Miru.App/MainWindow.xaml.cs").read_text(encoding="utf-8")
# Native shell owns presentation, not filesystem or process operations.
assert not re.search(r"\b(?:File|Directory|Process|HttpClient)\.", code)
assert "Task.Run(work, lifetime.Token)" in code
assert "if (busy || closed) return" in code
for panel in ("PathControls", "Explorer", "HomePanel"):
    assert f"{panel}.IsEnabled" not in code
for control in ("PathInput", "OpenPathButton", "FileTree", "HomeSearch", "HomeEntries", "ChangeTree"):
    assert f"{control}.IsEnabled" in code
git_view = (root / "src/Miru.App/MainWindow.Git.cs").read_text(encoding="utf-8")
assert not re.search(r"\b(?:File|Directory|Process|HttpClient|XamlReader)\.", git_view)
assert "current.ReadDiffAsync(change.Id, stage, lifetime.Token)" in git_view
assert "LineComparison.Create(diff.Before, diff.After)" in git_view
assert "if (Session.Mode != ViewerMode.Repository)" in git_view
assert git_view.index("if (Session.Mode != ViewerMode.Repository)") < git_view.index("GitRepository.OpenAsync")
assert "if (applyingGit || busy || selectedChange is not" in git_view
assert "Files remain available" in git_view
assert "No file changes inside this top" in git_view
assert "Submodule changes, including staged entries, are omitted" in git_view
assert "state.Diff.Message" in git_view and "state.Diff.Notice" in git_view
assert git_view.index('GitMessage.Text = "Reading comparison…"') < git_view.index("current.ReadDiffAsync")
assert "if (busy || closed) return" in git_view
assert "PrepareFile(Session.Read(" in code
assert "MarkdownPreview.Create(file.Text)" in code
assert "NativeDocumentView.Render(MarkdownBlocks, document)" in code
for control in ("PreviewView", "SourceView", "MarkdownScroll"):
    assert named[control].get("AutomationProperties.Name")
document_view = (root / "src/Miru.App/NativeDocumentView.cs").read_text(encoding="utf-8")
assert not re.search(r"\b(?:File|Directory|Process|HttpClient|XamlReader)\.", document_view)
assert not re.search(r"new\s+(?:Uri|Hyperlink|Image|WebView2)\b", document_view)
assert "new Run { Text = item.Text }" in document_view
assert "AutomationProperties.SetHeadingLevel" in document_view
print("Native shell static contracts and 16 theme contrast pairs passed; WinUI not launched.")
