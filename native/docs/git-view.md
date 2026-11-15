# Native read-only Git service

`Miru.Git` is independent of the WinUI shell and the CLI. It references the existing `Miru.Core` public contract and does not change it. The native Repository view uses status and the two text sides. This is not Windows/WSL GUI or performance acceptance.

## Contract

```csharp
var repository = await GitRepository.OpenAsync(topPath, cancellationToken);
var status = await repository.RefreshAsync(cancellationToken);
var diff = await repository.ReadDiffAsync(change.Id, GitStage.Staged, cancellationToken);
```

Call serially, as with `ViewerSession`. Root and selected top stay fixed for this instance. Only changes inside the top are returned. `GitChange.Id` is opaque and expires at every refresh, including a failed refresh. Paths are labels, not authority to request arbitrary Git objects. Staged is HEAD → index; unstaged is index → working file, or empty → untracked. Conflict, binary/non-UTF-8, absent entry, unsupported file type and missing object are distinct outcomes. A rename source outside the current top is not read. The before/after contents are live reads, not an atomic snapshot of another process changing the repository.

The UI owns rendering. It must keep stage labels and `Message`/`Notice`, handle `IOException`, and pass its lifetime cancellation token. No Git process is needed in ordinary Files mode.

## Native view

Switch **Files / Repository** at the current top. Repository groups changes by folder, shows Git's index/worktree status pair, and provides **Staged** (HEAD → index) and **Unstaged** (index → working file). The buttons select a comparison only; they never stage files. Use **Files → Use selected folder as top → Repository** to narrow a repository view. Parent, HOME, Open and Refresh remain explicit navigation actions. Refresh and mode/top changes clear the selected diff, so expired IDs do not silently retain an old comparison.

**Changes** shows `−`/`+` markers, both line-number columns and theme-aware backgrounds in a virtualized native list. **Versions** keeps the two full, read-only text sides available for selection/copying. It is a line-level comparison, not Git's exact hunk algorithm or an intra-line character diff. Both modes render strings only; HTML, URLs and XAML are not interpreted. Conflicts, binary/non-UTF-8, missing objects and unsupported paths retain the service's explicit explanation rather than becoming an empty diff.

The display takes at most 3,000 change entries; additional entries are reported and users can choose a narrower top. Line highlighting has a 6,000-line-per-side / 10,000-row / one-million-matrix-cell bound, after trimming common prefix/suffix. A comparison over this budget falls back to both complete text versions, not a truncated diff. CRLF is normalized for highlighted rows with an explicit notice; end-of-file newline differences are noted. Versions is a text control, not a byte/hex viewer. The fixed Git content caps still apply. Large change sets, narrow widths, tab/scroll behavior, Narrator and theme switching require actual Windows UI acceptance.

A Git error leaves ordinary Files browsing available. No Git process is started in Files mode. UI work is serialized off the UI thread, repeated actions do not create a queue, and closing cancels known Git children and prevents late window updates. Slow filesystem calls are not a hard-real-time cancellation guarantee.

## Local-only and read-only controls

