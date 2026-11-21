import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, open, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  assertPrivateDaemonDirectory,
  assertPrivateDaemonSocket,
  daemonControlLimit,
  daemonControlPath,
  entryGeneration,
  launchGrantTtlMs,
  readPublishedDaemon,
  residentHost,
  residentPort,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { loadWebAssets, startServer } from "./server.js";

const maxGrants = 128;
const prepareLeaseMs = 120_000;
const hexKey = /^[a-f0-9]{64}$/u;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

class ControlError extends Error {}

function reply(response: ServerResponse, status: number, result: DaemonResponse): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(JSON.stringify(result));
}

async function readRequest(request: IncomingMessage): Promise<DaemonRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > daemonControlLimit) throw new ControlError("リクエストが大きすぎます。");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (!value || typeof value !== "object" || Array.isArray(value) || !("action" in value))
    throw new ControlError("リクエストが不正です。");
  if (
    (value.action === "status" ||
      value.action === "stop" ||
      value.action === "pause" ||
      value.action === "listen") &&
    Object.keys(value).length === 1
  )
    return { action: value.action };
  if (
    (value.action !== "open" && value.action !== "launch") ||
    Object.keys(value).some((key) => key !== "action" && key !== "target" && key !== "diff")
  )
    throw new ControlError("リクエストが不正です。");
  const target = "target" in value ? value.target : undefined;
  const diff = "diff" in value ? value.diff : undefined;
  if (
    (target !== undefined &&
      (typeof target !== "string" ||
        !path.isAbsolute(target) ||
        target !== path.resolve(target) ||
        target.includes("\0"))) ||
    (diff !== undefined && typeof diff !== "boolean")
  )
    throw new ControlError("正規化された絶対パスを指定してください。");
  return { action: value.action, target, diff };
}

async function readBrowserKey(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error("MIRU のブラウザー認証ファイルを安全に読み込めません。", { cause: error });
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== 65
    ) {
      throw new Error("MIRU のブラウザー認証ファイルは現在のユーザー専用（0600）にしてください。");
    }
    const buffer = Buffer.alloc(66);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const value = buffer.toString("utf8", 0, 64);
    if (bytesRead !== 65 || buffer[64] !== 10 || !hexKey.test(value))
      throw new Error("MIRU のブラウザー認証ファイルが壊れています。");
    return value;
  } finally {
    await handle.close();
  }
}

