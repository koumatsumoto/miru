# MIRU

A read-only local file and Git viewer. Run `miru` instead of opening an editor just
to inspect a folder. Viewed files stay on the machine, and no telemetry is used.

## Quick start: browser viewer

MIRU runs locally and opens in your existing browser. On a Windows machine,
run the commands in WSL to view WSL files and Git repositories without copying
them to Windows. No WinUI package or .NET installation is needed.

- Node.js **24.11+ (24.x)** or **26+** and npm. Git on PATH is needed for
  showing changes and diffs, and for the explicit update from GitHub.
- From the cloned repository, install dependencies and build once:

```sh
npm ci
npm run build
```

In WSL/Linux, register the short command once with `npm link`. This uses the
checkout you are already working in; it does not install a system service.
Without a global link, use `node dist/cli.mjs` in place of `miru`.

```sh
npm link
miru server          # start the local server in the background (optional)
miru .               # open this folder without occupying the terminal
miru notes.md        # open this file in its own view
miru diff            # open this repository's changes
miru status          # show whether the resident server is running
miru stop            # stop the resident server
miru update          # fetch official main, build and switch to it
```

The first `miru <path>` starts the local server if needed. Browser tabs use
the same address (`http://127.0.0.1:41783/` by default) but retain their own folder
and selection. If the port is occupied, MIRU reports an error rather than silently
changing addresses. Use `MIRU_PORT` with a fixed value from 1024 to 65535 to choose
a different port; stop MIRU before changing it. The resident process keeps running
after the terminal closes but does not start at login or survive a WSL shutdown.
To open the literal filename `update`, use `miru -- update`. The `ev` alias is unchanged.

**Updating after a GitHub change:** run **`miru update`** from any directory. It
fetches only the official `koumatsumoto/miru` main branch, installs that commit's
locked build dependencies (`npm ci` with dev dependencies and no lifecycle
scripts) in a temporary worktree, and builds there. Once the new server starts
successfully, MIRU fast-forwards the **linked checkout** and switches servers.
A fetch, install, build, or startup failure leaves the old server and its tabs
running; your existing `dist` and `node_modules` are not replaced. After a
successful switch, reload the same tabs to use the new build. When migrating
from an older build that used a different port for each view, run `miru <path>`
once to open the new fixed address. If that exact build is already running,
another update keeps its tabs and skips the rebuild.
If saving the switch fails _after_ the fast-forward, local main stays advanced
and the old server stays live. Fix the reported permissions and rerun the same
command; there is no need to reset Git.

The linked checkout must be on clean `main` with an official HTTPS or SSH
`origin`. MIRU does not switch branches, reset, stash, or overwrite conflicting
ignored files. If you develop on a feature branch or want to test uncommitted
edits, run **`miru update --local`** instead: it rebuilds the linked working
tree with its installed dependencies, without fetching or installing anything.
Run `npm ci` yourself when changing that local checkout's build dependencies.
The prebuilt npm tarball has no source checkout and cannot self-update.

**One-time migration from the previous local-only `update` command:** in the
linked, clean official checkout on `main`, run the following once. The old
command builds the newly pulled sources; subsequent updates need only
`miru update` (no `npm link` again).

```sh
git pull --ff-only origin main && npm ci && miru update
```

Use `miru --foreground <path>` to run a single view until Ctrl+C. Direct
Windows Node uses foreground mode; use WSL for the local background workflow.
If automatic opening fails, open the printed launch link promptly in a new tab. The resident
launch link grants the browser access once, expires, and should not be shared.
`MIRU_NO_OPEN=1` (or `EV_NO_OPEN=1`) prints the launch link without opening a browser.
`miru --help` lists the commands.

In WSL, the CLI/server/Git and HOME are all Linux-side. The launcher uses Windows
PowerShell to open the loopback address in the Windows default browser. Explicit external
HTML opening converts the path with `wslpath -w`; failure is shown in the UI.
In WSL, CLI file arguments use Linux paths such as `/home/...` or `/mnt/c/...`;
native Windows drive paths are not automatically guessed or converted by the CLI.
WSL external-HTML paths are converted to Windows drive/UNC file URLs with quoted
PowerShell arguments. Command-construction tests cover Unicode, spaces and URL
metacharacters; they do not replace a real Windows/WSL launch test.
The viewer binds **127.0.0.1 only**. Use the printed address: the resident viewer
expects `127.0.0.1`; the standalone foreground viewer expects `localhost`. Both
reject other Host headers. If MIRU reports that another program owns the port,
do not navigate there expecting MIRU.

## Viewing

- With no argument, Miru opens the home directory in the regular file tree.
  An explicit path opens that file or folder. A nonexistent path produces an
  error; there is no ambiguous or single-match filename fallback.
- The compact HOME search in the center of the header searches as you type (two characters
  minimum). Use Down Arrow to reach the results; Escape clears the search.
