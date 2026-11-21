import { afterEach, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createViewerOperation } from "../src/server/viewer-operations";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "miru-operations-")));
  homes.push(home);
  const folder = path.join(home, "visible");
  const file = path.join(folder, "page.html");
  await mkdir(folder);
  await writeFile(file, "<h1>Local</h1>");
  const opener = vi.fn(async (_target: string, _isFile?: boolean) => {});
  const operation = createViewerOperation(
    { home, target: file, diff: true, opener },
    Buffer.alloc(32, 7),
  );
  return { home, folder, file, opener, operation };
}

it("keeps HOME operations available after a tab directory vanishes, without skipping payload validation", async () => {
  const { home, operation } = await fixture();
  const context = { root: path.join(home, "removed"), selected: null, diffMode: true };
  await expect(operation({ op: "refresh", context })).rejects.toThrow();
  await expect(operation({ op: "preferences", context })).resolves.toEqual({});
  await expect(operation({ op: "search", query: "page", context })).resolves.toMatchObject({
    results: [{ name: "page.html" }],
  });
  await expect(operation({ op: "home", context })).resolves.toMatchObject({
    root: { displayPath: home },
    diffMode: false,
  });
  await expect(operation({ op: "preferences", context: { root: null } })).rejects.toThrow(
    "表示情報が不正",
  );
});

it("keeps the launch default, entry validation and opener dispatch request-local", async () => {
  const { home, folder, file, opener, operation } = await fixture();
  const initial = (await operation({ op: "state" })) as {
    root: { displayPath: string };
    selected: { id: string; name: string };
    diffMode: boolean;
  };
  expect(initial).toMatchObject({
    root: { displayPath: folder },
    selected: { name: "page.html" },
    diffMode: true,
  });
  const id = initial.selected.id;
  const context = { root: folder, selected: id, diffMode: true };
  await expect(
    operation({ op: "external", id, context: { root: home, selected: null, diffMode: false } }),
  ).rejects.toThrow("表示範囲から外れました");
  expect(opener).not.toHaveBeenCalled();
  await expect(operation({ op: "read", id, context })).resolves.toMatchObject({
    text: "<h1>Local</h1>",
  });
  await expect(operation({ op: "external", id, context })).resolves.toEqual({ ok: true });
  expect(opener).toHaveBeenCalledExactlyOnceWith(file, true);
  expect(await operation({ op: "refresh", context })).toEqual(initial);
});
