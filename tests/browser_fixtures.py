"""Synthetic local files and Git history for browser acceptance checks."""
import base64
from dataclasses import dataclass
from pathlib import Path
import subprocess


@dataclass(frozen=True)
class BrowserFixture:
    folder: Path
    long_name: str
    source_files: dict[str, str]
    index_before: bytes


def _pdf_bytes():
    stream = b"BT /F1 18 Tf 30 100 Td (MIRU PDF) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    result = b"%PDF-1.4\n"
    offsets = [0]
    for index, item in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{index} 0 obj\n".encode() + item + b"\nendobj\n"
    xref = len(result)
    result += b"xref\n0 6\n0000000000 65535 f \n"
    result += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    return result + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def build_workspace(home: Path, external: str) -> BrowserFixture:
    folder = home / "workspace"
    folder.mkdir()
    (folder / "nested").mkdir()
    (folder / "nested" / "deep").mkdir()
    (home / "loose").mkdir()
    (folder / "nested" / "child.txt").write_text("child file")
    (folder / "nested" / "deep" / "deep-preview.txt").write_text("deep preview")
    (folder / ".gitignore").write_text("*.skip\nignored-cache/*\nignored-deep/**\n")
    (folder / "ignored.skip").write_text("untracked and ignored")
    (folder / "tracked.skip").write_text("tracked despite rule")
    (folder / "ignored-cache").mkdir()
    (folder / "ignored-cache" / "cached.txt").write_text("hidden by Git ignore")
    (folder / "ignored-deep").mkdir()
    (folder / "ignored-deep" / "cached.txt").write_text("hidden by Git ignore")
    long_name = "long-" + "illustration-" * 14 + "name.txt"
    (folder / "nested" / long_name).write_text("long label")
    (folder / "local.css").write_text(f'body{{color:rgb(10,20,30)}} @import "{external}/css-import"; .x{{background:url({external}/css-image)}}')
    (folder / "pixel.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
    (home / "outside-secret.png").write_bytes((folder / "pixel.png").read_bytes())
    (folder / "readme.md").write_text(f'# Safe Markdown\n\n![Local](pixel.png)\n\n![Outside]({external}/markdown)\n\n<script>parent.pwned=true</script>\n\n| Name | Value |\n| --- | --- |\n| GFM | Ready |\n\n- [x] Done\n- [ ] Next\n\n```ts\nconst readOnly = true;\n```\n')
    source_fixtures = {
        "sample.json": '{"value": true, "text": "<script>not markup</script>"}',
        "sample.js": 'export const message = "hello";',
        "sample.ts": "type Key = string;",
        "sample.tsx": "const component = <div>Hello</div>;",
        "sample.jsx": "const component = <div>Hello</div>;",
        "sample.py": "def greet(name):\n    return name",
        "sample.css": "div { color: blue; }",
        "sample.sh": 'echo "$HOME"',
        "sample.yml": "enabled: true",
        "sample.toml": 'name = "miru"',
        "sample.sql": "SELECT name FROM files;",
    }
    for filename, source in source_fixtures.items():
        (folder / filename).write_bytes((source + "\r\n").encode())
    (folder / "oversized.json").write_text('"' + ("a" * 1024) + '"')
    (folder / "code-fallback.md").write_text(
        'Unknown: `inline`\n\n```not-a-language\n<script>parent.pwned = true</script>\n```\n'
        + "```json\n" + ("a" * 1024) + "\n```\n"
    )
    (folder / "page.html").write_text(f'''<link rel="stylesheet" href="local.css"><h1>Isolated HTML</h1><img src="pixel.png"><img src="{external}/image"><iframe src="{external}/frame"></iframe><script>fetch('{external}/script');parent.pwned=true</script><form action="{external}/form"><input><button>Submit</button></form><style>.y{{background:u\\72l({external}/escaped)}} @font-face{{font-family:x;src:url({external}/font)}}</style><a href="{external}/navigate">Disabled link</a>''')
    (folder / "hostile.html").write_text(f'''
        <meta http-equiv="refresh" content="0; url={external}/refresh">
        <base href="{external}/base/"><h1>Hostile fixture</h1>
        <img id="local-survivor" src="pixel.png" srcset="{external}/srcset 1x" onload="parent.pwned=true">
        <img id="escape-resource" src="../outside-secret.png">
        <img id="encoded-escape" src="..%2foutside-secret.png">
        <a id="active-link" href="javascript:parent.pwned=true" ping="{external}/ping" target="_top" download="x">Disabled action</a>
        <div id="editable" contenteditable="true">Read only</div>
        <svg><foreignObject><iframe src="{external}/svg-frame"></iframe></foreignObject></svg>
        <math><mtext>Math must be removed</mtext></math>
        <object data="{external}/object"></object><embed src="{external}/embed">
        <video poster="{external}/poster"><source src="{external}/video"></video><audio src="{external}/audio"></audio>
        <form action="{external}/post" method="post"><input><button>Send</button></form>
        <style>@import "{external}/import"; @font-face{{font-family:x;src:url({external}/font)}}
        #editable{{background-image:image-set(url({external}/image-set) 1x)}}</style>
        <script>navigator.sendBeacon('{external}/beacon','blocked');fetch('{external}/fetch');parent.pwned=true;</script>
    ''')
    (folder / "diagrams.md").write_text('''# Mermaid fixtures
```mermaid
flowchart LR
  A[Local] --> B[Read only]
```
```mermaid
sequenceDiagram
  Alice->>Bob: Hello
```
```mermaid
not a supported diagram
```
```mermaid
%%{init: {"securityLevel": "loose"}}%%
flowchart LR; A --> B
```
''' + "```mermaid\n" + "x" * 12001 + "\n```\n")
    (folder / "diagram-limit.md").write_text("```mermaid\n%%{init: {}}%%\ngraph TD; A --> B\n```\n" * 9)
    (folder / "one-diagram.md").write_text("```mermaid\ngraph TD; A --> B\n```\n")
    (folder / "hostile-diagram.md").write_text(f'''```mermaid
flowchart LR
  A["<img src='{external}/diagram-image' onerror='parent.pwned=true'>"] --> B[Local]
  click B href "{external}/diagram-link"
```
''')
    (folder / "doc.pdf").write_bytes(_pdf_bytes())
    (folder / "node_modules").mkdir()
    (folder / "node_modules" / "hidden-search.txt").write_text("excluded")
    (folder / "test.txt").write_text("before\n")
    def git(*args):
        return subprocess.check_output(["git", "-C", str(folder), *args], stderr=subprocess.DEVNULL)
    git("init", "-q")
    git("-c", "user.name=EV", "-c", "user.email=ev@example.test", "add", ".")
    git("add", "-f", "tracked.skip")
    git("-c", "user.name=EV", "-c", "user.email=ev@example.test", "commit", "-qm", "base")
    (folder / "test.txt").write_text("staged\n")
    git("add", "test.txt")
    (folder / "test.txt").write_text("unstaged\n")
    (folder / "nested" / "deep" / "modified-leaf.txt").write_text("new untracked child")
    index_before = (folder / ".git" / "index").read_bytes()
    return BrowserFixture(folder, long_name, source_fixtures, index_before)
