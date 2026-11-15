# Native Core / CLI boundary

`Miru.Core` owns read-only file access and the current window's scope. `Miru.Cli`
parses a request and starts `Miru.App.exe` with an argument list, without a shell
or HTTP server. The WinUI project references the Core directly. No Rust, browser,
WebView, network client, package library or background daemon is needed by these
two projects.

The native viewer is **not feature parity** with the retained TypeScript viewer.
The App connects separate [Git](git-view.md), [Markdown](markdown-preview.md)
and [Mermaid](mermaid-preview.md) services; those features do not belong to
Core or CLI. These two projects run no Git commands or document renderers.
HTML, image and PDF preview remain migration work. Source text is not a completed
document preview. Actual Windows/WSL GUI and filesystem behavior require the
acceptance below, independently of compile and headless test results.

## Contract

- `LaunchArguments.Parse(args, cwd, home)` returns the target, HOME, initial mode
  and launcher state. `miru`, `miru <path>`, `miru diff` and `miru -- <literal path>`
  are supported. Relative paths use the explicit caller's working directory.
- `ViewerSession` is single-window and synchronous. The UI runs work off its UI
  thread and serializes calls. Only explicit Open, Home, Parent, Top and accepted
  search-result actions change the root. Tree calls take issued opaque IDs, not
  arbitrary path strings. Navigation and Refresh invalidate old IDs.
- List is limited to 10,000 entries with an explicit truncation flag. Normal
  browsing includes `.git` and `node_modules`. Search is submitted explicitly,
  limited to HOME, 100 results, 30,000 visited entries and an approximately
  1.8-second cooperative budget; it excludes those directories and links.
  The budget is checked before each folder, for each entry and after the final
  enumeration, including empty folders. A slow filesystem operation is not
  forcibly preempted by that budget; an over-budget final listing is marked partial.
- Reads use existing, read-only handles, verify ordinary-file type and final
  in-scope path, and cap bytes at 2 MiB even if the file grows. UTF-8 and BOM-marked
  UTF-16 text are decoded strictly; binary or undecodable content is identified.
- This MVP rejects links/junctions (including in-scope links) and linked ancestors
  rather than silently following them. Windows uses `OPEN_REPARSE_POINT` for the
  final open and `GetFinalPathNameByHandleW`; Linux tests use `O_NOFOLLOW`,
  `O_NONBLOCK`, `statx` and the opened descriptor path. A FIFO never waits for a
  writer. These checks are not an atomic filesystem sandbox against a hostile
  local process concurrently replacing ancestors. Other local programs are not
  an authentication boundary. The Linux reader is test support, not a shipped
  Linux GUI; macOS reader/GUI support is not claimed.

## Windows and WSL paths

Windows accepts explicit drive paths and the local WSL shares
`\\wsl.localhost\<distribution>\...` / `\\wsl$\<distribution>\...`.
Arbitrary UNC servers, mapped network drives, device namespaces/names, alternate
data streams and ambiguous trailing-dot/space aliases are rejected. The checks
do not claim that every OS namespace operation is race-free or causes zero
provider metadata traffic under concurrent hostile replacement.

When the **C# CLI runs under Linux .NET in WSL**, it keeps Linux cwd/HOME semantics and invokes the installed
`/usr/bin/wslpath -w` with a single absolute Linux path argument. Only validated
Windows/local-WSL output is forwarded. It does not infer `/mnt/<drive>` layouts,
select a different distribution or run Windows Git on a Linux repository.
Path conversion has a 3-second process deadline and bounded output; failures
are shown, not retried with another launcher. Set `MIRU_APP_PATH` to the explicit
installed Windows executable path visible from WSL, for example
`/mnt/c/Tools/MIRU/Miru.App.exe`. Native Windows normally finds that executable
beside its CLI, or uses the explicitly configured `MIRU_APP_PATH`.
Running the Windows `miru.exe` directly through WSL interop is not the Linux CLI
route and does not promise Linux HOME/cwd translation. Use the Linux CLI (for
example `dotnet <installed-Linux-CLI>/miru.dll <Linux-path>`) or an explicit WSL
UNC path in the native app. The Windows path parser rejects `/home/...` rather
than guessing `C:\home\...`. Linux CLI packaging/installation is a separate
distribution acceptance item, not proven by the Windows package build.

The CLI exits after starting a window. Close the window to stop that viewer;
there is no loopback server for Ctrl+C to stop. A successful CLI start is not
proof the window finished loading its target.

## Verification

With a .NET 10 **SDK**, from the repository root:

```sh
dotnet build native/tests/Miru.Core.Tests/Miru.Core.Tests.csproj -m:1
dotnet run --project native/tests/Miru.Core.Tests/Miru.Core.Tests.csproj --no-build
dotnet run --project native/src/Miru.Cli/Miru.Cli.csproj -- --help
```

The dependency-free executable self-test uses only generated temporary fixtures.
`MIRU_TEST_TMPDIR` can select a private test directory. Symbolic-link cases report
a skip when the Windows account cannot create test links; that is not a pass.
The initial Linux run passed 55 cases including real file/symlink/FIFO fixtures
and pure Windows/WSL syntax/argv cases. This does not validate Windows P/Invoke,
WSL interop or WinUI. No speed claim is derived from these small tests.

### Outstanding real-machine acceptance

1. Build on Windows with .NET 10 SDK and the WinUI toolchain. Run no-argument,
   relative folder, explicit file, Unicode/space/apostrophe, `-- diff`, missing
   path, two windows, Close, and repeated navigation/Refresh. Verify unchanged
   source bytes and no file/index mutation.
2. From the chosen WSL distribution, launch `/home/...` and `/mnt/c/...` file and
   folder arguments. Confirm Linux HOME and the exact distribution are retained,
   tree expansion/read/top/search work, and permission failures are actionable.
   Do not treat pure UNC parsing as this test.
3. Measure initial and repeated folder/file reads on a representative large WSL
   repository, including many children, inaccessible entries and truncation.
   Record cold/warm latency and UI responsiveness; cross-filesystem metadata
   costs must be measured rather than inferred from C# or native controls.
4. Verify drive-letter casing, case-sensitive Windows/WSL sibling names, root
   paths, junction/symlink rejection, mapped network drive rejection, deletion
   and replacement after listing. No arbitrary network share should be opened.
5. With permission to manage a disposable test distro, observe stopped-distro
   behavior, failure/recovery and close responsiveness. Do not stop a user's
   running distro just for a test. OS share access may start a distro; that side
   effect and its latency are not yet verified here.
6. When a WSL Git bridge is implemented, test Linux-side Git independently,
   preserving no lazy fetch/helper execution/index writes and visible-top scope.
   Neither this milestone nor Windows Git on UNC is a substitute for that test.

Primary implementation references: [Microsoft WSL interop](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop),
[Windows final-handle paths](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew),
[.NET link/junction semantics](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.resolvelinktarget?view=net-10.0),
and [Linux statx](https://man7.org/linux/man-pages/man2/statx.2.html).
