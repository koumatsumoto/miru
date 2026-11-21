import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPreferences, setThemePreference } from "../src/server/preferences.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "miru-preferences-")));
  roots.push(home);
  const directory = path.join(home, ".miru");
  return { home, directory, file: path.join(directory, "settings.json") };
}

it("uses defaults without creating files and validates an explicit enum before writing", async () => {
  const { home, directory } = await fixture();
  expect(await readPreferences(home)).toEqual({});
  for (const invalid of [null, true, "Dark", "dark\n", { theme: "dark" }])
    await expect(setThemePreference(home, invalid)).rejects.toThrow("light または dark");
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists explicit choices only in the supplied HOME, with private permissions", async () => {
  const { home, directory, file } = await fixture();
  const other = await fixture();
  expect(await setThemePreference(home, "dark")).toEqual({ theme: "dark" });
  expect(await readPreferences(home)).toEqual({ theme: "dark" });
  expect(await readPreferences(other.home)).toEqual({});
  expect(await setThemePreference(home, "light")).toEqual({ theme: "light" });
  expect(await readPreferences(home)).toEqual({ theme: "light" });
  expect(await readFile(file, "utf8")).toBe('{"theme":"light"}\n');
  expect(await readdir(directory)).toEqual(["settings.json"]);
  if (process.getuid) {
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  }
});

it("leaves malformed existing JSON untouched until a valid explicit selection", async () => {
  const { home, directory, file } = await fixture();
  await mkdir(directory, { mode: 0o700 });
  for (const contents of ['{"theme":', '{"theme":"system","extra":42}', '["dark"]']) {
    await writeFile(file, contents, { mode: 0o600 });
    expect(await readPreferences(home)).toEqual({});
    expect(await readFile(file, "utf8")).toBe(contents);
  }
  expect(await setThemePreference(home, "light")).toEqual({ theme: "light" });
  expect(await readPreferences(home)).toEqual({ theme: "light" });
});

it("never reads or overwrites an oversized or nonregular existing preference", async () => {
  const { home, directory, file } = await fixture();
  await mkdir(directory, { mode: 0o700 });
  const oversized = "a".repeat(8193);
  await writeFile(file, oversized, { mode: 0o600 });
  await expect(readPreferences(home)).rejects.toThrow("8 KiB");
  await expect(setThemePreference(home, "dark")).rejects.toThrow("8 KiB");
  expect(await readFile(file, "utf8")).toBe(oversized);
  await rm(file);
  await mkdir(file);
  await expect(readPreferences(home)).rejects.toThrow("ユーザー専用");
  await expect(setThemePreference(home, "dark")).rejects.toThrow("ユーザー専用");
  expect((await lstat(file)).isDirectory()).toBe(true);
});

it.skipIf(!process.getuid)("does not adopt public settings files or directories", async () => {
  const { home, directory, file } = await fixture();
  await setThemePreference(home, "light");
  await chmod(file, 0o644);
  await expect(readPreferences(home)).rejects.toThrow("ユーザー専用");
  await expect(setThemePreference(home, "dark")).rejects.toThrow("ユーザー専用");
  expect(await readFile(file, "utf8")).toBe('{"theme":"light"}\n');
  await chmod(file, 0o600);
  await chmod(directory, 0o755);
  await expect(readPreferences(home)).rejects.toThrow("ユーザー専用");
  await expect(setThemePreference(home, "dark")).rejects.toThrow("ユーザー専用");
});

it.skipIf(process.platform === "win32")(
  "rejects linked settings directories and files without touching their targets",
  async () => {
    const { home, directory, file } = await fixture();
    const target = await fixture();
    await setThemePreference(target.home, "light");
    await symlink(target.directory, directory, "dir");
    await expect(readPreferences(home)).rejects.toThrow("シンボリックリンク");
    await expect(setThemePreference(home, "dark")).rejects.toThrow("シンボリックリンク");
    expect(await readPreferences(target.home)).toEqual({ theme: "light" });
    await rm(directory);
    await mkdir(directory, { mode: 0o700 });
    await symlink(target.file, file, "file");
    await expect(readPreferences(home)).rejects.toThrow("シンボリックリンク");
    await expect(setThemePreference(home, "dark")).rejects.toThrow("シンボリックリンク");
    expect(await readPreferences(target.home)).toEqual({ theme: "light" });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
  },
);

it("uses complete atomic replacements for concurrent writes", async () => {
  const { home, directory } = await fixture();
  await setThemePreference(home, "light");
  await Promise.all(
    Array.from({ length: 16 }, (_, i) => setThemePreference(home, i % 2 ? "dark" : "light")),
  );
  expect(["light", "dark"]).toContain((await readPreferences(home)).theme);
  expect(await readdir(directory)).toEqual(["settings.json"]);
});

it.skipIf(process.platform !== "linux")(
  "does not follow a live directory replacement during atomic publication",
  async () => {
    const { home, directory } = await fixture();
    const outside = await fixture();
    const original = path.join(home, "moved");
    await setThemePreference(home, "light");
    await setThemePreference(outside.home, "light");
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await fs.rename(directory, original);
      await symlink(outside.directory, directory, "dir");
      await fs.rename(from, to);
    });
    await expect(setThemePreference(home, "dark")).rejects.toThrow("シンボリックリンク");
    expect(await readPreferences(outside.home)).toEqual({ theme: "light" });
    expect(await readdir(outside.directory)).toEqual(["settings.json"]);
    expect(await readdir(original)).toEqual(["settings.json"]);
  },
);