- Regular browsing shows all files, with a per-file diff for Git changes.
  Launch with `miru diff` to show only changed paths and open diffs by default.
  Detecting a parent repository never silently widens the visible top.
  Both views are read-only, not an editor or a Git client.
- Light and dark GitHub-style colors follow the browser preference initially, with
  a manual toggle for this session. Document, code and diff colors change together.
  GFM tables, task lists (static checkmarks), strikethrough and fenced code are
  supported. Document links stay disabled to preserve the local safety boundary.
- Mermaid fences are rendered using bundled Mermaid Tiny into static PNG images.
  An opaque-origin temporary renderer receives only the diagram text and fixed
  theme settings, not the API session. Its CSP blocks network connections, external
  images/fonts and nested frames; only its nonce-authorized bundled code can run.
  Generated SVG is rasterized inside that isolated renderer and never parsed or
  attached by the main UI. The final document preview remains script-free.
  Expand **Mermaidソース** to read the original diagram text. Renderer errors leave
  the source visible. Author initialization directives/frontmatter are not accepted.
  Limits: 8 diagrams per document, 12,000 characters / 200 lines per diagram,
  150 edges, at most 4 million output pixels and a 5-second responsiveness timeout.
  The timeout is not a guarantee of CPU preemption. Navigation/theme changes cancel
  pending renderers. Tiny omits mindmap, architecture and KaTeX; interactive links,
  HTML labels and external icon/resource loading are not supported.
- Search HOME by a name or partial relative path, using at least two characters.
  Search waits briefly after input, skips `.git`, `node_modules`, and symlinks,
  and stops at 100 results, 30,000 entries, or approximately 1.8 seconds. Narrow a
  truncated search. A new query, including an empty/invalid one, invalidates old
  search results. It does not scan the whole disk.
- Click a folder to expand its children. The normal tree hides `.git` by default;
  uncheck **.git を除外** to show it. `node_modules` is not hidden by default. The funnel beside the folder heading filters the current tree by filename or
  relative path (not file contents), hides Git-ignored entries, or keeps only
  changes, including folders with changed descendants. Right-click a folder
  to open it in Explorer, use it as the top, or expand the visible nested folders.
  Right-click the top name to open it in Explorer or show one parent level (↑). Keyboard users can focus a folder
  and press Shift+F10 (or the Menu key), then Enter. Escape closes the menu and
  returns focus. Tab reaches files and the scrollable preview/diff panes; a skip
  link goes directly to the preview. Only navigating to a new top or parent
  changes the browsing scope.
- Drag the Explorer divider to resize the sidebar (desktop, 200px minimum). Focus the divider
  and use the arrow keys to resize or Home to go to the minimum. The preview stays blank until
  you select a file. Click a file for Preview, then choose Code or Diff. Markdown (GFM), isolated HTML,
  raster images, and PDF pages are supported. SVG is source-only. Text Code view
  is plain text, not an editor. Maximum individual file/resource/Git output size
  is **2 MiB**. Unsupported binaries and unavailable files show an explanation.
- Source files and Markdown code fences use offline syntax highlighting in the current
  light/dark theme. Supported languages include JSON, JavaScript, TypeScript, HTML/CSS,
  Python, Shell, YAML/TOML and SQL. Unknown or oversized source stays plain text.
- HTML/Markdown cannot run scripts, submit forms, navigate, or load external
  resources. Relative raster images and local CSS within the visible top work.
  CSS imports, URL-valued CSS, fonts, SVG resources, and active media are omitted.
  At most 40 image/stylesheet resources are considered per document. Preview links
  are disabled. To deliberately run an HTML file, use **Open HTML in external
  browser**. That external browser is outside MIRU's preview restrictions.
- PDF.js, its worker, CMaps, standard fonts, and WASM decoders are bundled. Pages are canvas-only, without annotation
  links, actions, JavaScript, XFA, or attachments. Enormous pages are rejected.
- Git changes, new files, deleted paths, and containing folders share one accent
  color. `miru diff` filters the same tree to changed paths. A top inside a repository detects the
  parent repository, but marks only paths below the visible top.
- Diff shows **unstaged: index → working tree** or **staged: HEAD → index**, with
  before on the left and after on the right. Untracked files are empty → current
  on the unstaged side. Deleted files, rename sources, unborn HEAD, binary content,
  and unmerged files are handled explicitly. A rename source outside the visible top
  is never read; it is displayed as an addition if that source is reported by Git. The viewer never stages,
  commits, saves, or updates the Git index.
- The lower-left gear opens Settings in the viewer. Light/dark is stored in
  `~/.miru/settings.json`, outside the viewed files. The lower right shows the app version and
  build revision when available. **最新に同期** in the Explorer context menu
  rereads the local Git status, file tree, and selected file without contacting a remote. In Windows/WSL, right-click a file
  and choose **エクスプローラーで開く** to select it in Explorer without running it.
  **編集する** opens a supported text file in Notepad on Windows/WSL or TextEdit
  on macOS. Miru does not edit or save the file itself.
  There is no filesystem watcher or automatic reload. Use **最新に同期** for changed
  documents; `miru update --local` rebuilds changes to MIRU itself.

