import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./workspace.js";

type Theme = "light" | "dark";
const sizeLimit = 8 * 1024;
const settingsFile = "settings.json";
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const sameFile = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;
const samePath = (a: string, b: string) => path.relative(a, b) === "";
const unsafe = () =>
  new UserError(
    "MIRUの設定にはシンボリックリンクではないユーザー専用のフォルダ・ファイルを使用してください。",
  );

function requireOwner(info: Stats, mask: number) {
  const uid = process.getuid?.();
  // Direct Windows Node uses the profile folder's inherited ACL; POSIX
  // mode and ownership information is available under Linux, WSL and macOS.
  if (uid !== undefined && (uid !== info.uid || (info.mode & mask) !== 0)) throw unsafe();
}

async function pinDirectory(filename: string, visiblePath: string, privateDirectory: boolean) {
  const before = await lstat(filename);
  if (!before.isDirectory()) throw unsafe();
  requireOwner(before, privateDirectory ? 0o077 : 0o022);
  // A directory descriptor keeps all subsequent writes in this directory
  // even if its original path is exchanged for a symlink (Linux/WSL).
  const handle =
    process.platform === "linux"
      ? await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | noFollow)
      : undefined;
  const directory = handle ? `/proc/self/fd/${handle.fd}` : filename;
  const recheck = async () => {
    const current = await lstat(visiblePath);
    if (
      !current.isDirectory() ||
      !sameFile(before, current) ||
      !samePath(visiblePath, await realpath(directory))
    )
      throw unsafe();
    requireOwner(current, privateDirectory ? 0o077 : 0o022);
  };
  try {
    if (handle && !sameFile(before, await handle.stat())) throw unsafe();
    await recheck();
    return { directory, recheck, close: async () => handle?.close() };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function inSettings<T>(
  home: string,
  create: boolean,
  task: (directory: string, recheck: () => Promise<void>) => Promise<T>,
): Promise<T | undefined> {
  const canonicalHome = await realpath(home);
  const root = await pinDirectory(canonicalHome, canonicalHome, false);
  try {
    const directory = path.join(root.directory, ".miru");
    if (create) {
      await root.recheck();
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
    }
    const settings = await pinDirectory(directory, path.join(canonicalHome, ".miru"), true).catch(
      (error: unknown) => {
        if (!create && code(error) === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!settings) return undefined;
    try {
      return await task(settings.directory, settings.recheck);
    } finally {
      await settings.close();
    }
  } finally {
    await root.close();
  }
}

function validateSettingsFile(info: Stats) {
  // An already-open handle can have zero links after an atomic replacement.
  if (!info.isFile() || info.nlink > 1) throw unsafe();
  requireOwner(info, 0o077);
  if (info.size > sizeLimit)
    throw new UserError("MIRUの設定ファイルが大きすぎます（上限 8 KiB）。");
}

async function currentSettings(file: string) {
  try {
    const info = await lstat(file);
    validateSettingsFile(info);
    return info;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function readPreferences(home: string): Promise<{ theme?: Theme }> {
  return (
    (await inSettings(home, false, async (directory, recheck) => {
      const file = path.join(directory, settingsFile);
      if (!(await currentSettings(file))) return {};
      const handle = await open(file, constants.O_RDONLY | noFollow);
      try {
        const info = await handle.stat();
        validateSettingsFile(info);
        await recheck();
        if (process.platform !== "linux") {
          const current = await currentSettings(file);
          // An atomic write may have just replaced the file. Use a default
          // rather than reading a handle whose visible identity isn't known.
          if (!current || !sameFile(current, info)) return {};
        }
        const buffer = Buffer.alloc(sizeLimit + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > sizeLimit)
          throw new UserError("MIRUの設定ファイルが大きすぎます（上限 8 KiB）。");
        try {
          const data: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
          );
          if (
            data &&
            typeof data === "object" &&
            Object.hasOwn(data, "theme") &&
            "theme" in data &&
            isTheme(data.theme)
          )
            return { theme: data.theme };
        } catch {
          // An invalid optional preference shouldn't prevent using the viewer.
        }
        return {};
      } finally {
        await handle.close();
      }
    })) ?? {}
  );
}

export async function setThemePreference(home: string, theme: unknown): Promise<{ theme: Theme }> {
  if (!isTheme(theme)) throw new UserError("テーマは light または dark を指定してください。");
  const settings = { theme };
  await inSettings(home, true, async (directory, recheck) => {
    const file = path.join(directory, settingsFile);
    await currentSettings(file);
    await recheck();
    const temp = path.join(directory, `.settings-${randomBytes(12).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      try {
        if (process.platform !== "linux") {
          await recheck();
          const current = await lstat(temp);
          if (!current.isFile() || !sameFile(current, await handle.stat())) throw unsafe();
        }
        if (process.getuid) await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(settings) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await recheck();
      await currentSettings(file);
      await rename(temp, file);
      await recheck();
    } finally {
      // Never delete a temp location that has been redirected. On Linux the
      // path still names the pinned directory; on other platforms recheck.
      if (process.platform === "linux") await rm(temp, { force: true }).catch(() => {});
      else
        await recheck()
          .then(() => rm(temp, { force: true }))
          .catch(() => {});
    }
  });
  return settings;
}
