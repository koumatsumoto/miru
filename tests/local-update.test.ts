import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { preferredEntry, updateLocalBuild } from "../src/server/local-update";
import { linkedLauncher, writeUpdateSources } from "./fixtures/update-source";

it("rolls back a failed server publication; preserves backup and both builds if rollback itself fails", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "miru-publish-test-")));
  try {
    await writeUpdateSources(root);
    const entry = await linkedLauncher(root);
    const builds = path.join(root, ".cache/miru-builds");
    const marker = path.join(builds, "active.json");
    const empty = async () => {};
    await updateLocalBuild(entry, "local", async (_, commit) => {
      await commit(empty);
      return {};
    });
    const previous = await readFile(marker, "utf8");
    const previousEntry = await preferredEntry(entry);
    const before = await readdir(builds);
    await expect(
      updateLocalBuild(entry, "local", async (_, commit) => {
        await commit(async () => {
          throw new Error("injected runtime publish failure");
        });
        return {};
      }),
    ).rejects.toThrow("previous server and its tabs were not stopped");
    expect(await readFile(marker, "utf8")).toEqual(previous);
    expect(await preferredEntry(entry)).toBe(previousEntry);
    expect((await readdir(builds)).sort()).toEqual(before.sort());

    let candidate: string | undefined;
    await expect(
      updateLocalBuild(entry, "local", async (fresh, commit) => {
        candidate = fresh;
        await commit(async () => {
          // Move the newly-published marker aside and make restoration impossible.
          await rename(marker, marker + ".blocked");
          await mkdir(marker);
          throw new Error("injected runtime publish failure");
        });
        return {};
      }),
    ).rejects.toThrow("previous launcher marker was retained");
    const backup = (await readdir(builds)).find((name) => name.startsWith(".previous-"));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(builds, backup!), "utf8")).toBe(previous);
    await access(previousEntry);
    await access(candidate!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
