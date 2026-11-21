#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server/server.js";
import { openBrowser } from "./server/browser.js";
import { serveDaemon } from "./server/daemon.js";
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

function printStatus(state: { pid: number; views: number } | null | undefined) {
  console.log(
    state ? `MIRU server: pid=${state.pid} views=${state.views}` : "MIRU server: stopped",
  );
}

async function show(url: string) {
  console.log(`MIRU: ${url}`);
  if (process.env.MIRU_NO_OPEN === "1" || process.env.EV_NO_OPEN === "1") return;
  try {
    await openBrowser(url);
  } catch {
    console.error("ブラウザを起動できませんでした。表示されたlocalhost URLを開いてください。");
  }
}

async function main() {
  if (raw[0] === "--internal-server") {
    if (!supportsResident || raw.length !== 2) throw new Error("Invalid MIRU server startup.");
    await serveDaemon(raw[1]);
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
  miru stop             Stop the server and close its views
  miru update           Build the development checkout and restart
  miru --foreground [path | diff]   Run this view until Ctrl+C

Background server: WSL/Linux/macOS. Windows Node uses foreground mode.`);
    return;
  }

  let args = raw;
  const foreground = args[0] === "--foreground";
  if (foreground) args = args.slice(1);
  const literal = args[0] === "--";
  if (literal) args = args.slice(1);
  if (args.length > 1 || (literal && args.length !== 1))
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
      case "update":
        await updateLocalBuild(entry, async (candidate) => {
          const state = await replaceResident(candidate);
          if (state.warning) console.error(`MIRU: ${state.warning}`);
        });
        console.log(
          "MIRU: 更新して再起動しました。以前のタブは miru <path> で開き直してください。",
        );
        return;
    }
  }

  const diff = !literal && command === "diff";
  const options = { target: command ? path.resolve(diff ? "." : command) : undefined, diff };
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
