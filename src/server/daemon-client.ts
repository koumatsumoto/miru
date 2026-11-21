import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertPrivateDaemonDirectory,
  assertPrivateDaemonSocket,
  daemonControlLimit,
  daemonControlPath,
  entryGeneration,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";

type DaemonStatus = Extract<DaemonResponse, { ok: true }>;
type ResidentView = DaemonStatus & { url: string };
type OpenOptions = { target?: string; diff: boolean };

const socketNamePattern = /^d-[a-f0-9]{16}\.sock$/;
const activeFile = "active";
const lockFile = "transition.lock";
const startupTime = 5_000;
const transitionTime = 12_000;
const requestTime = 3_000;
const openTime = 25_000;

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return error.code;
  return undefined;
}

function endpointMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function nonce(): string {
  return randomBytes(8).toString("hex");
}

async function runtimeDirectory(): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("MIRU's resident server requires WSL, Linux, or macOS.");
  const override = process.env.MIRU_RUNTIME_DIR;
  const xdg = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR : undefined;
  let directory = override
    ? path.resolve(override)
    : xdg && path.isAbsolute(xdg) && Buffer.byteLength(path.join(xdg, "miru")) < 75
      ? path.join(xdg, "miru")
      : `/tmp/miru-${uid}`;
  if (override) {
    const parent = await realpath(path.dirname(directory));
    await assertPrivateDaemonDirectory(parent);
    directory = path.join(parent, path.basename(directory));
  }
  if (Buffer.byteLength(path.join(directory, "d-0000000000000000.sock")) >= 104) {
    throw new Error("MIRU_RUNTIME_DIR is too long for a Unix socket; choose a shorter path.");
  }
  if (!override && xdg && directory === path.join(xdg, "miru")) {
    await assertPrivateDaemonDirectory(xdg);
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertPrivateDaemonDirectory(directory);
  return directory;
}

async function readActive(directory: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path.join(directory, activeFile),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 32
    ) {
      throw new Error("MIRU's active-server record is not a private regular file.");
    }
    const buffer = Buffer.alloc(33);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const filename = buffer.subarray(0, bytesRead).toString("utf8").trimEnd();
    if (!socketNamePattern.test(filename) || bytesRead === buffer.length) {
      throw new Error("MIRU's active-server record is invalid.");
    }
    return path.join(directory, filename);
  } finally {
    await handle.close();
  }
}

