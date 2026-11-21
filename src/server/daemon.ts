import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  assertPrivateDaemonDirectory,
  assertPrivateDaemonSocket,
  daemonControlLimit,
  daemonControlPath,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-protocol.js";
import { loadWebAssets, startServer } from "./server.js";

const maxViews = 32;
const viewIdleMs = 6 * 60 * 60 * 1_000;
const sweepIntervalMs = 15 * 60 * 1_000;

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
  if ((value.action === "status" || value.action === "stop") && Object.keys(value).length === 1)
    return { action: value.action };
  if (
    value.action !== "open" ||
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
  return { action: "open", target, diff };
}

export async function serveDaemon(socketPath: string): Promise<void> {
  if (
    !path.isAbsolute(socketPath) ||
    socketPath !== path.resolve(socketPath) ||
    !/^d-[a-f0-9]+\.sock$/u.test(path.basename(socketPath)) ||
    Buffer.byteLength(socketPath) > 103
  )
    throw new Error("MIRU の常駐ソケットの場所が不正です。");
  await assertPrivateDaemonDirectory(path.dirname(socketPath));
  // Refuse to advertise readiness before checking the viewer assets.
  const loadedAssets = await loadWebAssets();
  type View = Awaited<ReturnType<typeof startServer>>;
  const views = new Map<View, () => number>();
  const opening = new Set<Promise<View>>();
  let stopping = false;
  let closingControl = false;
  let closingViews: Promise<unknown> | undefined;
  let notifyStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    notifyStopped = resolve;
  });

  function expireIdleViews() {
    const cutoff = Date.now() - viewIdleMs;
    for (const [view, lastActivity] of views) {
      if (lastActivity() >= cutoff) continue;
      views.delete(view);
      void view.close().catch(() => {});
    }
  }
  function closeViews() {
    if (!closingViews) {
      closingViews = Promise.allSettled([...views.keys()].map((view) => view.close()));
      views.clear();
    }
    return closingViews;
  }
  function close() {
    if (closingControl) return;
    closingControl = true;
    stopping = true;
    void closeViews();
    server.close(() => notifyStopped());
    server.closeAllConnections();
  }

  function stop() {
    close();
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
    const status = () => ({ ok: true as const, pid: process.pid, views: views.size });
    if (command.action === "status") {
      reply(response, 200, status());
      return;
    }
    if (command.action === "stop") {
      stopping = true;
      response.once("close", close);
      // Avoid waiting for arbitrary filesystem completion before shutting down
      // browser listeners that are already serving a view.
      await closeViews();
      if (response.destroyed) close();
      else reply(response, 200, status());
      return;
    }
    expireIdleViews();
    if (views.size + opening.size >= maxViews) {
      reply(response, 409, {
        ok: false,
        error: "MIRU の表示が上限に達しました。MIRU を再起動してください。",
      });
      return;
    }
    let lastActivity = Date.now();
    const pending = startServer({
      target: command.target,
      diff: command.diff,
      loadedAssets,
      onActivity: () => {
        lastActivity = Date.now();
      },
    });
    opening.add(pending);
    try {
      const view = await pending;
      if (stopping || response.destroyed) {
        await view.close();
        if (stopping && !response.destroyed)
          reply(response, 503, { ok: false, error: "MIRU は停止中です。" });
        return;
      }
      views.set(view, () => lastActivity);
      reply(response, 200, { ...status(), url: view.url });
    } catch {
      reply(response, 400, { ok: false, error: "指定されたファイル・フォルダを開けません。" });
    } finally {
      opening.delete(pending);
    }
  }

  const server = createServer(
    { headersTimeout: 5_000, requestTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    (request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent)
          reply(response, 500, { ok: false, error: "MIRU の操作に失敗しました。" });
        else response.destroy();
      });
    },
  );
  server.maxConnections = 16;
  server.setTimeout(30_000);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const sweeper = setInterval(expireIdleViews, sweepIntervalMs).unref();
  try {
    await chmod(socketPath, 0o600);
    await assertPrivateDaemonSocket(socketPath);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await stopped;
  } finally {
    clearInterval(sweeper);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    close();
    await stopped;
    await closeViews();
    await Promise.allSettled(opening);
  }
}
