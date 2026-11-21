import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { checkoutEnvironment } from "./git-environment.js";
import { type UpstreamUpdate, withUpstreamUpdate } from "./upstream-update.js";

const BUILD_ID = /^build-[A-Za-z0-9]{6,32}$/u;
const PACKAGE_NAME = "@koumatsumoto/miru";
const CLI_NAME = "cli.mjs";
const POINTER = "active.json";
const CACHE = ".cache";
const BUILDS = "miru-builds";
const uid = process.getuid?.();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function ordinaryFile(filename: string, limit = Number.MAX_SAFE_INTEGER) {
  const info = await lstat(filename);
  if (
    !info.isFile() ||
    info.size === 0 ||
    info.size > limit ||
    (await realpath(filename)) !== filename
  )
    throw new Error("A required MIRU build file is invalid.");
  return info;
}

async function readSmallFile(
  filename: string,
  limit: number,
  privateFile = false,
): Promise<string> {
  await ordinaryFile(filename, limit);
  const flags =
    constants.O_RDONLY | (uid !== undefined ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0);
  const file = await open(filename, flags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > limit)
      throw new Error("A MIRU build file is invalid.");
    if (privateFile && uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))
      throw new Error("The active MIRU build marker is not private.");
    // A bounded read, including if another build replaces/grows the file after lstat.
    const data = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > limit) throw new Error("A MIRU build file exceeds its size limit.");
    return data.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

async function requiredDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || (await realpath(directory)) !== directory)
    throw new Error("A required MIRU directory is invalid.");
  return info;
}

async function sourceRoot(originalEntry: string): Promise<string | undefined> {
  try {
    const entry = await realpath(originalEntry);
    if (path.basename(entry) !== CLI_NAME) return;
    const output = path.dirname(entry);
    const parent = path.dirname(output);
    const cache = path.dirname(parent);
    const root =
      path.basename(output) === "dist"
        ? parent
        : BUILD_ID.test(path.basename(output)) &&
            path.basename(parent) === BUILDS &&
            path.basename(cache) === CACHE
          ? path.dirname(cache)
          : undefined;
    if (!root) return;
    const info = await requiredDirectory(root);
    if (uid !== undefined && (info.uid !== uid || (info.mode & 0o022) !== 0)) return;
    const manifest = JSON.parse(await readSmallFile(path.join(root, "package.json"), 64 * 1024));
    if (manifest?.name !== PACKAGE_NAME || manifest.bin?.miru !== "dist/cli.mjs") return;
    await Promise.all([
      ordinaryFile(path.join(root, "vite.config.ts")),
      ordinaryFile(path.join(root, "src", "cli.ts")),
      ordinaryFile(path.join(root, "scripts", "build.mjs")),
    ]);
    return root;
  } catch {
    // A packed distribution has no source checkout. Never look at the caller's cwd.
    return;
  }
}

async function stateDirectory(root: string, create: boolean): Promise<string> {
  const cache = path.join(root, CACHE);
  const builds = path.join(cache, BUILDS);
  for (const [directory, mask] of [
    [cache, 0o022],
    [builds, 0o077],
  ] as const) {
    if (create) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    const info = await requiredDirectory(directory);
    if (uid !== undefined && (info.uid !== uid || (info.mode & mask) !== 0))
      throw new Error("The MIRU build cache is not private. Use a user-owned local checkout.");
  }
  return builds;
}

