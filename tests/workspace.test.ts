import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/server/workspace";
import { listDirectory, openSearchResult, readRegular, searchHome } from "../src/server/files";
import { localResource } from "../src/server/preview";
const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ev-scope-"));
  dirs.push(root);
  await mkdir(path.join(root, "visible"));
  await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "visible", "file.md"), "hello");
  await writeFile(path.join(root, "outside", "secret"), "private");
  const ws = new Workspace(root);
  await ws.open(path.join(root, "visible"));
  return { root, ws };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("explicit scope and bounded files", () => {
  it("rejects guessed IDs, absolute paths, symlink escapes and old IDs after top changes", async () => {
    const { root, ws } = await fixture();
    const old = ws.id(path.join(root, "visible", "file.md"));
    await expect(ws.resolve("/etc/passwd")).rejects.toThrow();
    await expect(ws.resolve(ws.id(path.join(root, "outside", "secret")))).rejects.toThrow();
    await symlink(path.join(root, "outside"), path.join(root, "visible", "escape"));
    await expect(
      ws.resolve(ws.id(path.join(root, "visible", "escape", "secret"))),
    ).rejects.toThrow();
    await ws.parent();
    await expect(ws.resolve(old)).rejects.toThrow();
    expect(ws.root).toBe(root);
  });
  it("supports file entry, outside-HOME explicit targets, parent and top", async () => {
    const { root } = await fixture();
    const ws = new Workspace(path.join(root, "visible"));
    await ws.openHome();
    await ws.open(path.join(root, "outside", "secret"));
    expect(ws.selected).toBe(path.join(root, "outside", "secret"));
    expect(ws.root).toBe(path.join(root, "outside"));
    await ws.parent();
    await ws.top(ws.id(path.join(root, "visible")));
    expect(ws.root).toBe(path.join(root, "visible"));
  });
  it("search excludes .git and node_modules but directory browsing does not", async () => {
    const { root, ws } = await fixture();
    for (const excluded of [".git", "node_modules"]) {
      await mkdir(path.join(root, "visible", excluded));
      await writeFile(path.join(root, "visible", excluded, "findme"), "hidden");
    }
    await writeFile(path.join(root, "visible", "findme.md"), "found");
    const found = await searchHome(ws, "findme");
    expect(found.results.map((result) => result.name)).toEqual(["findme.md"]);
    const entries = await listDirectory(ws, ws.root!, []);
    expect(entries.map((entry) => entry.name)).toContain(".git");
    expect(entries.map((entry) => entry.name)).toContain("node_modules");
    await expect(ws.resolve(found.results[0].id)).rejects.toThrow();
    await openSearchResult(ws, found.results[0].id);
    expect(ws.selected).toBe(path.join(root, "visible", "findme.md"));
  });
  it("limits reads and rejects directories/symlinks outside scope", async () => {
    const { root, ws } = await fixture();
    await expect(readRegular(root)).rejects.toThrow();
    await expect(readRegular(path.join(root, "visible", "file.md"), 2)).rejects.toThrow();
    await symlink(path.join(root, "outside", "secret"), path.join(root, "visible", "leak"));
    await expect(readRegular(path.join(root, "visible", "leak"), 100, ws.root!)).rejects.toThrow();
    expect(await readFile(path.join(root, "outside", "secret"), "utf8")).toBe("private");
  });
  it("resolves local raster/CSS only inside scope, never external URLs or SVG", async () => {
    const { root, ws } = await fixture();
    await writeFile(path.join(root, "visible", "style.css"), "body {color:red}");
    const id = ws.id(path.join(root, "visible", "file.md"));
    expect((await localResource(ws, id, "style.css")).mime).toBe("text/css");
    for (const reference of [
      "https://example.com/x",
      "//example.com/x",
      "/etc/passwd",
      "../outside/secret",
      "%2fetc/passwd",
      "data:image/svg+xml,x",
      "\\outside",
    ])
      await expect(localResource(ws, id, reference)).rejects.toThrow();
    await writeFile(path.join(root, "visible", "x.svg"), "<svg/>");
    await expect(localResource(ws, id, "x.svg")).rejects.toThrow();
  });
});

it("rejects a missing Git path when its ancestor is replaced by an out-of-scope symlink", async () => {
  const { root, ws } = await fixture();
  const folder = path.join(root, "visible", "nested");
  await mkdir(folder);
  const id = ws.id(path.join(folder, "missing", "deleted.txt"));
  expect(await ws.resolve(id, true)).toBe(path.join(folder, "missing", "deleted.txt"));
  await rename(folder, path.join(root, "visible", "old-nested"));
  await symlink(path.join(root, "outside"), folder);
  await expect(ws.resolve(id, true)).rejects.toThrow("表示範囲外");
});

it("revalidates a search result when an ancestor changes into a symlink outside HOME", async () => {
  const { root } = await fixture();
  const home = path.join(root, "visible");
  const nested = path.join(home, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "report.txt"), "public");
  await writeFile(path.join(root, "outside", "report.txt"), "private");
  const ws = new Workspace(home);
  await ws.openHome();
  const found = await searchHome(ws, "report");
  expect(found.results).toHaveLength(1);
  await rename(nested, path.join(home, "old-nested"));
  await symlink(path.join(root, "outside"), nested);
  await expect(openSearchResult(ws, found.results[0].id)).rejects.toThrow("HOMEの範囲外");
  expect(ws.root).toBe(home);
  expect(ws.selected).toBeNull();
});

it("keeps independent tab searches usable without a server-side result map", async () => {
  const { ws, root } = await fixture();
  const found = await searchHome(ws, "secret");
  expect(found.results).toHaveLength(1);
  expect((await searchHome(ws, "x")).results).toEqual([]);
  await expect(searchHome(ws, "x".repeat(257))).rejects.toThrow();
  await expect(openSearchResult(ws, ws.id(ws.root!))).rejects.toThrow(); // entry and search domains differ
  await expect(openSearchResult(ws, `${found.results[0].id}x`)).rejects.toThrow();
  await openSearchResult(ws, found.results[0].id);
  expect(ws.selected).toBe(path.join(root, "outside", "secret"));
});
it("reports a time-truncated search even when interrupted in the last directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ev-search-limit-"));
  dirs.push(home);
  await writeFile(path.join(home, "entry-one.txt"), "one");
  await writeFile(path.join(home, "entry-two.txt"), "two");
  const ws = new Workspace(home);
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  try {
    const result = await searchHome(ws, "entry");
    expect(result.results).toHaveLength(1);
    expect(result.truncated).toBe(true);
  } finally {
    clock.mockRestore();
  }
});

it("enforces the search time budget even for directories containing only excluded symlinks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ev-search-symlinks-"));
  dirs.push(home);
  await symlink(home, path.join(home, "link-one"));
  await symlink(home, path.join(home, "link-two"));
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  try {
    const result = await searchHome(new Workspace(home), "link");
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
