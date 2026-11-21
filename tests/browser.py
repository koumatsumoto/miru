"""Real Chromium offline/sandbox smoke tests. Requires Python Playwright and Chromium.
Run after npm run build. No browser install/download occurs in this script.
"""
import base64
import http.server
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
(ROOT / ".cache").mkdir(exist_ok=True)
requests = []
class Receiver(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append((self.command, self.path))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"untrusted")
    do_POST = do_GET
    do_OPTIONS = do_GET
    do_HEAD = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET
    def log_message(self, *_args):
        pass

receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
threading.Thread(target=receiver.serve_forever, daemon=True).start()
external = f"http://127.0.0.1:{receiver.server_port}"

def pdf_bytes():
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

with tempfile.TemporaryDirectory(prefix="ev-browser-") as temp:
    home = Path(temp)
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
    (folder / "doc.pdf").write_bytes(pdf_bytes())
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
    env = {**os.environ, "HOME": str(home), "EV_NO_OPEN": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
    # The separate daemon smoke covers default detachment and update. Keep these
    # long-running Playwright checks scoped to the child this test owns.
    process = subprocess.Popen(["node", str(ROOT / "dist" / "cli.mjs"), "--foreground"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        first = process.stdout.readline()
        url = re.search(r"http://localhost:\d+", first).group(0)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**({"executable_path": os.environ["CHROMIUM_PATH"]} if "CHROMIUM_PATH" in os.environ else {"executable_path": "/usr/bin/chromium"} if Path("/usr/bin/chromium").exists() else {}), headless=True, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, color_scheme="light")
            errors = []
            unexpected_requests = []
            sockets = []
            requested_paths = []
            allowed_origin = urlsplit(url)
            page.on("pageerror", lambda error: errors.append(str(error)))
            def observe_request(request):
                target = urlsplit(request.url)
                requested_paths.append(target.path)
                if target.scheme in ("http", "https") and (target.scheme, target.netloc) != (allowed_origin.scheme, allowed_origin.netloc):
                    unexpected_requests.append((request.method, request.url))
            page.context.on("request", observe_request)
            page.on("websocket", lambda socket: sockets.append(socket.url))
            settings = page.get_by_role("button", name="設定", exact=True)
            panel = page.locator("#settings-panel")
            def settings_action(_selector):
                def bar_layout(bar):
                    return bar.evaluate("""el => {
                      const rect = el.getBoundingClientRect();
                      const title = el.querySelector('.viewer-title').getBoundingClientRect();
                      const css = getComputedStyle(el);
                      return [rect.x, rect.y, rect.width, rect.height, title.x,
                              css.borderBottomWidth, css.borderBottomStyle, css.borderBottomColor];
                    }""")
                file_bar = page.locator("#file-bar")
                file_layout = bar_layout(file_bar)
                settings.click()
                expect(panel).to_be_visible()
                expect(file_bar).to_be_hidden()
                assert bar_layout(panel.locator(".viewer-bar")) == file_layout
                assert panel.locator(".settings-content").bounding_box()["y"] >= file_layout[1] + file_layout[3]
                previous = page.locator("html").get_attribute("data-theme")
                next_theme = "dark" if previous == "light" else "light"
                panel.locator(f'input[value="{next_theme}"]').check()
                expect(page.locator("html")).to_have_attribute("data-theme", next_theme)
                assert json.loads((home / ".miru" / "settings.json").read_text())["theme"] == next_theme
                settings.click()
                expect(panel).to_be_hidden()
            # A failed bootstrap must leave controls inert and recover through Refresh.
            page.route(url + "/api", lambda route: route.fulfill(status=503, content_type="application/json", body='{"error":"synthetic initial state unavailable"}'))
            page.goto(url)
            expect(page.locator("#status")).to_contain_text("synthetic initial state unavailable")
            expect(page.locator("header [data-view], #search-form button[type=submit]")).to_have_count(0)
            expect(page.locator("[data-mode=diff]")).to_be_disabled()
            expect(page.locator("#file-bar")).to_be_hidden()
            expect(page.locator("#content")).to_be_empty()
            page.unroute(url + "/api")
            expect(panel).to_be_hidden()
            expect(page.locator("header #settings-toggle")).to_have_count(0)
            expect(page.locator("footer #version-value")).to_be_visible()
            assert settings.bounding_box()["x"] < 10
            version_rect = page.locator("footer #version-value").bounding_box()
            assert abs(1440 - version_rect["x"] - version_rect["width"]) <= 10
            assert version_rect["y"] >= 970
            page.locator(".folder-heading #refresh").click()
            expect(page.locator("#folder-name")).to_have_text(home.name)
            expect(page.locator(".launcher")).to_have_count(0)
            expect(page).to_have_title("Miru")
            expect(page.locator("header #query")).to_be_visible()
            expect(page.locator("#results")).to_be_hidden()
            icon = page.locator("link[rel=icon]").get_attribute("href")
            assert icon.startswith("/assets/") and icon.endswith(".svg")
            icon_response = page.request.get(url + icon)
            assert icon_response.ok and icon_response.headers["content-type"] == "image/svg+xml"
            brand = page.locator("header .brand")
            assert brand.locator("img").evaluate("image => image.complete && image.naturalWidth > 0")
            assert brand.get_attribute("title") is None
            assert brand.evaluate("node => node.tagName") != "BUTTON"
            brand.click()
            expect(page.locator("#folder-name")).to_have_text(home.name)
            expect(page.get_by_text("閲覧専用 · ローカル", exact=True)).to_have_count(0)
            for selector in ["header .brand", "#settings-toggle"]:
                button = page.locator(selector)
                page.mouse.move(0, 300)
                style = button.evaluate("el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]")
                button.hover()
                assert button.evaluate("el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]") == style
            settings.press("Enter")
            expect(settings).to_have_attribute("aria-expanded", "true")
            expect(panel.locator("#version-value")).to_have_count(0)
            expect(page.locator("footer #version-value")).to_have_text(re.compile(r"^v\d+\.\d+\.\d+( · [a-f0-9]{8,40})?$"))
            expect(page.locator("#settings-title")).to_be_focused()
            expect(page.locator(".viewer #settings-panel")).to_be_visible()
            expect(page.locator("#file-pane")).to_be_hidden()
            expect(panel.locator("#refresh")).to_have_count(0)
            page.keyboard.press("Escape")
            expect(settings).to_be_focused()
            expect(panel).to_be_hidden()
            settings.click()
            page.locator("#query").click()
            expect(panel).to_be_visible()
            page.get_by_role("button", name="設定を閉じる").click()
            expect(panel).to_be_hidden()
            page.set_viewport_size({"width": 360, "height": 780})
            assert page.locator("header").evaluate("header => header.scrollWidth <= header.clientWidth")
            expect(page.locator("header #query")).to_be_visible()
            for width in [360, 1440]:
                page.set_viewport_size({"width": width, "height": 800})
                search_bounds = page.locator("#query").bounding_box()
                assert abs(search_bounds["x"] + search_bounds["width"] / 2 - width / 2) < 2
            page.set_viewport_size({"width": 1440, "height": 1000})
            expect(page.locator("#content")).to_have_attribute("tabindex", "0")
            expect(page.locator("body")).to_have_attribute("aria-busy", "false")
            expect(page.locator("#file-bar")).to_be_hidden()
            expect(page.locator("#content")).to_be_empty()
            splitter = page.get_by_role("separator", name="サイドナビの幅")
            sidebar = page.locator("#explorer")
            expect(sidebar).to_have_css("width", "300px")
            edge = splitter.bounding_box()
            x = edge["x"] + edge["width"] / 2
            y = edge["y"] + edge["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 178, y, steps=5)
            page.mouse.up()
            expect(sidebar).to_have_css("width", "478px")
            expect(splitter).to_have_attribute("aria-valuenow", "478")
            page.reload()
            expect(page.locator("body")).to_have_attribute("aria-busy", "false")
            expect(sidebar).to_have_css("width", "478px")
            page.set_viewport_size({"width": 760, "height": 800})
            expect(sidebar).to_have_css("width", "440px")
            page.set_viewport_size({"width": 360, "height": 800})
            expect(sidebar).to_have_css("width", "210px")
            expect(splitter).to_be_hidden()
            page.set_viewport_size({"width": 1440, "height": 1000})
            expect(sidebar).to_have_css("width", "478px")
            splitter.focus()
            splitter.press("End")
            expect(sidebar).to_have_css("width", "864px")
            splitter.press("Home")
            splitter.press("ArrowLeft")
            expect(sidebar).to_have_css("width", "200px")
            page.reload()
            expect(page.locator("body")).to_have_attribute("aria-busy", "false")
            expect(sidebar).to_have_css("width", "200px")
            page.get_by_role("button", name="絞り込み", exact=True).click()
            filter_bounds = page.locator("#tree-filters").bounding_box()
            assert filter_bounds["x"] >= 0 and filter_bounds["x"] + filter_bounds["width"] <= 200
            page.locator("#tree-query").press("Escape")
            # Leave the default-width fixture for the separate tree/menu checks.
            edge = splitter.bounding_box()
            x = edge["x"] + edge["width"] / 2
            y = edge["y"] + edge["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 100, y, steps=4)
            page.mouse.up()
            expect(sidebar).to_have_css("width", "300px")
            page.locator(".skip-link").focus()
            page.keyboard.press("Enter")
            expect(page.locator("#content")).to_be_focused()
            page.locator("#tree .tree-entry").filter(has_text="workspace").click(button="right")
            page.get_by_role("menuitem", name="ここをトップにして表示").click()
            expect(page.locator("#folder-name")).to_have_text("workspace")
            expect(page.locator("#file-bar")).to_be_hidden()
            expect(page.locator("#content")).to_be_empty()
            expect(page.locator("aside #repo")).to_have_count(0)
            expect(page.locator("aside")).to_have_css("scrollbar-width", "thin")
            expect(page.locator("aside")).not_to_contain_text("件の変更（表示範囲内）")
            expect(page.locator("#tree")).to_contain_text("node_modules")
            expect(page.locator("#tree")).to_contain_text(".git")
            filter_toggle = page.get_by_role("button", name="絞り込み", exact=True)
            filter_panel = page.locator("#tree-filters")
            expect(filter_panel).to_be_hidden()
            filter_toggle.click()
            expect(filter_toggle).to_have_attribute("aria-expanded", "true")
            folder_query = filter_panel.get_by_role("searchbox")
            expect(folder_query).to_be_focused()
            expect(filter_panel).to_have_css("font-size", "13px")
            ignore_filter = page.get_by_role("checkbox", name="無視ファイルを除外")
            changes_filter = page.get_by_role("checkbox", name="変更ファイルのみ")
            expect(ignore_filter).not_to_be_checked()
            expect(changes_filter).not_to_be_checked()
            ignore_filter.check()
            expect(page.locator("#tree")).not_to_contain_text("ignored.skip")
            expect(page.locator("#tree")).not_to_contain_text("ignored-cache")
            expect(page.locator("#tree")).not_to_contain_text("ignored-deep")
            expect(filter_toggle).to_have_attribute("data-active", "")
            assert folder_query.bounding_box()["y"] < ignore_filter.bounding_box()["y"] < changes_filter.bounding_box()["y"]
            expect(page.locator("#tree")).to_contain_text("tracked.skip")
            changes_filter.check()
            expect(page.locator("#tree")).to_contain_text("test.txt")
            expect(page.locator("#tree")).to_contain_text("nested")
            expect(page.locator("#tree")).not_to_contain_text("readme.md")
            folder_query.fill("modified-leaf")
            expect(page.locator("#tree")).to_contain_text("nested/deep/modified-leaf.txt")
            expect(page.locator("#tree")).not_to_contain_text("test.txt")
            with page.expect_response(lambda r: r.url == url + "/api" and r.request.post_data_json.get("query") == "readme"):
                folder_query.fill("readme")
            expect(page.locator("#tree .tree-entry")).to_have_count(0)
            expect(page.locator("#tree")).not_to_contain_text("この範囲に変更はありません")
            changes_filter.uncheck()
            expect(page.locator("#tree")).to_contain_text("readme.md")
            with page.expect_response(lambda r: r.url == url + "/api" and r.request.post_data_json.get("query") == "cached.txt"):
                folder_query.fill("cached.txt")
            expect(page.locator("#tree .tree-entry")).to_have_count(0)
            ignore_filter.uncheck()
            expect(page.locator("#tree")).to_contain_text("ignored-cache/cached.txt")
            folder_query.fill("")
            expect(page.locator("#tree")).to_contain_text("node_modules")
            folder_query.press("Escape")
            expect(filter_panel).to_be_hidden()
            expect(filter_toggle).to_be_focused()
            expect(page.locator("#tree")).to_contain_text("ignored.skip")
            expect(page.locator("#tree")).to_contain_text("readme.md")
            def choose(name):
                page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile(f"^{re.escape(name)}$"))).click()
            choose("page.html")
            frame = page.frame_locator("iframe.document-preview")
            expect(frame.locator("h1")).to_have_text("Isolated HTML")
            expect(frame.locator("img").first).to_have_attribute("src", re.compile("^data:image/png;base64,"))
            assert frame.locator("body").evaluate("node => getComputedStyle(node).color") == "rgb(10, 20, 30)", f"Local CSS missing: {frame.locator('body').inner_html()} / {page.locator('iframe.document-preview').get_attribute('srcdoc')}"
            expect(frame.locator("script,iframe,form")).to_have_count(0)
            assert frame.locator("a").get_attribute("href") is None
            assert page.evaluate("window.pwned") is None
            assert frame.locator("body").evaluate("node => { try { return parent.document.body ? 'read' : 'empty'; } catch { return 'blocked'; } }") == "blocked", "Opaque preview could access parent DOM"
            assert frame.locator("body").evaluate("(node, origin) => fetch(origin + '/api', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'state'})}).then(response => response.status).catch(() => 'blocked')", url) == "blocked", "Preview could call the app API"
            parent_url_before = page.url
            choose("hostile.html")
            hostile = page.frame_locator("iframe.document-preview")
            expect(hostile.locator("h1")).to_have_text("Hostile fixture")
            expect(page.locator("iframe.document-preview")).to_have_attribute("sandbox", "")
            expect(hostile.locator("script,iframe,form,input,button,textarea,select,base,svg,math,object,embed,video,audio,source,meta[http-equiv=refresh]")).to_have_count(0)
            expect(hostile.locator("#local-survivor")).to_have_attribute("src", re.compile("^data:image/png;base64,"))
            for selector in ("#escape-resource", "#encoded-escape"):
                assert hostile.locator(selector).get_attribute("src") is None
                expect(hostile.locator(selector)).to_have_attribute("alt", re.compile("読み込み拒否"))
            assert hostile.locator("body").evaluate("body => [...body.querySelectorAll('*')].every(node => [...node.attributes].every(attribute => !/^on/i.test(attribute.name) && !['href','srcset','ping','target','download','contenteditable','action','formaction','poster'].includes(attribute.name)))"), "Active markup attributes survived"
            assert page.locator("meta[name=ev-session]").get_attribute("content") not in page.locator("iframe.document-preview").get_attribute("srcdoc"), "Preview received API credentials"
            hostile.locator("#active-link").click()
            assert page.url == parent_url_before, "Preview navigated the parent"
            assert page.evaluate("window.pwned") is None
            assert not any("/assets/syntax-worker-" in path for path in requested_paths)
            choose("readme.md")
            expect(page.frame_locator("iframe.document-preview").locator("h1")).to_have_text("Safe Markdown")
            md = page.frame_locator("iframe.document-preview")
            expect(md.locator("table")).to_contain_text("GFM")
            expect(md.locator(".task-check")).to_have_count(2)
            expect(md.locator("input")).to_have_count(0)
            expect(md.locator("pre code")).to_contain_text("const readOnly")
            light_code = md.locator("pre.syntax-highlighted")
            expect(light_code.locator("span").first).to_have_css("color", "rgb(215, 58, 73)")
            assert any("/assets/syntax-worker-" in path for path in requested_paths)
            assert any("/assets/typescript-" in path for path in requested_paths)
            assert not any("/assets/json-" in path for path in requested_paths)
            settings_action("#theme")
            expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            # A separate browser context has no storage from this tab.
            fresh_settings_page = browser.new_page(color_scheme="light")
            fresh_settings_page.goto(url)
            expect(fresh_settings_page.locator("html")).to_have_attribute("data-theme", "dark")
            fresh_settings_page.close()
            expect(page.frame_locator("iframe.document-preview").locator("body")).to_have_css("color", "rgb(240, 246, 252)")
            expect(md.locator("pre.syntax-highlighted span").first).to_have_css("color", "rgb(249, 117, 131)")
            settings_action("#theme")
            expect(page.frame_locator("iframe.document-preview").locator("body")).to_have_css("color", "rgb(31, 35, 40)")
            for filename, source in source_fixtures.items():
                choose(filename)
                highlighted = page.locator("#content pre.syntax-highlighted")
                expect(highlighted).to_be_visible()
                assert highlighted.evaluate("element => element.textContent") == source + "\r\n"
                assert highlighted.locator("span").count() > 1
                assert highlighted.locator("script, img").count() == 0
            choose("page.html")
            page.locator("[data-mode=code]").click()
            expect(page.locator("#content pre.syntax-highlighted span").first).to_be_visible()
            expect(page.locator("#content pre.syntax-highlighted")).to_contain_text("<script>")
            expect(page.locator("#content pre.syntax-highlighted script")).to_have_count(0)
            choose("oversized.json")
            expect(page.locator("#content pre.code")).to_be_visible()
            expect(page.locator("#content .syntax-highlighted")).to_have_count(0)
            choose("code-fallback.md")
            fallback = page.frame_locator("iframe.document-preview")
            expect(fallback.locator("pre")).to_have_count(2)
            expect(fallback.locator("pre.syntax-highlighted, pre span, script")).to_have_count(0)
            expect(fallback.locator("pre").first).to_contain_text("<script>parent.pwned = true</script>")
            choose("diagrams.md")
            diagrams = page.frame_locator("iframe.document-preview")
            expect(diagrams.locator(".mermaid-figure")).to_have_count(2, timeout=15000)
            expect(diagrams.locator(".mermaid-error")).to_have_count(3)
            expect(diagrams.locator(".mermaid-error")).to_contain_text(["描画できません", "初期化指示", "大きすぎます"])
            expect(diagrams.locator(".mermaid-figure img").first).to_have_attribute("src", re.compile("^data:image/png;base64,iVBORw0KGgo"))
            assert diagrams.locator(".mermaid-figure img").first.evaluate("image => image.complete && image.naturalWidth > 0")
            expect(diagrams.locator("script, svg, iframe")).to_have_count(0)
            expect(page.locator("iframe[data-mermaid-renderer]")).to_have_count(0)
            light_diagram = diagrams.locator(".mermaid-figure img").first.get_attribute("src")
            page.screenshot(path=str(ROOT / ".cache" / "miru-mermaid-light.png"))
            settings_action("#theme")
            expect(diagrams.locator(".mermaid-figure")).to_have_count(2, timeout=15000)
            assert diagrams.locator(".mermaid-figure img").first.get_attribute("src") != light_diagram
            page.screenshot(path=str(ROOT / ".cache" / "miru-mermaid-dark.png"))
            settings_action("#theme")
            expect(diagrams.locator(".mermaid-figure")).to_have_count(2, timeout=15000)
            choose("hostile-diagram.md")
            hostile_diagram = page.frame_locator("iframe.document-preview")
            expect(hostile_diagram.locator(".mermaid-figure, .mermaid-error")).to_have_count(1, timeout=8000)
            expect(hostile_diagram.locator("script, svg, iframe, [onerror], a[href]")).to_have_count(0)
            for image in hostile_diagram.locator("img").all():
                expect(image).to_have_attribute("src", re.compile("^data:image/png;base64,"))
            assert page.evaluate("window.pwned") is None
            choose("diagram-limit.md")
            expect(page.frame_locator("iframe.document-preview").locator(".mermaid-error")).to_have_count(9)
            expect(page.frame_locator("iframe.document-preview").locator(".mermaid-error").last).to_contain_text("8個まで")
            # Synthetic nonresponsive renderer verifies timeout and cancellation,
            # not successful DOM rendering or CSP enforcement by itself.
            page.route(url + "/renderer/mermaid", lambda route: route.fulfill(status=200, content_type="text/html", body="<!doctype html><p>No renderer response</p>"))
            choose("one-diagram.md")
            expect(page.frame_locator("iframe.document-preview").locator(".mermaid-error")).to_contain_text("時間内", timeout=8000)
            expect(page.locator("iframe[data-mermaid-renderer]")).to_have_count(0)
            choose("one-diagram.md")
            expect(page.locator("iframe[data-mermaid-renderer]")).to_have_count(1)
            choose("test.txt")
            expect(page.locator("#content")).to_contain_text("unstaged")
            expect(page.locator("iframe[data-mermaid-renderer]")).to_have_count(0)
            page.unroute(url + "/renderer/mermaid")
            choose("pixel.png")
            expect(page.locator(".image-preview img")).to_be_visible()
            choose("doc.pdf")
            expect(page.locator(".pdf-preview canvas")).to_be_visible(timeout=15000)
            expect(page.locator(".pdf-preview")).to_contain_text("1 / 1 ページ")
            choose("test.txt")
            selected_row = page.locator("#tree .tree-entry.selected")
            expect(selected_row).to_have_attribute("aria-current", "true")
            expect(selected_row.locator(".change-dot")).to_be_visible()
            selected_row.focus()
            active_selection = selected_row.evaluate("(row) => getComputedStyle(row).backgroundColor")
            page.locator("#content").focus()
            inactive_selection = selected_row.evaluate("(row) => getComputedStyle(row).backgroundColor")
            assert active_selection != inactive_selection
            unchanged_row = page.locator("#tree .tree-entry").filter(has=page.locator(".tree-label", has_text="readme.md"))
            unchanged_row.hover()
            hover_background = unchanged_row.evaluate("(row) => getComputedStyle(row).backgroundColor")
            assert hover_background not in (active_selection, inactive_selection)
            page.get_by_role("button", name="差分", exact=True).click()
            expect(page.locator(".diff-side").first).to_contain_text("staged")
            expect(page.locator(".diff-side").last).to_contain_text("unstaged")
            page.locator("#stage").select_option("staged")
            expect(page.locator(".diff-side").first).to_contain_text("before")
            expect(page.locator(".diff-side").last).to_contain_text("staged")
            expect(page.locator("#tree")).to_contain_text("readme.md")
            page.screenshot(path=str(ROOT / ".cache" / "miru-browser.png"))
            (folder / "new-file.txt").write_text("new")
            page.locator(".folder-heading #refresh").click()
            expect(page.locator("#tree")).to_contain_text("new-file.txt")
            expect(page.locator("body")).to_have_attribute("aria-busy", "false")
            expect(page.locator("#status")).to_have_text("")
            folder_button = page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile("^nested$")))
            expect(folder_button).to_have_attribute("aria-expanded", "false")
            expect(folder_button).to_have_attribute("aria-controls", re.compile("^children-"))
            expect(folder_button.locator("svg.tree-chevron")).to_be_visible()
            expect(folder_button.locator("svg.tree-icon-folder")).to_have_attribute("aria-hidden", "true")
            folder_shape_closed = folder_button.locator(".tree-icon-folder path").get_attribute("d")
            expect(folder_button).to_have_css("height", "24px")
            expect(folder_button).to_have_css("font-size", "13px")
            root_file = page.locator("#tree .tree-entry").filter(has=page.locator(".tree-label", has_text=re.compile("^test.txt$")))
            expect(root_file.locator(".tree-chevron")).to_be_hidden()
            assert root_file.locator(".tree-label").bounding_box()["x"] == folder_button.locator(".tree-label").bounding_box()["x"]
            before_reveal = page.locator("#file-name").text_content()
            file_actions = []
            def capture_file_action(route):
                body = route.request.post_data_json
                if body.get("op") not in ("reveal", "edit", "open-folder"):
                    route.continue_()
                    return
                file_actions.append(body)
                route.fulfill(status=200, content_type="application/json", body='{"ok":true}')
            page.route(url + "/api", capture_file_action)
            root_file.focus()
            expect(root_file).to_be_focused()
            page.keyboard.press("Shift+F10")
            reveal = page.get_by_role("menuitem", name="エクスプローラーで開く")
            expect(reveal).to_be_focused()
            expect(page.locator("#context-menu")).to_have_attribute("data-keyboard", "")
            expect(reveal).to_have_css("font-size", "13px")
            expect(reveal).to_have_css("font-weight", "500")
            expect(reveal).to_have_css("line-height", "19.5px")
            expect(reveal).to_have_css("height", "32px")
            expect(reveal).not_to_have_css("box-shadow", "none")
            edit = page.get_by_role("menuitem", name="編集する", exact=True)
            page.keyboard.press("ArrowDown")
            expect(edit).to_be_focused()
            page.keyboard.press("Home")
            expect(reveal).to_be_focused()
            page.keyboard.press("Escape")
            expect(root_file).to_be_focused()
            root_file.click(button="right")
            expect(page.locator("#context-menu")).not_to_have_attribute("data-keyboard", "")
            expect(reveal).to_have_css("outline-style", "none")
            reveal.click()
            expect(page.locator("#context-menu")).to_be_hidden()
            expect(page.locator("#status")).to_have_text("ファイルの場所を表示しました。")
            expect(page.locator("#file-name")).to_have_text(before_reveal)
            root_file.click(button="right")
            with page.expect_response(lambda r: r.url == url + "/api" and r.request.post_data_json.get("op") == "edit"):
                edit.click()
            expect(page.locator("#context-menu")).to_be_hidden()
            expect(page.locator("#file-name")).to_have_text(before_reveal)
            assert [action["op"] for action in file_actions] == ["reveal", "edit"]
            assert isinstance(file_actions[0]["id"], str) and file_actions[0]["id"] == file_actions[1]["id"]
            expect(page.locator(".file-bar")).not_to_contain_text("編集する")
            expect(page.locator(".file-bar")).not_to_contain_text("エクスプローラーで開く")
            folder_button.click(button="right")
            expect(page.get_by_role("menuitem", name="サブフォルダをすべて展開")).to_be_visible()
            expect(edit).to_have_count(0)
            reveal.click()
            expect(page.locator("#status")).to_have_text("ファイルマネージャーでフォルダを表示しました。")
            expect(page.locator("#file-name")).to_have_text(before_reveal)
            expect(page.locator("#folder-name")).to_have_text("workspace")
            page.locator("#folder-name").click(button="right")
            expect(page.get_by_role("menuitem", name="親を一段表示")).to_be_visible()
            with page.expect_response(lambda r: r.url == url + "/api" and r.request.post_data_json.get("op") == "open-folder"):
                reveal.click()
            expect(page.locator("#context-menu")).to_be_hidden()
            assert [action["op"] for action in file_actions] == ["reveal", "edit", "open-folder", "open-folder"]
            assert len({file_actions[0]["id"], file_actions[2]["id"], file_actions[3]["id"]}) == 3
            page.unroute(url + "/api", capture_file_action)
            folder_button.focus()
            page.keyboard.press("Shift+F10")
            expect(page.get_by_role("menuitem", name="ここをトップにして表示")).to_be_focused()
            page.keyboard.press("Escape")
            expect(page.locator("#context-menu")).to_be_hidden()
            expect(folder_button).to_be_focused()
            folder_button.dblclick()
            child_button = page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile("^child.txt$")))
            expect(child_button).to_have_count(1)
            if folder_button.get_attribute("aria-expanded") != "true":
                folder_button.click()
            expect(child_button).to_be_visible()
            expect(child_button.locator("svg.tree-icon-document")).to_be_visible()
            assert folder_button.locator(".tree-icon-folder path").get_attribute("d") != folder_shape_closed
            assert child_button.locator(".tree-label").bounding_box()["x"] - folder_button.locator(".tree-label").bounding_box()["x"] == 13
            long_row = page.get_by_role("button", name=long_name, exact=True)
            expect(long_row).to_have_attribute("title", long_name)
            expect(long_row).to_have_css("height", "24px")
            assert long_row.locator(".tree-label").evaluate("(label) => label.scrollWidth > label.clientWidth")
            assert page.locator("#tree").evaluate("(tree) => tree.scrollWidth <= tree.clientWidth")
            folder_button.click(button="right")
            page.get_by_role("menuitem", name="サブフォルダをすべて展開").click()
            deep_file = page.locator("#tree .tree-entry").filter(has=page.locator(".tree-label", has_text=re.compile("^deep-preview.txt$")))
            expect(deep_file).to_be_visible()
            guides = deep_file.evaluate("""row => {
              const lanes = [];
              for (let parent = row.parentElement; parent; parent = parent.parentElement) {
                if (!parent.classList.contains('tree-children')) continue;
                const line = getComputedStyle(parent, '::before');
                lanes.push([parseFloat(line.insetInlineStart), line.width, line.zIndex, line.pointerEvents]);
              }
              return lanes;
            }""")
            assert len(guides) == 2 and guides[0][0] - guides[1][0] == 13
            assert all(lane[1:] == ["1px", "1", "none"] for lane in guides)
            deep_file.click()
            expect(deep_file).to_have_attribute("aria-current", "true")
            expect(page.locator("#folder-name")).to_have_text("workspace")
            folder_button.focus()
            page.keyboard.press("Shift+F10")
            page.keyboard.press("Enter")
            expect(page.locator("#folder-name")).to_have_text("nested")
            expect(page.locator("#folder-name")).to_be_focused()
            page.locator("#folder-name").click(button="right")
            page.keyboard.press("Escape")
            expect(page.locator("#context-menu")).to_be_hidden()
            page.locator("#folder-name").click(button="right")
            page.get_by_role("menuitem", name="親を一段表示").click()
            expect(page.locator("#folder-name")).to_have_text("workspace")
            search = page.locator("header #query")
            search.fill("hidden-search")
            expect(page.locator("#status")).to_contain_text("0件（HOME）")
            expect(page.locator("#results")).to_be_hidden()
            # Hold an old request. Only the latest query may populate the popup.
            page.evaluate("""() => {
              window.__miruFetch = window.fetch;
              window.fetch = (...args) => {
                if (args[0] === '/api' && JSON.parse(args[1].body).query === 'readme.md')
                  return new Promise((resolve, reject) => {
                    document.body.dataset.searchBlocked = 'true';
                    window.__releaseSearch = () => { window.__miruFetch(...args).then(resolve, reject); };
                  });
                return window.__miruFetch(...args);
              };
            }""")
            search.fill("readme.md")
            expect(page.locator("body")).to_have_attribute("data-search-blocked", "true")
            search.fill("child.txt")
            expect(page.locator("#results")).to_be_hidden()
            page.evaluate("window.__releaseSearch()")
            expect(page.locator("#results .result")).to_have_text(re.compile("child.txt$"))
            search.press("ArrowDown")
            expect(page.locator("#results .result")).to_be_focused()
            page.keyboard.press("Escape")
            expect(search).to_be_focused()
            expect(search).to_have_value("")
            expect(page.locator("#results")).to_be_hidden()
            page.evaluate("window.fetch = window.__miruFetch")
            search.dispatch_event("compositionstart")
            search.fill("child.txt")
            page.wait_for_timeout(300)
            expect(page.locator("#results")).to_be_hidden()
            search.dispatch_event("compositionend")
            expect(page.locator("#results .result")).to_have_count(1)
            page.locator("#folder-name").click()
            expect(page.locator("#results")).to_be_hidden()
            search.click()
            expect(page.locator("#results .result")).to_have_count(1)
            page.locator("#results .result").click()
            expect(page.locator("#folder-name")).to_have_text("nested")
            expect(page.locator("#content")).to_contain_text("child file")
            expect(page.locator("[data-mode=preview]")).to_have_attribute("aria-pressed", "true")
            expect(page.locator("#results")).to_be_hidden()
            diff_process = subprocess.Popen(
                ["node", str(ROOT / "dist" / "cli.mjs"), "--foreground", "diff"],
                cwd=folder, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                diff_url = re.search(r"http://localhost:\d+", diff_process.stdout.readline()).group(0)
                diff_page = browser.new_page()
                diff_page.goto(diff_url)
                expect(diff_page.locator("#tree")).to_contain_text("test.txt")
                expect(diff_page.locator("#tree")).not_to_contain_text("readme.md")
                diff_page.locator("#tree .tree-entry").filter(has_text="test.txt").click()
                expect(diff_page.locator(".diff-side").last).to_contain_text("unstaged")
                diff_page.close()
            finally:
                diff_process.send_signal(signal.SIGINT)
                diff_process.wait(timeout=10)
            expect(page.locator(".launcher")).to_have_count(0)
            time.sleep(0.25)
            assert not requests, f"Preview leaked external traffic: {requests}"
            assert not unexpected_requests, f"Preview attempted cross-origin HTTP requests: {unexpected_requests}"
            assert not sockets, f"Preview opened WebSockets: {sockets}"
            assert not errors, f"Browser errors: {errors}"
            assert (folder / ".git" / "index").read_bytes() == index_before
            if os.name != "nt":
                with socket.socket() as port_probe:
                    port_probe.bind(("127.0.0.1", 0))
                    fixed_port = port_probe.getsockname()[1]
                resident_env = {**env, "MIRU_RUNTIME_DIR": str(home / "fixed-run"), "MIRU_PORT": str(fixed_port), "MIRU_NO_OPEN": "1"}
                def resident_command(arg):
                    return subprocess.check_output(["node", str(ROOT / "dist" / "cli.mjs"), str(arg)], env=resident_env, timeout=12, text=True)
                def tab_link(arg):
                    output = resident_command(arg)
                    return re.search(r"http://(?:localhost|127\.0\.0\.1):\d+/#[^\s]+", output).group(0)
                try:
                    one_url, two_url = tab_link(folder), tab_link(home / "loose")
                    fixed = one_url.split("#", 1)[0]
                    assert urlsplit(fixed).port == fixed_port
                    assert fixed == two_url.split("#", 1)[0]
                    assert re.fullmatch(r"grant=[a-f0-9]{64}", urlsplit(one_url).fragment)
                    assert re.fullmatch(r"grant=[a-f0-9]{64}", urlsplit(two_url).fragment)
                    resident_context = browser.new_context()
                    one = resident_context.new_page()
                    two = resident_context.new_page()
                    one.goto(one_url)
                    two.goto(two_url)
                    expect(one.locator("#folder-name")).to_have_text("workspace")
                    expect(two.locator("#folder-name")).to_have_text("loose")
                    assert one.url == two.url == fixed
                    row = one.locator(".folder-heading").bounding_box()
                    refresh = one.locator(".folder-heading #refresh").bounding_box()
                    assert abs(refresh["x"] + refresh["width"] - row["x"] - row["width"]) <= 8
                    one.locator("#tree .tree-entry").filter(has_text="test.txt").click()
                    expect(one.locator("#content")).to_contain_text("unstaged")
                    one.get_by_role("button", name="絞り込み", exact=True).click()
                    one.get_by_role("checkbox", name="無視ファイルを除外").check()
                    one.reload()
                    expect(one.locator("#tree")).to_contain_text("test.txt")
                    expect(one.locator("#tree")).not_to_contain_text("ignored.skip")
                    expect(one.locator("#content")).to_contain_text("unstaged")
                    expect(one.get_by_role("button", name="絞り込み", exact=True)).to_have_attribute("data-active", "")
                    one.get_by_role("button", name="絞り込み", exact=True).click()
                    expect(one.get_by_role("checkbox", name="無視ファイルを除外")).to_be_checked()
                    expect(two.locator("#folder-name")).to_have_text("loose")
                    two.get_by_role("button", name="絞り込み", exact=True).click()
                    expect(two.get_by_role("checkbox", name="無視ファイルを除外")).not_to_be_checked()
                    blank = resident_context.new_page()
                    blank.goto(fixed)
                    assert not blank.locator('meta[name="ev-session"]').get_attribute("content")
                    unauthenticated = blank.request.post(fixed + "api", headers={"Origin": fixed.rstrip("/")}, data={"op":"state"})
                    assert unauthenticated.status == 403
                    reused_grant = blank.request.post(fixed + "api", headers={
                        "Origin": fixed.rstrip("/"),
                        "X-EV-Session": re.search(r"(?:#|&)grant=([a-f0-9]{64})(?:&|$)", one_url).group(1),
                    }, data={"op":"connect"})
                    assert reused_grant.status == 403
                    resident_context.close()
                finally:
                    resident_command("stop")
            browser.close()
        print("PASS: real Chromium previews, no external traffic, PDF worker, diffs, tree, refresh, search, context menus, unchanged index")
    finally:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=10)
        receiver.shutdown()
