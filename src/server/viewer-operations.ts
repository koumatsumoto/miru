import { isUtf8 } from "node:buffer";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { absolutePath, Workspace, UserError } from "./workspace.js";
import {
  listDirectory,
  readContent,
  openSearchResult,
  searchHome,
  mediaType,
  readRegular,
} from "./files.js";
import { detectRepository, getStatus, ignoredNames, readDiff, type GitChange } from "./git.js";
import { localResource } from "./preview.js";
import { searchTree } from "./tree-search.js";
import { readPreferences, setThemePreference } from "./preferences.js";
import { editFile, EditorError, openBrowser, openDirectory, revealFile } from "./browser.js";

export interface ViewerOptions {
  target?: string;
  diff?: boolean;
  home?: string;
  opener?: (target: string, isFile?: boolean) => Promise<void>;
  directoryOpener?: (target: string) => Promise<void>;
  revealer?: (target: string) => Promise<void>;
  editor?: (target: string) => Promise<void>;
}

interface TabContext {
  root: string | null;
  selected: string | null;
  diffMode: boolean;
}
function tabContext(value: unknown): TabContext | null {
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("root" in value) ||
    !(value.root === null || typeof value.root === "string") ||
    !("selected" in value) ||
    !(value.selected === null || typeof value.selected === "string") ||
    !("diffMode" in value) ||
    typeof value.diffMode !== "boolean"
  )
    throw new UserError(
      "表示情報が不正です。検索欄か、ターミナルの miru <path> から開き直してください。",
    );
  return {
    root: value.root,
    selected: value.selected,
    diffMode: value.diffMode,
  };
}
async function repositoryState(root: string) {
  const repo = await detectRepository(root);
  let changes: GitChange[] = [];
  let gitMessage: string | null = null;
  try {
    if (repo) changes = await getStatus(repo, root);
  } catch (error) {
    gitMessage =
      error instanceof UserError
        ? error.message
        : "Git状態を取得できません。ファイル閲覧は利用できます。";
  }
  return { repo, changes, gitMessage };
}
async function state(workspace: Workspace, diffMode: boolean, selectedId?: string | null) {
  const root = workspace.root!;
  const { repo, changes, gitMessage } = await repositoryState(root);
  if (selectedId) {
    // A deleted Git file remains selectable in diff mode; a missing file or
    // escaping link must not prevent the rest of a tab from being restored.
    try {
      const target = await workspace.resolve(selectedId, true);
      const info = await lstat(target).catch(() => null);
      if (info?.isFile() || (!info && changes.some((change) => change.path === target)))
        workspace.selected = workspace.entryPath(selectedId);
    } catch {
      /* stale selection */
    }
  }
  return {
    root: {
      id: workspace.id(root),
      name: path.basename(root) || root,
      displayPath: root,
      canParent: path.dirname(root) !== root,
    },
    selected: workspace.selected
      ? { id: workspace.id(workspace.selected), name: path.basename(workspace.selected) }
      : null,
    repository: repo ? path.basename(repo) : null,
    gitMessage,
    diffMode,
    changeCount: changes.length,
  };
}
async function editablePath(workspace: Workspace, id: unknown): Promise<string> {
  const target = await workspace.resolve(id);
  const original = await lstat(target);
  if (!original.isFile()) throw new UserError("通常のファイルを選んでください。");
  const textOnly = () => new UserError("編集できるのはUTF-8のテキストファイルだけです。");
  const mime = mediaType(target);
  if (mime === "application/pdf" || (mime.startsWith("image/") && mime !== "image/svg+xml"))
    throw textOnly();
  const bytes = await readRegular(target, undefined, workspace.root!).catch((error: unknown) => {
    if (error instanceof UserError) throw error;
    throw new UserError("ファイルを読めません。アクセス権を確認し、フォルダを更新してください。");
  });
  if (
    !isUtf8(bytes) ||
    bytes.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
  )
    throw textOnly();
  // The editor opens the original by path, so revalidate the entry and
  // checked file just before handoff rather than trusting the previous listing.
  const fresh = await workspace.resolve(id);
  const current = await lstat(fresh);
  if (
    fresh !== target ||
    !current.isFile() ||
    original.ino !== current.ino ||
    original.dev !== current.dev ||
    original.size !== current.size ||
    original.mtimeMs !== current.mtimeMs ||
    original.ctimeMs !== current.ctimeMs
  )
    throw new UserError("ファイルが変わりました。更新して再度選んでください。");
  return fresh;
}
// HTTP authenticates the caller before dispatch. Every operation then
// restores and validates its own workspace rather than sharing tab state.
export function createViewerOperation(options: ViewerOptions, idKey: Buffer) {
  const home = options.home ?? homedir();
  const opener = options.opener ?? openBrowser;
  const openFolder = options.directoryOpener ?? openDirectory;
  const reveal = options.revealer ?? revealFile;
  const edit = options.editor ?? editFile;
  return async function operation(body: Record<string, unknown>) {
    const workspace = new Workspace(home, idKey);
    const context = tabContext(body.context);
    if (body.diffMode !== undefined && typeof body.diffMode !== "boolean")
      throw new UserError("表示モードが不正です。");
    const diffMode = context?.diffMode ?? body.diffMode ?? options.diff ?? false;
    // HOME navigation/search must still work when a tab's former root vanished.
    switch (body.op) {
      case "preferences":
        return readPreferences(home);
      case "set-theme":
        return setThemePreference(home, body.theme);
      case "home":
        await workspace.openHome();
        return state(workspace, false);
      case "search":
        return searchHome(workspace, typeof body.query === "string" ? body.query : "");
      case "openSearch":
        await openSearchResult(workspace, body.id);
        return state(workspace, false);
    }
    if (body.op === "state" && (body.target !== undefined || !context?.root)) {
      // Only an authenticated explicit launch can establish a new arbitrary root.
      const target = body.target !== undefined ? absolutePath(body.target) : options.target;
      if (target !== undefined) await workspace.open(target);
      else await workspace.openHome();
      return state(workspace, diffMode);
    }
    if (!context?.root) throw new UserError("先にフォルダを開いてください。");
    await workspace.restoreRoot(context.root);
    switch (body.op) {
      case "state":
      case "refresh":
        return state(workspace, diffMode, context.selected);
      case "openEntry":
        await workspace.open(await workspace.resolve(body.id), workspace.root!);
        return state(workspace, diffMode);
      case "list": {
        if (body.excludeIgnored !== undefined && typeof body.excludeIgnored !== "boolean")
          throw new UserError("除外フィルターの指定が不正です。");
        const target = await workspace.resolve(body.id, true);
        const { repo, changes, gitMessage } = await repositoryState(workspace.root!);
        let entries = await listDirectory(workspace, target, changes);
        if (body.excludeIgnored && repo) {
          // Keep changed paths, including staged deletions and their parents,
          // even if their former names now match an ignore rule.
          const candidates = entries.filter((entry) => !entry.changed);
          const ignored = await ignoredNames(
            repo,
            target,
            candidates.map((entry) => entry.name),
            new Set(
              candidates
                .filter((entry) => entry.directory && !entry.symlink)
                .map((entry) => entry.name),
            ),
          );
          entries = entries.filter((entry) => !ignored.has(entry.name));
        }
        return { entries, ...(gitMessage ? { gitMessage } : {}) };
      }
      case "tree-search": {
        if (
          typeof body.query !== "string" ||
          (body.excludeGit !== undefined && typeof body.excludeGit !== "boolean") ||
          typeof body.excludeIgnored !== "boolean" ||
          typeof body.changedOnly !== "boolean"
        )
          throw new UserError("絞り込みの指定が不正です。");
        const { repo, changes, gitMessage } = await repositoryState(workspace.root!);
        const result = await searchTree(workspace, body.query, {
          repo,
          changes,
          excludeGit: body.excludeGit === true,
          excludeIgnored: body.excludeIgnored,
          changedOnly: body.changedOnly && !gitMessage,
        });
        return { ...result, ...(gitMessage ? { gitMessage } : {}) };
      }
      case "parent":
        await workspace.parent();
        return state(workspace, diffMode);
      case "top":
        await workspace.top(body.id);
        return state(workspace, diffMode);
      case "read":
        return readContent(await workspace.resolve(body.id), workspace.root!);
      case "resource":
        return localResource(workspace, body.id, body.reference);
      case "diff": {
        if (body.stage !== "staged" && body.stage !== "unstaged")
          throw new UserError("比較対象を選んでください。");
        const target = await workspace.resolve(body.id, true);
        const { repo, changes, gitMessage } = await repositoryState(workspace.root!);
        if (!repo || gitMessage)
          return {
            before: "",
            after: "",
            binary: false,
            message: gitMessage ?? "表示中のフォルダはGit管理外です。",
          };
        return readDiff(repo, target, body.stage, changes, workspace.root!);
      }
      case "edit": {
        const target = await editablePath(workspace, body.id);
        try {
          await edit(target);
        } catch (error) {
          throw new UserError(
            error instanceof EditorError
              ? error.message
              : "テキストエディターを起動できません。OSの設定を確認してください。",
          );
        }
        return { ok: true };
      }
      case "open-folder": {
        const target = await workspace.resolve(body.id);
        if (!(await lstat(target)).isDirectory()) throw new UserError("フォルダを選んでください。");
        try {
          await openFolder(target);
        } catch {
          throw new UserError(
            "フォルダを開けません。ファイルマネージャーが利用できるか確認してください。",
          );
        }
        return { ok: true };
      }
      case "external":
      case "reveal": {
        const target = await workspace.resolve(body.id);
        if (!(await lstat(target)).isFile())
          throw new UserError("通常のファイルを選んでください。");
        if (body.op === "reveal") {
          try {
            await reveal(target);
          } catch {
            throw new UserError(
              "ファイルの場所を開けません。ファイルマネージャーが利用できるか確認してください。",
            );
          }
        } else {
          if (mediaType(target) !== "text/html")
            throw new UserError("外部ブラウザで開けるのは通常のHTMLファイルだけです。");
          await opener(target, true);
        }
        return { ok: true };
      }
      default:
        throw new UserError("不明な操作です。");
    }
  };
}
