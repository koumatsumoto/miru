import { afterEach, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { searchTree } from "../src/server/tree-search.js";
import { Workspace } from "../src/server/workspace.js";

const tempRoots: string[] = [];
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const defaultOptions = { repo: null, changes: [], excludeIgnored: false, changedOnly: false };
async function setup() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "miru-tree-search-")));
  tempRoots.push(home);
  const root = path.join(home, "scope");
  await mkdir(root);
  const workspace = new Workspace(home);
  await workspace.open(root);
  return { home, root, workspace };
}

async function put(root: string, name: string, text = "") {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

function git(root: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-C", root, "-c", "user.name=MIRU test", "-c", "user.email=test@example.test", ...args],
    {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_COUNT: "0",
      },
      encoding: "utf8",
    },
  );
}

it("matches file names and relative paths recursively without reading content or changing scope", async () => {
  const { home, root, workspace } = await setup();
  await put(root, "src/NESTED/資料.md");
  await put(root, "top.txt", "nested/資料");
  await put(home, "src/NESTED/outside.md");
  await mkdir(path.join(root, "src", "NESTED", "empty"));
  const result = await searchTree(workspace, " nested\\資 ", defaultOptions);
  expect(result).toEqual({
    entries: [
      {
        id: workspace.id(path.join(root, "src", "NESTED", "資料.md")),
        name: "資料.md",
        displayPath: "src/NESTED/資料.md",
        directory: false,
        deleted: false,
        symlink: false,
        changed: false,
      },
    ],
    truncated: false,
  });
  expect(await workspace.resolve(result.entries[0].id)).toBe(
    path.join(root, "src", "NESTED", "資料.md"),
  );
  expect(workspace.root).toBe(root);
  expect((await searchTree(workspace, "資", defaultOptions)).entries).toEqual(result.entries);
  expect(await searchTree(workspace, "資", { ...defaultOptions, excludeIgnored: true })).toEqual(
    result,
  );
  expect(await searchTree(workspace, " \t ", defaultOptions)).toEqual({
    entries: [],
    truncated: false,
  });
  await expect(searchTree(workspace, "x".repeat(257), defaultOptions)).rejects.toThrow("長すぎ");
});

it.skipIf(process.platform === "win32")(
  "does not visit symlinks or expose changed paths outside the scope",
  async () => {
    const { home, root, workspace } = await setup();
    await put(home, "elsewhere/hit.md");
    await put(root, "inside/hit.md");
    await symlink(path.join(home, "elsewhere"), path.join(root, "escape"));
    await symlink(path.join(root, "inside"), path.join(root, "alias"));
    await symlink(path.join(root, "inside", "hit.md"), path.join(root, "hit-alias.md"));
    await symlink(path.join(home, "missing"), path.join(root, "broken"));
    const change = (target: string, worktreeStatus: string) => ({
      path: path.join(root, target),
      indexStatus: " ",
      worktreeStatus,
    });
    const changes = [
      change("../elsewhere/hit.md", "M"),
      change("escape/hit.md", "M"),
      change("alias/hit.md", "M"),
      change("hit-alias.md", "M"),
      change("broken/deep/hit.md", "D"),
      change("removed/deep/hit.md", "D"),
      change("inside/hit.md", "M"),
    ];
    for (const changedOnly of [false, true]) {
      const options = { ...defaultOptions, changes, changedOnly };
      const result = await searchTree(workspace, "hit", options);
      expect(
        result.entries.map((entry) => [entry.displayPath, entry.changed, entry.deleted]),
      ).toEqual([
        ["inside/hit.md", true, false],
        ["removed/deep/hit.md", true, true],
      ]);
    }
  },
);