async function publishActive(directory: string, socketPath: string): Promise<void> {
  const temporary = path.join(directory, `active-${nonce()}.tmp`);
  await writeFile(temporary, `${path.basename(socketPath)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path.join(directory, activeFile));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function locked<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const lock = path.join(directory, lockFile);
  const deadline = Date.now() + transitionTime;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          "MIRU's server transition is locked. If no MIRU CLI is running, remove the empty transition.lock directory and try again.",
        );
      }
      await delay(75);
    }
  }
  try {
    return await task();
  } finally {
    await rmdir(lock).catch(() => {
      console.error("MIRU: サーバー切替のロックを解除できませんでした。");
    });
  }
}

function controlResponse(value: unknown): DaemonResponse {
  if (!value || typeof value !== "object" || !("ok" in value)) {
    throw new Error("MIRU's server sent an invalid response.");
  }
  if (value.ok === false && "error" in value && typeof value.error === "string") {
    return { ok: false, error: value.error };
  }
  if (
    value.ok === true &&
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    "views" in value &&
    typeof value.views === "number" &&
    Number.isSafeInteger(value.views) &&
    value.views >= 0 &&
    (!("url" in value) || typeof value.url === "string")
  ) {
    return {
      ok: true,
      pid: value.pid,
      views: value.views,
      generation:
        "generation" in value &&
        typeof value.generation === "string" &&
        /^[0-9a-f]{64}$/u.test(value.generation)
          ? value.generation
          : undefined,
      url: "url" in value && typeof value.url === "string" ? value.url : undefined,
    };
  }
  throw new Error("MIRU's server sent an invalid response.");
}

async function call(socketPath: string, input: DaemonRequest): Promise<DaemonStatus> {
  await assertPrivateDaemonSocket(socketPath);
  const body = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const client = request(
      {
        socketPath,
        path: daemonControlPath,
        method: "POST",
        agent: false,
        signal: AbortSignal.timeout(input.action === "open" ? openTime : requestTime),
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > daemonControlLimit) {
            response.destroy(new Error("MIRU's server response was too large."));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          try {
            const result = controlResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            if (!result.ok) throw new Error(result.error);
            if (response.statusCode !== 200) throw new Error("MIRU's server rejected the request.");
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    client.on("error", reject);
    client.end(body);
  });
}

async function existing(socketPath: string): Promise<DaemonStatus | undefined> {
  try {
    return await call(socketPath, { action: "status" });
  } catch (error) {
    if (endpointMissing(error)) return undefined;
    throw error;
  }
}

async function boot(
  directory: string,
  entryPath: string,
): Promise<{ socketPath: string; status: DaemonStatus }> {
  const socketPath = path.join(directory, `d-${nonce()}.sock`);
  const daemon = spawn(process.execPath, [entryPath, "--internal-server", socketPath], {
    cwd: directory,
    detached: true,
    stdio: "ignore",
  });
  let failure: Error | undefined;
  let exited = false;
  daemon.once("error", (error) => {
    failure = error;
  });
  daemon.once("exit", (code, signal) => {
    exited = true;
    failure = new Error(
      `MIRU の常駐サーバーが起動時に終了しました（${signal ?? code ?? "不明"}）。`,
    );
  });
  daemon.unref();
  const deadline = Date.now() + startupTime;
  let lastError: unknown;
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure;
      // The socket briefly exists before the daemon sets its final private mode.
      const status = await existing(socketPath).catch((error: unknown) => {
        lastError = error;
        return undefined;
      });
      if (status) {
        if (status.pid !== daemon.pid)
          throw new Error("起動した MIRU のサーバーを識別できませんでした。");
        return { socketPath, status };
      }
      await delay(50);
    }
    throw new Error("MIRU の常駐サーバーの起動がタイムアウトしました。", { cause: lastError });
  } catch (error) {
    // Only cancel the child this invocation started; never use an identifier from disk.
    if (!exited && daemon.pid !== undefined) daemon.kill();
    throw error;
  }
}

async function startAndPublish(directory: string, entryPath: string) {
  const started = await boot(directory, entryPath);
  try {
    await publishActive(directory, started.socketPath);
  } catch (error) {
    await call(started.socketPath, { action: "stop" }).catch(() => {});
    throw error;
  }
  return started;
}

async function currentOrStart(directory: string, entryPath: string) {
  const socketPath = await readActive(directory);
  if (socketPath) {
    const status = await existing(socketPath);
    if (status) return { socketPath, status };
    await rm(socketPath, { force: true });
  }
  return startAndPublish(directory, entryPath);
}

export async function ensureResident(entryPath: string): Promise<DaemonStatus> {
  const directory = await runtimeDirectory();
  return locked(directory, async () => (await currentOrStart(directory, entryPath)).status);
}

export async function openResident(entryPath: string, options: OpenOptions): Promise<ResidentView> {
  if (options.target !== undefined && !path.isAbsolute(options.target)) {
    throw new Error("MIRU requires an absolute path for a background view.");
  }
  const directory = await runtimeDirectory();
  const select = () => locked(directory, () => currentOrStart(directory, entryPath));
  const current = await select();
  const command = { action: "open", ...options } as const;
  let result: DaemonStatus;
  try {
    result = await call(current.socketPath, command);
  } catch (error) {
    // A simultaneous replacement can win before connection. Do not retry a
    // timed-out or interrupted request that may already have opened a view.
    if (!endpointMissing(error)) throw error;
    const next = await select();
    result = await call(next.socketPath, command);
  }
  if (!result.url) throw new Error("MIRU から表示先の URL が返りませんでした。");
  const url = new URL(result.url);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.username ||
    url.password
  ) {
    throw new Error("MIRU からローカルではない表示先が返りました。");
  }
  return { ...result, url: result.url };
}

export async function residentStatus(): Promise<DaemonStatus | undefined> {
  const directory = await runtimeDirectory();
  const socketPath = await readActive(directory);
  if (!socketPath) return undefined;
  const status = await existing(socketPath);
  if (status) return status;
  const next = await readActive(directory);
  return next && next !== socketPath ? existing(next) : undefined;
}

export async function stopResident(): Promise<boolean> {
  const directory = await runtimeDirectory();
  return locked(directory, async () => {
    const socketPath = await readActive(directory);
    if (!socketPath) return false;
    const status = await existing(socketPath);
    if (status) {
      await call(socketPath, { action: "stop" });
    } else {
      await rm(socketPath, { force: true });
    }
    await rm(path.join(directory, activeFile), { force: true });
    return status !== undefined;
  });
}

export async function replaceResident(
  entryPath: string,
  commit: (publishServer: () => Promise<void>) => Promise<void>,
): Promise<DaemonStatus & { warning?: string; unchanged?: boolean }> {
  const directory = await runtimeDirectory();
  return locked(directory, async () => {
    const old = await readActive(directory);
    const status = old ? await existing(old) : undefined;
    if (status?.generation === entryGeneration(entryPath)) {
      await commit(async () => {});
      return { ...status, unchanged: true };
    }
    const current = await boot(directory, entryPath);
    try {
      // The old endpoint and all of its views stay live until the checkout,
      // launcher marker and healthy candidate's endpoint have been committed.
      await commit(async () => {
        // A slow checkout advance can outlive a candidate's first readiness
        // reply. Never retire the working server for an already-dead one.
        const ready = await existing(current.socketPath);
        if (!ready || ready.pid !== current.status.pid)
          throw new Error("The candidate server did not remain ready.");
        await publishActive(directory, current.socketPath);
      });
    } catch (error) {
      await call(current.socketPath, { action: "stop" }).catch(() => {});
      throw error;
    }
    if (old) {
      if (status) {
        try {
          await call(old, { action: "stop" });
        } catch {
          return {
            ...current.status,
            warning: "MIRU's new server is ready, but the old server did not confirm shutdown.",
          };
        }
      } else {
        await rm(old, { force: true }).catch(() => {});
      }
    }
    return current.status;
  });
}