## Security boundary

Each browser tab keeps its current top, selection and display mode. The server
validates filesystem requests against the supplied top for that operation. Scope
changes remain explicit; a symlink escaping the top is not followed as a resource.
A trusted UI can explicitly choose to browse a different accessible directory.

The API requires the exact Host/port, same Origin, and a random session header.
There is no CORS access, and the main UI rejects framing. HTML/Markdown previews
use a script-free opaque-origin sandbox and a restrictive CSP. Local preview
assets are validated and embedded as data, without the API session value. Git is
spawned without a shell; external diff/textconv are never invoked, fsmonitor is
disabled, and optional locks are disabled. Lazy fetching and all Git remote protocols
are disabled for viewer operations. Missing partial-clone objects show an error
instead of being fetched or misrepresented as an empty side of the diff.
Git status is disabled with an explanation when any clean/process filter is
configured (including Git LFS), because even status can execute such helpers.
Submodule working-tree inspection is disabled. Open a submodule explicitly to
view its files. These limits do not prevent ordinary file viewing. The server logs no file paths, tokens,
or file contents. Treat the terminal and the browser as trusted local clients.
The management socket and stable runtime credential are in the user's private
Unix runtime directory. The CLI passes a short-lived, single-use launch grant in
the browser's fragment, never in an HTTP URL sent to the server. The UI removes
the fragment and keeps its API credential and browsing state in tab session
storage so a reload after update works at the same address. The unauthenticated
resident HTML has no credential. This protects against websites and unauthenticated
local requests; it is not a boundary against software with the user's OS access.
Do not expose or reverse-proxy the service.

## Experimental Windows preview

The [C# / WinUI preview](native/README.md) is preserved as an experiment.
[The native migration](https://github.com/koumatsumoto/miru/issues/7) is not
planned; the browser viewer above is the primary MIRU.

## Development and verification

[Miru design system](docs/design-system.md) is the reference for the web viewer’s styles and interaction patterns. The [refactoring plan](docs/refactoring-plan.md) records module boundaries and compatibility checks.

The npm-local Vite+ CLI runs Vite, Vitest, Oxlint, Oxfmt, and tsdown (`vp pack`).
The `vite` npm alias is required by Vite+'s Vitest integration. TypeScript is
strict and pinned. No React, Express, Biome, or alternative package manager is used.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run check                 # all the above
npm audit --audit-level=low
node scripts/pack-smoke.mjs   # pack, install into temp dir, start packaged CLI
npm pack                     # distributable tarball, builds via prepack
```

Browser acceptance uses Python 3.12+, Playwright **1.62.0**, and Chromium. Install
those separately in a test environment, then run `npm run build && npm run test:browser`.
The test uses `/usr/bin/chromium` if present, otherwise Playwright's installed
Chromium; `CHROMIUM_PATH` overrides it. It creates only temporary local files,
starts a local receiver, and checks that document previews send it no requests.
CI runs type/lint/format/unit/build/audit/packed-install/browser checks on the
latest Node 24 and 26. The test never downloads a browser automatically.

```sh
python -m pip install playwright==1.62.0
python -m playwright install chromium
npm run test:browser
```

### Manual WSL/Windows acceptance still required

On Ubuntu WSL, run the CLI commands above and confirm Windows browser startup,
the home directory tree and live search, `/tmp`, file/folder entry, `miru diff`,
light/dark, both right-click actions, refresh, and
Ctrl+C. Run two viewers and confirm the same port and separate tab state;
update and reload both existing tabs. Select staged/unstaged,
untracked/deleted/rename, Japanese/space names, a partial repository subtree, and
Git-free folders. Try Markdown/HTML local images and CSS, blocked remote content,
PDF pages, symlinks outside the top, and an explicit external HTML open. Native
macOS/Windows launching and full OS-specific path behavior are not claimed verified.

## Layout and distribution

`src/cli.ts` handles startup; `src/server/` owns the filesystem, Git, preview asset
boundary and HTTP server. `src/web/` contains framework-free TypeScript/CSS/HTML.
`tests/` covers scope/HTTP/Git and browser flows. `scripts/` verifies packaging and
retains licenses. `dist/` is generated and ignored by Git.

The tarball contains `dist/cli.mjs`, built web assets, the PDF.js worker/CMaps/fonts/WASM, and full
third-party licenses. There are **no runtime npm dependencies** and no CDN use.
The viewer does not edit files in place or expose them for remote access. The
local resident service is supported; automatic filename guessing is not. Requirements: [issue #1](https://github.com/koumatsumoto/miru/issues/1), [viewer workflow #3](https://github.com/koumatsumoto/miru/issues/3).