it("composes ignore and changed-only filters, preserving tracked files and removed paths", async () => {
  const { home, root, workspace } = await setup();
  // Current folder is one level below the repository root, not the same root.
  git(home, "init", "-q");
  await put(root, "scoped/keep-hit.log", "original");
  await put(root, "scoped/gone/hit.log", "original");
  await put(root, "scoped/static-hit.log", "original");
  await put(root, "keep/hit.ts", "original");
  git(home, "add", ".");
  git(home, "commit", "-qm", "base");
  await put(home, ".gitignore", "*.log\nnode_modules/\n!keep-hit.log\n");
  await put(root, "scoped/.gitignore", "tmp/\n");
  await put(root, "scoped/temp-hit.log");
  await put(root, "scoped/tmp/hit.ts");
  await put(root, "node_modules/pkg/hit.ts");
  await put(root, "scoped/work-hit.ts", "new");
  await put(root, "scoped/keep-hit.log", "modified");
  git(home, "rm", "-q", "scope/scoped/gone/hit.log");
  // Explicit synthetic status, so system filters such as CI's Git LFS do not
  // affect this search fixture. Real ignore rules are still read by Git.
  const opts = {
    ...defaultOptions,
    repo: home,
    changes: [
      { path: path.join(root, "scoped/gone/hit.log"), indexStatus: "D", worktreeStatus: " " },
      { path: path.join(root, "scoped/keep-hit.log"), indexStatus: " ", worktreeStatus: "M" },
      { path: path.join(root, "scoped/work-hit.ts"), indexStatus: "?", worktreeStatus: "?" },
    ],
  };
  expect((await searchTree(workspace, "hit", opts)).entries).toHaveLength(8);
  expect(
    (await searchTree(workspace, "hit", { ...opts, excludeIgnored: true })).entries.map((entry) => [
      entry.displayPath,
      entry.changed,
      entry.deleted,
    ]),
  ).toEqual([
    ["keep/hit.ts", false, false],
    ["scoped/gone/hit.log", true, true],
    ["scoped/keep-hit.log", true, false],
    ["scoped/static-hit.log", false, false],
    ["scoped/work-hit.ts", true, false],
  ]);
  expect(
    (await searchTree(workspace, "hit", { ...opts, excludeIgnored: true, changedOnly: true }))
      .entries,
  ).toHaveLength(3);
});

it.skipIf(process.platform === "win32")(
  "handles paths containing wildcard syntax literally",
  async () => {
    const { root, workspace } = await setup();
    git(root, "init", "-q");
    await put(root, "dir[a]/old.log");
    await put(root, "dir[a]/a.log");
    git(root, "add", ".");
    await put(root, ".gitignore", "*.log\n");
    await put(root, "dir[a]/*.log");
    await put(root, "dira/untracked.log");
    const opts = { ...defaultOptions, repo: root, excludeIgnored: true };
    expect(
      (await searchTree(workspace, ".log", opts)).entries.map((entry) => entry.displayPath),
    ).toEqual(["dir[a]/a.log", "dir[a]/old.log"]);
  },
);

it("batches repository-relative candidates without mixing parent and submodule rules", async () => {
  const { root, workspace } = await setup();
  git(root, "init", "-q");
  await put(root, ".gitignore", "blocked-*.ts\n");
  const inner = path.join(root, "module");
  await mkdir(inner);
  git(inner, "init", "-q");
  await put(inner, ".gitignore", "hidden-*.ts\n");
  await put(inner, "blocked-hit.ts");
  git(inner, "add", ".");
  git(inner, "commit", "-qm", "nested fixture");
  const revision = git(inner, "rev-parse", "HEAD").trim();
  git(root, "update-index", "--add", "--cacheinfo", `160000,${revision},module`);
  await put(inner, "hidden-hit.ts");
  for (let count = 0; count < 70; count++) {
    await put(root, `parent-${count}/blocked-hit.ts`);
  }
  const opts = { ...defaultOptions, repo: root, excludeIgnored: true };
  expect(
    (await searchTree(workspace, "hit", opts)).entries.map((entry) => entry.displayPath),
  ).toEqual(["module/blocked-hit.ts"]);
});

it("limits large results while keeping a complete short result untruncated", async () => {
  const { root, workspace } = await setup();
  for (let i = 0; i < 170; i++) await put(root, `batch/hit-${i}.txt`);
  const large = await searchTree(workspace, "hit", defaultOptions);
  expect(large.truncated).toBe(true);
  expect(large.entries).toHaveLength(150);
  const small = await searchTree(workspace, "hit-42.txt", defaultOptions);
  expect(small.truncated).toBe(false);
  expect(small.entries).toHaveLength(1);
});
