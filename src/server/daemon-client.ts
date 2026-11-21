import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertPrivateDaemonDirectory,
  assertPrivateDaemonSocket,
  daemonActiveFile,
  daemonControlLimit,
  daemonControlPath,
  entryGeneration,
  readPublishedDaemon,
  residentHost,
  residentPort,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";

type DaemonStatus = Extract<DaemonResponse, { ok: true }>;
type ResidentView = DaemonStatus & { url: string };
type OpenOptions = { target?: string; diff: boolean };
type DaemonEndpoint = { socketPath: string; status: DaemonStatus };
type Candidate = DaemonEndpoint & { dispose: () => Promise<void> };
const grantPattern = /^[a-f0-9]{64}$/u;

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

async function publishActive(directory: string, socketPath: string): Promise<void> {
  const temporary = path.join(directory, `active-${nonce()}.tmp`);
  await writeFile(temporary, `${path.basename(socketPath)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path.join(directory, daemonActiveFile));
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
    const fixed =
      "port" in value &&
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port >= 1024 &&
      value.port <= 65_535 &&
      "listening" in value &&
      typeof value.listening === "boolean"
        ? { port: value.port, listening: value.listening }
        : {};
    return {
      ok: true,
      pid: value.pid,
      views: value.views,
      ...fixed,
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

class FixedPortError extends Error {}

async function boot(
  directory: string,
  entryPath: string,
  port = residentPort(),
): Promise<Candidate> {
  const socketPath = path.join(directory, `d-${nonce()}.sock`);
  const daemon = spawn(
    process.execPath,
    [entryPath, "--internal-server", socketPath, "--prepare", String(process.pid)],
    {
      cwd: directory,
      env: { ...process.env, MIRU_PORT: String(port) },
      detached: true,
      stdio: "ignore",
    },
  );
  let failure: Error | undefined;
  let exited = false;
  const finished = new Promise<void>((resolve) => {
    daemon.once("error", (error) => {
      failure = error;
      exited = true;
      resolve();
    });
    daemon.once("exit", (code, signal) => {
      exited = true;
      failure = new Error(
        `MIRU の常駐サーバーが起動時に終了しました（${signal ?? code ?? "不明"}）。`,
      );
      resolve();
    });
  });
  daemon.unref();

  async function dispose() {
    if (!exited) {
      await call(socketPath, { action: "stop" }).catch(() => {});
      await Promise.race([finished, delay(250)]);
    }
    if (!exited) {
      // This is only the child this invocation started. Never kill a PID read from disk.
      daemon.kill();
      await Promise.race([finished, delay(250)]);
    }
    if (!exited) {
      daemon.kill("SIGKILL");
      await Promise.race([finished, delay(250)]);
    }
    if (exited) await rm(socketPath, { force: true }).catch(() => {});
  }

  const deadline = Date.now() + startupTime;
  let lastError: unknown;
  try {
    while (Date.now() < deadline) {
      if (failure) throw failure;
      // The socket briefly exists before chmod sets its final private mode.
      const status = await existing(socketPath).catch((error: unknown) => {
        lastError = error;
        return undefined;
      });
      if (status) {
        if (status.pid !== daemon.pid || status.port !== port || status.listening !== false)
          throw new Error("起動した MIRU のサーバーを識別できませんでした。");
        return { socketPath, status, dispose };
      }
      await delay(50);
    }
    throw new Error("MIRU の常駐サーバーの起動がタイムアウトしました。", { cause: lastError });
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function bind(endpoint: DaemonEndpoint): Promise<DaemonStatus> {
  let status: DaemonStatus;
  try {
    status = await call(endpoint.socketPath, { action: "listen" });
  } catch (error) {
    // This error is produced on MIRU's own private control socket, never in response to browser input.
    const text =
      error instanceof Error && error.message.startsWith("固定ポート ")
        ? error.message
        : "MIRU の固定ポートを起動できませんでした。";
    throw new FixedPortError(text, { cause: error });
  }
  if (
    status.pid !== endpoint.status.pid ||
    status.port !== endpoint.status.port ||
    !status.listening
  )
    throw new FixedPortError("MIRU の固定ポートの起動を確認できませんでした。");
  return status;
}

async function startAndPublish(directory: string, entryPath: string): Promise<DaemonEndpoint> {
  const candidate = await boot(directory, entryPath);
  try {
    const status = await bind(candidate);
    await publishActive(directory, candidate.socketPath);
    return { socketPath: candidate.socketPath, status };
  } catch (error) {
    await candidate.dispose();
    throw error;
  }
}

async function currentOrStart(directory: string, entryPath: string): Promise<DaemonEndpoint> {
  const socketPath = await readPublishedDaemon(directory);
  if (socketPath) {
    const status = await existing(socketPath);
    if (status) {
      // Recover a known daemon that was paused by an interrupted update.
      const current = { socketPath, status };
      return status.port !== undefined && !status.listening
        ? { socketPath, status: await bind(current) }
        : current;
    }
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
  // Prepare, bind and mint a launch grant under the same transition lock. Old
  // per-view daemons are kept available until the user chooses to update/stop.
  return locked(directory, async () => {
    const current = await currentOrStart(directory, entryPath);
    const port = current.status.port;
    const result = await call(current.socketPath, { action: port ? "launch" : "open", ...options });
    if (!result.url) throw new Error("MIRU から表示先の URL が返りませんでした。");
    const url = new URL(result.url);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      (port
        ? url.origin !== `http://${residentHost}:${port}` ||
          url.pathname !== "/" ||
          url.search ||
          !grantPattern.test(fragment.get("grant") ?? "") ||
          fragment.size !== 1
        : url.hostname !== "localhost" && url.hostname !== residentHost)
    )
      throw new Error("MIRU からローカルの正しい表示先が返りませんでした。");
    return { ...result, url: result.url };
  });
}

