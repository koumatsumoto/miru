#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server/server.js";
import { openBrowser } from "./server/browser.js";
import { serveDaemon } from "./server/daemon.js";
import { residentHost } from "./server/daemon-protocol.js";
import {
  ensureResident,
  openResident,
  replaceResident,
  residentStatus,
  stopResident,
} from "./server/daemon-client.js";
import { preferredEntry, updateLocalBuild } from "./server/local-update.js";

const raw = process.argv.slice(2);
const entry = fileURLToPath(import.meta.url);
const supportsResident = process.platform === "linux" || process.platform === "darwin";

function printStatus(
  state: { pid: number; views: number; port?: number; listening?: boolean } | null | undefined,
) {
  const detail = state?.port
    ? `port=${state.port}${state.listening ? "" : " (paused)"}`
    : `views=${state?.views ?? 0} (legacy)`;
  console.log(state ? `MIRU server: pid=${state.pid} ${detail}` : "MIRU server: stopped");
}

async function show(url: string) {
  const manual = () => {
    console.log(`MIRU: ${url}`);
    if (new URL(url).hash)
      console.error("起動リンクは2分間・1回限りです。開けなければ miru を実行し直してください。");
  };
  if (process.env.MIRU_NO_OPEN === "1" || process.env.EV_NO_OPEN === "1") {
    manual();
    return;
  }
  try {
    await openBrowser(url);
    const { hostname, port, hash } = new URL(url);
    console.log(
      hash
        ? `MIRU: ブラウザーで開きました (${residentHost}:${port})。`
        : `MIRU: http://${hostname}:${port}/`,
    );
  } catch {
    manual();
    console.error("ブラウザーを起動できませんでした。上のローカル URL を開いてください。");
  }
}

async function main() {
  if (raw[0] === "--internal-server") {
    const parentPid =
      raw.length === 4 && raw[2] === "--prepare" && /^[1-9][0-9]*$/u.test(raw[3])
        ? Number(raw[3])
        : undefined;
    if (!supportsResident || (raw.length !== 2 && !Number.isSafeInteger(parentPid)))
      throw new Error("Invalid MIRU server startup.");
    await serveDaemon(raw[1], entry, parentPid);
    return;
  }

  // npm link stays on the stable checkout launcher. A successful update also
  // makes new CLI behavior available, without changing the link or live dist.
  const activeEntry = await preferredEntry(entry);
  if (activeEntry !== entry) {
    const activeCli = spawn(process.execPath, [activeEntry, ...raw], { stdio: "inherit" });
    const [code] = await once(activeCli, "exit");
    process.exitCode = typeof code === "number" ? code : 1;
    return;
  }

  if (raw.length === 1 && (raw[0] === "--help" || raw[0] === "-h")) {
    console.log(`MIRU (read-only browser viewer)

  miru [path]           Open HOME, a directory, or a file
  miru diff             Open the current repository in diff mode
  miru -- <path>        Open a literal name such as update
  miru server           Start or reuse the local background server
  miru status           Show whether the server is running
  miru stop             Stop the fixed-port background server
  miru update           Fetch official main, build and update the linked checkout/server
  miru update --local   Build current local edits without fetching or installing
  miru --foreground [path | diff]   Run this view until Ctrl+C

Background server: WSL/Linux/macOS. Windows Node uses foreground mode.`);
    return;
  }

  let args = raw;
  const foreground = args[0] === "--foreground";
  if (foreground) args = args.slice(1);
  const literal = args[0] === "--";
  if (literal) args = args.slice(1);
  const localUpdate =
    !literal && !foreground && args.length === 2 && args[0] === "update" && args[1] === "--local";
  if ((args.length > 1 && !localUpdate) || (literal && args.length !== 1))
    throw new Error("使い方: miru [path | diff | server | status | stop | update]");
  const command = args[0];

  if (
    !literal &&
    !foreground &&
    command &&
    ["server", "status", "stop", "update"].includes(command)
  ) {
    if (!supportsResident)
      throw new Error(
        "常駐サーバーはWSL/Linux/macOSで利用できます。Windowsでは前面起動を使ってください。",
      );
    switch (command) {
      case "server":
        printStatus(await ensureResident(entry));
        return;
      case "status":
        printStatus(await residentStatus());
        return;
      case "stop":
        await stopResident();
        printStatus(null);
        return;
      case "update": {
        const result = await updateLocalBuild(
          entry,
          localUpdate ? "local" : "upstream",
          replaceResident,
        );
        if (result.warning) console.error(`MIRU: ${result.warning}`);
        const revision = result.revision ? ` (main ${result.revision.slice(0, 12)})` : "";
        console.log(
          result.unchanged
            ? `MIRU: すでに最新版です${revision}。開いているタブはそのまま使えます。`
            : result.migrated
              ? `MIRU: 更新しました${revision}。旧方式のタブだけ一度 miru <path> で開き直してください。`
              : `MIRU: 更新しました${revision}。同じ URL のタブを再読み込みできます。`,
        );
        return;
      }
    }
  }

  const diff = !literal && command === "diff";
  const options = { target: command ? path.resolve(diff ? "." : command) : undefined, diff };
  if (options.target) {
    const info = await stat(options.target).catch(() => undefined);
    if (!info) throw new Error("指定されたファイル・フォルダを開けません。");
    if (!info.isFile() && !info.isDirectory())
      throw new Error("通常のファイル・フォルダだけを開けます。");
  }
  if (supportsResident && !foreground) {
    const view = await openResident(entry, options);
    await show(view.url);
    return;
  }

  const server = await startServer(options);
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await show(server.url);
  console.log("Ctrl+Cで終了します。");
}

try {
  await main();
} catch (error) {
  console.error(`MIRU: ${error instanceof Error ? error.message : "起動できませんでした。"}`);
  process.exitCode = 1;
}