- Uses an absolute Git executable found in an absolute PATH entry, with `ProcessStartInfo.ArgumentList`, no shell and closed stdin. No install, config write, staging, checkout, commit, fetch, push, or repository mutation command is provided by the service.
- Clears inherited Git repository/index/object/trace/config-parameter overrides. Preserves explicit config-file overrides so their filter definitions are not silently ignored. Optional locks, lazy fetch, transport protocols, fsmonitor, submodule recursion/summary, automatic maintenance, pager, and external diff are disabled for each command. Git must support `--no-lazy-fetch`; older Git is an error, not a relaxed fallback.
- Reads config **without following includes**, then refuses clean/process filters, includes and custom worktree/attribute/ignore file settings before status. This conservative first stage also refuses an unused global filter (for example a global LFS filter). It does not pretend to reproduce helper-based transformations. Files view remains available.
- Reads raw `ls-tree`/`ls-files` metadata and `cat-file blob`, not `git diff`, textconv, external diff or smudge. Regular-file modes only. An unborn branch is distinguished from a damaged HEAD; an absent path is distinguished from a missing referenced object.
- Uses Core's regular-file, reparse and final-handle checks for working files. Before a public operation starts Git, the metadata roots (including linked-worktree/common roots) are inspected without descending through reparse entries. This scan is limited to 30,000 entries, 64 nested levels and two seconds between OS calls; a link or budget limit refuses Git view, not a partial result. It covers loose objects, packs, refs and info children, not just their parent directories. Local linked worktrees are supported, while alternate object stores are refused. Ordinary UNC/WSL paths are rejected before Git starts. Windows Git is never intentionally used as a WSL Git bridge.
- Each child command has a 6-second deadline, 2 MiB stdout and 64 KiB stderr limits, cancellation and process-tree termination. Working files retain Core's 2 MiB limit. Cap failures do not show truncated content as a complete diff. These are per-command/output limits, not a total operation memory bound or hard real-time guarantee for OS filesystem calls or process termination.

Standard global config/attribute/ignore paths derived from HOME/XDG, explicit config overrides, and standard system locations are checked for static reparse entries before each child. Windows supports the usual Git for Windows installer/portable `cmd`/`bin` layout (including `mingw64/bin`); other `git.exe` layouts are refused. Legacy ProgramData config is checked defensively. These paths are not discovered with `git var`: that command itself loads config before returning its path value. The executable/standard installation layout remains trusted. Arbitrary custom-compiled Git configuration locations are not certified, and defaults are not silently replaced with an empty configuration to make a test pass.

These controls avoid the known helper/fetch side effects in the tested workflows. They are not an OS sandbox against a hostile same-user process concurrently replacing configuration, metadata or executable files. Standard Git may read OS/user configuration and filesystem metadata; this is not a claim that every OS/provider operation has been traced or that all filesystem/network configurations are supported.

## Verification and remaining work

Dependency-free finite tests create **only synthetic local repositories**, including a `file://` partial clone for setup. Product reads do not fetch that clone's missing blob; the retained object-store bytes stay unchanged. Tests cover staged/unstaged/rename/deletion/untracked/Unicode/subtree, unborn/conflict/binary/large content, helper/filter refusal, local worktree, linked paths, unchanged index, opaque IDs, missing objects, sanitized argv/environment, child output caps, cancellation and deadline. The cap/deadline children are the known test program, not arbitrary commands supplied to the public API.

```bash
dotnet run --project native/tests/Miru.Git.Tests/Miru.Git.Tests.csproj -c Release
```

Windows uses the same managed contract, but Windows Git/native handle branches must pass Windows CI and real-machine acceptance independently. Symlink fixture creation may be explicitly skipped without Windows privilege. The Linux-only pathspec punctuation filename is not claimed legal on Windows. No GUI pixel/performance or WSL Git test is represented by the Linux suite. The metadata scan is deliberately finite and can make a repository with many loose objects unsupported; large-repository latency and practical limits remain real-machine acceptance, not a speed claim. WSL Git remains a required later, separate design with explicit distro/argv and no silent Windows Git fallback.

Primary references: [Git command/environment options](https://git-scm.com/docs/git), [status porcelain and optional index refresh](https://git-scm.com/docs/git-status), [configuration/includes](https://git-scm.com/docs/git-config), [attributes and filters](https://git-scm.com/docs/gitattributes), [ls-files](https://git-scm.com/docs/git-ls-files), [ls-tree](https://git-scm.com/docs/git-ls-tree), [cat-file](https://git-scm.com/docs/git-cat-file). Checked 2026-11-15. The safety policy and unsupported-case choices above are MIRU design decisions, not claims that Git itself is an untrusted-repository sandbox.