export async function residentStatus(): Promise<DaemonStatus | undefined> {
  const directory = await runtimeDirectory();
  const socketPath = await readPublishedDaemon(directory);
  if (!socketPath) return undefined;
  const status = await existing(socketPath);
  if (status) return status;
  const next = await readPublishedDaemon(directory);
  return next && next !== socketPath ? existing(next) : undefined;
}

export async function stopResident(): Promise<boolean> {
  const directory = await runtimeDirectory();
  return locked(directory, async () => {
    const socketPath = await readPublishedDaemon(directory);
    const status = socketPath ? await existing(socketPath) : undefined;
    if (socketPath) {
      if (status) await call(socketPath, { action: "stop" });
      else await rm(socketPath, { force: true });
      await rm(path.join(directory, daemonActiveFile), { force: true });
    }
    // An explicit stop invalidates browser sessions. Update intentionally
    // stops only the prior process and preserves the credential file.
    await rm(path.join(directory, "browser.key"), { force: true });
    return status !== undefined;
  });
}

export async function replaceResident(
  entryPath: string,
  commit: (publishServer: () => Promise<void>) => Promise<void>,
): Promise<DaemonStatus & { warning?: string; unchanged?: boolean; migrated?: boolean }> {
  const directory = await runtimeDirectory();
  return locked(directory, async () => {
    const old = await readPublishedDaemon(directory);
    const status = old ? await existing(old) : undefined;
    if (old && status?.port && status.generation === entryGeneration(entryPath)) {
      const running = status.listening ? status : await bind({ socketPath: old, status });
      await commit(async () => {});
      return { ...running, unchanged: true };
    }
    const port =
      process.env.MIRU_PORT === undefined && status?.port !== undefined
        ? status.port
        : residentPort();
    if (status?.port !== undefined && status.port !== port) {
      throw new Error(
        "MIRU_PORT が現在の固定ポートと異なります。変更するには miru stop を実行してから再試行してください。",
      );
    }
    const current = await boot(directory, entryPath, port);
    let running: DaemonStatus | undefined;
    let attemptedPause = false;
    try {
      // Leave the old viewer listening while checking assets, fast-forwarding
      // and preparing the launcher marker. Only the final handoff releases it.
      await commit(async () => {
        const ready = await existing(current.socketPath);
        if (!ready || ready.pid !== current.status.pid)
          throw new Error("The candidate server did not remain ready.");
        if (old && status?.port !== undefined) {
          attemptedPause = true;
          const paused = await call(old, { action: "pause" });
          if (paused.pid !== status.pid || paused.listening !== false)
            throw new Error("The previous fixed listener did not release its port.");
        }
        running = await bind(current);
        await publishActive(directory, current.socketPath);
      });
    } catch (error) {
      await current.dispose();
      if (old && status && attemptedPause) {
        try {
          await bind({ socketPath: old, status });
        } catch (recovery) {
          const detail = recovery instanceof FixedPortError ? ` ${recovery.message}` : "";
          throw new Error(
            "MIRU の切替に失敗し、以前の固定ポートも再開できませんでした。" +
              detail +
              " ポートが空いていることを確認して miru server を実行してください。",
            { cause: error },
          );
        }
      }
      if (error instanceof Error && error.cause instanceof FixedPortError)
        throw new Error(`${error.message} ${error.cause.message}`, { cause: error });
      throw error;
    }

    const result = {
      ...(running ?? current.status),
      migrated: Boolean(status && status.port === undefined),
    };
    if (!old) return result;
    if (!status) {
      await rm(old, { force: true }).catch(() => {});
      return result;
    }
    try {
      await call(old, { action: "stop" });
      return result;
    } catch {
      return {
        ...result,
        warning: "MIRU's new server is ready, but the old server did not confirm shutdown.",
      };
    }
  });
}