async function browserKey(directory: string): Promise<string> {
  const file = path.join(directory, "browser.key");
  const previous = await readBrowserKey(file);
  if (previous) return previous;
  const temp = path.join(directory, `.browser-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(randomBytes(32).toString("hex") + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, file);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const key = await readBrowserKey(file);
    if (!key) throw new Error("MIRU のブラウザー認証ファイルを初期化できません。");
    return key;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function serveDaemon(
  socketPath: string,
  entry: string,
  parentPid?: number,
): Promise<void> {
  if (
    !path.isAbsolute(socketPath) ||
    socketPath !== path.resolve(socketPath) ||
    !/^d-[a-f0-9]{16}\.sock$/u.test(path.basename(socketPath)) ||
    Buffer.byteLength(socketPath) > 103
  )
    throw new Error("MIRU の常駐ソケットの場所が不正です。");
  const directory = path.dirname(socketPath);
  await assertPrivateDaemonDirectory(directory);
  // A new candidate loads all assets and checks the persistent credential
  // before it advertises readiness, even while the old version has the port.
  const loadedAssets = await loadWebAssets();
  const authToken = await browserKey(directory);
  const port = residentPort();
  const generation = entryGeneration(entry);
  const grants = new Map<string, { expires: number; target?: string; diff: boolean }>();
  let listening: Awaited<ReturnType<typeof startServer>> | undefined;
  let stopping = false;
  let closing = false;
  let transition = Promise.resolve();
  let notifyStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    notifyStopped = resolve;
  });

  function serialized(task: () => Promise<void>) {
    const next = transition.then(task);
    transition = next.catch(() => {});
    return next;
  }

  function redeemGrant(grant: string) {
    const launch = grants.get(grant);
    grants.delete(grant);
    if (launch && launch.expires > Date.now()) return { target: launch.target, diff: launch.diff };
    return undefined;
  }

  async function listen() {
    if (stopping) throw new ControlError("MIRU は停止中です。");
    if (listening) return;
    try {
      listening = await startServer({ port, loadedAssets, authToken, redeemGrant });
    } catch (error) {
      const code = errorCode(error);
      if (code === "EADDRINUSE")
        throw new ControlError(
          `固定ポート ${port} は使用中です。別のアプリを停止するか、MIRU_PORT に空いている固定ポートを指定してください。`,
        );
      if (code === "EACCES" || code === "EPERM")
        throw new ControlError(`固定ポート ${port} を開く権限がありません。`);
      throw new ControlError(`固定ポート ${port} を起動できません。`);
    }
  }

  async function pause() {
    if (!listening) return;
    await listening.close();
    listening = undefined;
  }

  // #17/#18 launch a candidate with only the socket argument and need to see
  // a fully bound server before they retire their old per-tab listeners.
  if (parentPid === undefined) await listen();

  function status() {
    return {
      ok: true as const,
      pid: process.pid,
      views: 0,
      port,
      listening: Boolean(listening),
      generation,
    };
  }

  function close() {
    if (closing) return;
    closing = true;
    stopping = true;
    void serialized(pause)
      .finally(() => {
        server.close(() => notifyStopped());
        server.closeAllConnections();
      })
      .catch(() => {});
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      request.method !== "POST" ||
      request.url !== daemonControlPath ||
      request.headers.origin !== undefined ||
      request.headers["sec-fetch-site"] !== undefined ||
      request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
    ) {
      reply(response, 400, { ok: false, error: "許可されていないリクエストです。" });
      return;
    }
    let command: DaemonRequest;
    try {
      command = await readRequest(request);
    } catch (error) {
      reply(response, 400, {
        ok: false,
        error: error instanceof ControlError ? error.message : "JSON が不正です。",
      });
      return;
    }
    if (stopping) {
      reply(response, 503, { ok: false, error: "MIRU は停止中です。" });
      return;
    }
    switch (command.action) {
      case "status":
        reply(response, 200, status());
        break;
      case "stop":
        stopping = true;
        await serialized(pause).catch(() => {});
        response.once("close", close);
        if (response.destroyed) close();
        else reply(response, 200, status());
        break;
      case "listen":
      case "pause":
        await serialized(command.action === "listen" ? listen : pause);
        reply(response, 200, status());
        break;
      case "open":
        // Older CLIs unconditionally log the returned URL. Require the current
        // CLI for the fixed origin. Their status/stop/upgrade remain compatible.
        reply(response, 400, {
          ok: false,
          error: "古い MIRU コマンドです。更新後の miru を使ってください。",
        });
        break;
      case "launch": {
        if (!listening) throw new ControlError("MIRU の固定ポートは準備中です。");
        const now = Date.now();
        for (const [grant, launch] of grants) if (launch.expires <= now) grants.delete(grant);
        if (grants.size >= maxGrants)
          throw new ControlError(
            "ブラウザー起動リンクが多すぎます。リンクを開くか、少し待ってからやり直してください。",
          );
        const grant = randomBytes(32).toString("hex");
        grants.set(grant, {
          expires: now + launchGrantTtlMs,
          target: command.target,
          diff: command.diff ?? false,
        });
        reply(response, 200, {
          ...status(),
          url: `http://${residentHost}:${port}/#grant=${grant}`,
        });
        break;
      }
    }
  }

  const server = createServer(
    { headersTimeout: 5_000, requestTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        if (!response.headersSent)
          reply(response, 503, {
            ok: false,
            error: error instanceof ControlError ? error.message : "MIRU の操作に失敗しました。",
          });
        else response.destroy();
      });
    },
  );
  server.maxConnections = 16;
  server.setTimeout(30_000);
  let lease: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    await assertPrivateDaemonSocket(socketPath);
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    if (parentPid !== undefined) {
      const deadline = Date.now() + prepareLeaseMs;
      lease = setInterval(() => {
        // An unpublished candidate cannot retain the fixed port if the updater
        // dies. The atomic private marker is the commit signal, including for
        // plain `miru server` starts whose client exits immediately afterward.
        if (process.ppid === parentPid && Date.now() < deadline) return;
        clearInterval(lease);
        void readPublishedDaemon(directory)
          .catch(() => undefined)
          .then((active) => {
            if (active !== socketPath) close();
          });
      }, 250).unref();
    }
    await stopped;
  } finally {
    clearInterval(lease);
    process.off("SIGTERM", close);
    process.off("SIGINT", close);
    if (server.listening) close();
    await serialized(pause).catch(() => {});
  }
}