async function validateBuild(directory: string): Promise<string> {
  await requiredDirectory(directory);
  const cli = path.join(directory, CLI_NAME);
  const web = path.join(directory, "web");
  const assets = path.join(web, "assets");
  const pdf = path.join(assets, "pdfjs");
  await Promise.all([requiredDirectory(web), requiredDirectory(assets), requiredDirectory(pdf)]);
  await Promise.all([
    ordinaryFile(cli),
    ordinaryFile(path.join(directory, "THIRD_PARTY_LICENSES.txt")),
    ordinaryFile(path.join(assets, "mermaid.tiny.js")),
  ]);
  const html = await readSmallFile(path.join(web, "index.html"), 512 * 1024);
  if (html.split("__EV_SESSION__").length !== 2)
    throw new Error("The staged viewer is missing its session marker.");
  for (const [, reference] of html.matchAll(/(?:src|href)="\/assets\/([\w./-]+)"/gu)) {
    if (reference.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error("The staged viewer has an invalid asset path.");
    await ordinaryFile(path.join(assets, reference));
  }
  const worker = (await readdir(assets, { withFileTypes: true })).find(
    (file) => file.isFile() && /^pdf\.worker[\w.-]*\.mjs$/u.test(file.name),
  );
  if (!worker) throw new Error("The staged viewer is missing its PDF worker.");
  await ordinaryFile(path.join(assets, worker.name));
  await Promise.all(
    ["cmaps", "standard_fonts", "wasm"].map(async (name) => {
      const folder = path.join(pdf, name);
      await requiredDirectory(folder);
      const sample = (await readdir(folder, { withFileTypes: true })).find((file) => file.isFile());
      if (!sample) throw new Error("The staged viewer is missing required PDF assets.");
      await ordinaryFile(path.join(folder, sample.name));
    }),
  );
  return cli;
}

async function activeBuild(
  builds: string,
): Promise<{ entry: string; revision?: string } | undefined> {
  try {
    const marker = JSON.parse(await readSmallFile(path.join(builds, POINTER), 2048, true));
    if (typeof marker?.build !== "string" || !BUILD_ID.test(marker.build)) return;
    const entry = await validateBuild(path.join(builds, marker.build));
    return { entry, revision: typeof marker.revision === "string" ? marker.revision : undefined };
  } catch {
    // Missing, unsafe, or incomplete generations never redirect the launcher.
    return;
  }
}

export async function preferredEntry(originalEntry: string): Promise<string> {
  const root = await sourceRoot(originalEntry);
  if (!root) return originalEntry;
  try {
    return (await activeBuild(await stateDirectory(root, false)))?.entry ?? originalEntry;
  } catch {
    return originalEntry;
  }
}

async function buildInCheckout(root: string, directory: string): Promise<void> {
  const child = spawn(process.execPath, [path.join(root, "scripts", "build.mjs")], {
    cwd: root,
    env: { ...checkoutEnvironment(), MIRU_BUILD_DIR: directory },
    stdio: "inherit",
    windowsHide: true,
  });
  const [status] = await once(child, "exit");
  if (status !== 0) throw new Error("Local build command failed.");
}

async function stageActiveBuild(builds: string, build: string, revision?: string): Promise<string> {
  const temp = path.join(builds, `.active-${randomBytes(12).toString("hex")}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ build, revision }) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    return temp;
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

type UpdateResult = { unchanged?: boolean; warning?: string; revision?: string };

class MarkerRecoveryError extends Error {}

async function advanceAndPublish(
  upstream: UpstreamUpdate | undefined,
  publish: () => Promise<void>,
) {
  const advanced = upstream && (await upstream.advance());
  try {
    await publish();
  } catch (error) {
    const prefix = advanced ? "Local main was already fast-forwarded. " : "";
    if (error instanceof MarkerRecoveryError)
      throw new MarkerRecoveryError(prefix + error.message, { cause: error });
    throw new Error(
      prefix +
        "The new build could not be activated; the previous server and its tabs were not stopped. Check cache/runtime permissions and retry miru update.",
      { cause: error },
    );
  }
}

// Publish the launcher first, then atomically advertise the new server. Keep a
// rollback link to the old marker until the second publish succeeds. Nobody
// retires the old server (or its views) on either failure.
async function publishBuild(builds: string, marker: string, publishServer: () => Promise<void>) {
  const active = path.join(builds, POINTER);
  const backup = path.join(builds, `.previous-${randomBytes(12).toString("hex")}.tmp`);
  let backedUp = false;
  try {
    try {
      await link(active, backup);
      backedUp = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(marker, active);
    try {
      await publishServer();
    } catch (error) {
      try {
        if (backedUp) await rename(backup, active);
        else await unlink(active);
      } catch (restoreError) {
        // Keep both generations and the last copy of the previous marker.
        // An uncertain active pointer must never reference a deleted candidate.
        const recovery = backedUp ? ` The previous launcher marker was retained at ${backup}.` : "";
        backedUp = false;
        throw new MarkerRecoveryError(
          "The previous server and tabs were not stopped, but restoring the launcher marker failed." +
            recovery +
            " Check cache/runtime permissions before retrying miru update.",
          { cause: restoreError },
        );
      }
      throw error;
    }
  } finally {
    if (backedUp) await unlink(backup).catch(() => {});
  }
}

export async function updateLocalBuild(
  originalEntry: string,
  mode: "upstream" | "local",
  activate: (
    entry: string,
    commit: (publishServer: () => Promise<void>) => Promise<void>,
  ) => Promise<UpdateResult>,
): Promise<UpdateResult> {
  const root = await sourceRoot(originalEntry);
  if (!root)
    throw new Error(
      "miru update needs a local source checkout registered with npm link. A packed install cannot build itself.",
    );
  const builds = await stateDirectory(root, true);
  const lockPath = path.join(builds, "update.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (errorCode(error) === "EEXIST")
      throw new Error(
        "A MIRU update is running, or an interrupted update left update.lock in the build cache.",
      );
    throw error;
  });
  async function apply(upstream?: UpstreamUpdate): Promise<UpdateResult> {
    const revision = upstream?.revision;
    if (upstream) {
      const active = await activeBuild(builds);
      if (active?.revision === upstream.revision) {
        const result = await activate(active.entry, (publishServer) =>
          advanceAndPublish(upstream, publishServer),
        );
        return { ...result, revision };
      }
      console.log(
        `MIRU: building official main ${upstream.revision.slice(0, 12)} in an isolated checkout…`,
      );
    }

    const directory = await mkdtemp(path.join(builds, "build-"));
    let activated = false;
    let marker: string | undefined;
    try {
      let entry: string;
      try {
        if (upstream) await upstream.buildFrom((source) => buildInCheckout(source, directory));
        else await buildInCheckout(root!, directory);
        entry = await validateBuild(directory);
      } catch (error) {
        throw new Error(
          upstream
            ? "The upstream dependency installation/build failed or is incomplete; the checkout and running server were not changed."
            : "The local MIRU build failed or is incomplete; the existing background server was not changed.",
          { cause: error },
        );
      }
      const staged = await stageActiveBuild(builds, path.basename(directory), revision);
      marker = staged;
      const result = await activate(entry, (publishServer) =>
        advanceAndPublish(upstream, () => publishBuild(builds, staged, publishServer)),
      );
      activated = true;
      return { ...result, revision };
    } catch (error) {
      if (error instanceof MarkerRecoveryError) activated = true;
      throw error;
    } finally {
      if (marker) await unlink(marker).catch(() => {});
      if (!activated) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  try {
    return mode === "local" ? await apply() : await withUpstreamUpdate(root, apply);
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
