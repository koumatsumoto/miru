import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { detectRepository, ignoredNames, type GitChange } from "./git.js";
import { inside, UserError, type Workspace } from "./workspace.js";

interface SearchOptions {
  repo: string | null;
  changes: readonly GitChange[];
  excludeGit?: boolean;
  excludeIgnored: boolean;
  changedOnly: boolean;
}

interface SearchEntry {
  id: string;
  name: string;
  displayPath: string;
  directory: false;
  deleted: boolean;
  symlink: false;
  changed: boolean;
}

interface Folder {
  target: string;
  repo: string | null;
}

const entryLimit = 30_000;
const resultLimit = 150;
const pathKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const slash = (value: string) => value.split(path.sep).join("/");
const samePath = (a: string, b: string) => path.relative(a, b) === "";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function checkChange(root: string, change: GitChange): Promise<"file" | "deleted" | null> {
  try {
    if ((await lstat(change.path)).isFile() && samePath(change.path, await realpath(change.path)))
      return "file";
  } catch (error) {
    if (!missing(error) || !(change.indexStatus === "D" || change.worktreeStatus === "D"))
      return null;
    // Deleted paths may have several missing ancestors, but never issue an ID
    // for a path under a replaced or broken link.
    for (
      let parent = path.dirname(change.path);
      inside(root, parent);
      parent = path.dirname(parent)
    ) {
      try {
        const info = await lstat(parent);
        return info.isDirectory() && samePath(parent, await realpath(parent)) ? "deleted" : null;
      } catch (parentError) {
        if (!missing(parentError) || samePath(parent, root)) return null;
      }
    }
  }
  return null;
}

export async function searchTree(workspace: Workspace, query: string, options: SearchOptions) {
  const entries: SearchEntry[] = [];
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { entries, truncated: false };
  if (needle.length > 256) throw new UserError("検索文字列が長すぎます。");
  const portableNeedle = needle.replaceAll("\\", "/");
  const root = workspace.root;
  if (!root) throw new UserError("先にフォルダを開いてください。");
  const format = (target: string) => slash(path.relative(root, target));
  const matches = (target: string) => {
    const value = format(target).toLocaleLowerCase();
    return value.includes(portableNeedle) || value.includes(needle);
  };
  const changes = new Set<string>();
  const changedParents = new Set<string>();
  const seen = new Set<string>();
  const deadline = performance.now() + 1800;
  let visited = 0;
  let truncated = false;
  const overBudget = () => performance.now() >= deadline || entries.length >= resultLimit;
  function add(target: string, deleted: boolean) {
    if (seen.has(target)) return;
    if (entries.length >= resultLimit) {
      truncated = true;
      return;
    }
    seen.add(target);
    entries.push({
      id: workspace.id(target),
      name: path.basename(target),
      displayPath: format(target),
      directory: false,
      deleted,
      symlink: false,
      changed: changes.has(pathKey(target)),
    });
  }

  // Git status already provides the changed-only candidate paths. In the
  // ordinary mode it supplements the on-disk scan only for removed files.
  for (const [index, change] of options.changes.entries()) {
    if (index >= entryLimit || overBudget()) {
      truncated = true;
      break;
    }
    if (!inside(root, change.path) || samePath(root, change.path)) continue;
    if (options.excludeGit && format(change.path).split("/").includes(".git")) continue;
    const key = pathKey(change.path);
    changes.add(key);
    if (!options.changedOnly && options.excludeIgnored) {
      // Keep a folder with changed descendants even if a rule now ignores it.
      changedParents.add(key);
      for (
        let parent = path.dirname(change.path);
        !samePath(parent, root);
        parent = path.dirname(parent)
      ) {
        const parentKey = pathKey(parent);
        if (changedParents.has(parentKey)) break;
        changedParents.add(parentKey);
      }
    }
    if (!matches(change.path)) continue;
    if (!options.changedOnly && change.indexStatus !== "D" && change.worktreeStatus !== "D")
      continue;
    const kind = await checkChange(root, change);
    if (kind === "deleted" || (options.changedOnly && kind === "file"))
      add(change.path, kind === "deleted");
  }

  const repo = options.excludeIgnored && options.repo ? path.resolve(options.repo) : null;
  const queue: Folder[] = [{ target: root, repo }];
  // Group checks across nearby folders to avoid a Git process per folder or
  // per file. Prune an ignored directory before traversing its children.
  for (let cursor = 0; !options.changedOnly && cursor < queue.length;) {
    if (overBudget() || visited >= entryLimit) {
      truncated = true;
      break;
    }
    const end = Math.min(queue.length, cursor + 48);
    const groups = new Map<string, { repo: string; candidates: Map<string, () => void> }>();
    for (; cursor < end && !overBudget() && visited < entryLimit; cursor++) {
      const folder = queue[cursor];
      let { repo: owner } = folder;
      try {
        // Do not follow a symlink, even if the directory changed after it was
        // queued or if a link points elsewhere within this same scope.
        if (!samePath(folder.target, await realpath(folder.target))) continue;
        if (
          owner &&
          !samePath(owner, folder.target) &&
          !path.relative(owner, folder.target).split(path.sep).includes(".git")
        ) {
          const metadata = await lstat(path.join(folder.target, ".git")).catch(() => null);
          if (metadata?.isDirectory() || metadata?.isFile()) {
            const detected = await detectRepository(folder.target);
            if (detected && samePath(folder.target, detected)) owner = path.resolve(detected);
          }
        }
        for await (const dirent of await opendir(folder.target)) {
          if (++visited > entryLimit || overBudget()) {
            truncated = true;
            break;
          }
          if (options.excludeGit && dirent.name === ".git") continue;
          const target = path.join(folder.target, dirent.name);
          const directory = dirent.isDirectory();
          if (!directory && !(dirent.isFile() && matches(target))) continue;
          const include = () => {
            if (directory) queue.push({ target, repo: owner });
            else add(target, false);
          };
          if (!owner || (directory ? changedParents : changes).has(pathKey(target))) {
            include();
            continue;
          }
          const relative = slash(path.relative(owner, target));
          // The shared helper's literal index fallback expects immediate
          // names; wildcard/pathspec filenames are checked from their parent.
          const literal = /[?*[\\]/u.test(relative);
          const base = literal ? folder.target : owner;
          const candidate = literal ? dirent.name : relative;
          let group = groups.get(base);
          if (!group) {
            group = { repo: owner, candidates: new Map() };
            groups.set(base, group);
          }
          group.candidates.set(candidate, include);
        }
      } catch (error) {
        // A disappearing or unreadable folder should not erase other matches.
        if (!missing(error)) truncated = true;
      }
    }
    for (const [base, { repo: owner, candidates }] of groups) {
      if (overBudget()) {
        truncated = true;
        break;
      }
      const ignored = await ignoredNames(owner, base, [...candidates.keys()]);
      for (const [name, include] of candidates) if (!ignored.has(name)) include();
    }
  }
  entries.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  return { entries, truncated };
}
