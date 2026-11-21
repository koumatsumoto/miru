import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./workspace.js";
import { createViewerOperation, type ViewerOptions } from "./viewer-operations.js";
import { mermaidFrameCsp, mermaidFrameDocument } from "../shared/mermaid.js";
export interface WebAssets {
  readonly index: string;
  readonly assets: ReadonlyMap<string, Buffer>;
}

export interface ServerOptions extends ViewerOptions {
  port?: number;
  // Daemon-private persistent secret; only a domain-separated bearer leaves the server.
  authToken?: string;
  redeemGrant?: (grant: string) => { target?: string; diff: boolean } | undefined;
  webRoot?: string;
  loadedAssets?: WebAssets;
  onActivity?: () => void;
}

export async function loadWebAssets(
  webRoot = fileURLToPath(new URL("./web/", import.meta.url)),
): Promise<WebAssets> {
  const assets = new Map<string, Buffer>();
  const index = await readFile(path.join(webRoot, "index.html"), "utf8");
  if (!index.includes("__EV_SESSION__")) throw new Error("The MIRU web bundle is incomplete.");
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!/^[\w.-]+$/u.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(filename, url);
      else if (entry.isFile()) assets.set(url, await readFile(filename));
    }
  }
  await walk(path.join(webRoot, "assets"), "/assets");
  return { index, assets };
}

export async function startServer(options: ServerOptions = {}) {
  const secret = options.authToken ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/u.test(secret)) throw new Error("Invalid MIRU session credential.");
  const derive = (purpose: string) =>
    createHmac("sha256", Buffer.from(secret, "hex")).update(purpose).digest();
  const apiKey = derive("miru-api-v1");
  const token = apiKey.toString("hex");
  const operation = createViewerOperation(options, derive("miru-file-ids-v1"));
  const { assets, index: template } =
    options.loadedAssets ?? (await loadWebAssets(options.webRoot));
  // The public, fixed-origin resident shell never contains a launch path, grant
  // or API credential. The temporary, loopback-only foreground viewer retains
  // its own independent bootstrap for direct invocation and testing.
  const index = template.replace("__EV_SESSION__", options.authToken === undefined ? token : "");
  let origin = "";
  let pending = 0;
  const server = createServer((request, response) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    const reject = (status: number) => {
      response.writeHead(status, { "Content-Type": "text/plain" });
      response.end("このリクエストは拒否されました。");
    };
    const allowedHost = new URL(origin).host;
    if (
      request.headers.host !== allowedHost ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return reject(403);
    if (request.url === "/api" && request.method !== "POST") return reject(405);
    if (request.url === "/api" && request.method === "POST") {
      const supplied = request.headers["x-ev-session"];
      if (
        request.headers.origin !== origin ||
        typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/u.test(supplied) ||
        !/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")
      )
        return reject(403);
      const authenticated = timingSafeEqual(Buffer.from(supplied, "hex"), apiKey);
      if (!authenticated && !options.redeemGrant) return reject(403);
      if (pending >= 32) return reject(429);
      pending++;
      // Scopes and selections are request-local. A slow HOME search in one tab
      // need not queue a read/selection in another tab.
      void (async () => {
        try {
          const body = await readBody(request);
          if (body.op === "connect") {
            const launch = options.authToken && options.redeemGrant?.(supplied);
            if (!launch) return reject(403);
            return json(response, 200, { token, target: launch.target, diff: launch.diff });
          }
          if (!authenticated) return reject(403);
          options.onActivity?.();
          json(response, 200, await operation(body));
        } catch (error) {
          if (!authenticated) return reject(403);
          json(response, error instanceof UserError ? 400 : 422, {
            error:
              error instanceof UserError
                ? error.message
                : "この項目を読み込めません。アクセス権を確認し、フォルダを更新してください。",
          });
        } finally {
          pending--;
        }
      })();
      return;
    }
    if (request.method !== "GET") return reject(405);
    if (request.url === "/renderer/mermaid") {
      const bundle = assets.get("/assets/mermaid.tiny.js");
      if (!bundle) return reject(404);
      const nonce = randomBytes(16).toString("hex");
      // Public bundled code only, no session token or file content. The caller
      // must still pass normal Host/Origin checks; API checks are unchanged.
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      response.setHeader(
        "Content-Security-Policy",
        `${mermaidFrameCsp(nonce)}; frame-ancestors ${origin}`,
      );
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(mermaidFrameDocument(bundle.toString("utf8"), nonce));
      return;
    }
    if (request.url === "/") {
      options.onActivity?.();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(index);
      return;
    }
    const asset = assets.get(request.url ?? "");
    if (!asset) return reject(404);
    const type =
      request.url!.endsWith(".js") || request.url!.endsWith(".mjs")
        ? "text/javascript"
        : request.url!.endsWith(".css")
          ? "text/css"
          : request.url!.endsWith(".wasm")
            ? "application/wasm"
            : request.url!.endsWith(".svg")
              ? "image/svg+xml"
              : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type });
    response.end(asset);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind loopback.");
  origin = `http://${options.authToken === undefined ? "localhost" : "127.0.0.1"}:${address.port}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw new UserError("リクエストが大きすぎます。");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UserError("JSON形式が不正です。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UserError("リクエストが不正です。");
  return value as Record<string, unknown>;
}
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
