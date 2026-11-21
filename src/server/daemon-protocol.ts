import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const socketNamePattern = /^d-[a-f0-9]{16}\.sock$/u;
export const daemonActiveFile = "active";
export const daemonControlPath = "/control";
export const daemonControlLimit = 32 * 1024;
export const residentHost = "127.0.0.1";
export const defaultResidentPort = 41783;
export const launchGrantTtlMs = 120_000;

export function residentPort() {
  const input = process.env.MIRU_PORT;
  if (input === undefined) return defaultResidentPort;
  const port = Number(input);
  if (!/^[1-9][0-9]{3,4}$/u.test(input) || port < 1024 || port > 65_535) {
    throw new Error("MIRU_PORT は 1024〜65535 の固定ポートを指定してください。");
  }
  return port;
}

// Do not expose a checkout path in the protocol. An activated build directory
// is immutable and uniquely named, including across independent linked clones.
export function entryGeneration(entry: string): string {
  return createHash("sha256").update(entry).digest("hex");
}

export type DaemonRequest =
  | { action: "status" }
  | { action: "stop" }
  | { action: "pause" }
  | { action: "listen" }
  | { action: "open" | "launch"; target?: string; diff?: boolean };

export type DaemonResponse =
  | {
      ok: true;
      pid: number;
      // Kept on the private wire so an older updater can start the new daemon.
      views: number;
      generation?: string;
      port?: number;
      listening?: boolean;
      url?: string;
    }
  | { ok: false; error: string };

export async function assertPrivateDaemonDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    !process.getuid ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new Error("MIRU の常駐ディレクトリは現在のユーザー専用（0700）にしてください。");
  }
}

export async function assertPrivateDaemonSocket(socket: string): Promise<void> {
  const info = await lstat(socket);
  if (
    !info.isSocket() ||
    !process.getuid ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600
  ) {
    throw new Error("MIRU の常駐ソケットは現在のユーザー専用（0600）にしてください。");
  }
}

export async function readPublishedDaemon(directory: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path.join(directory, daemonActiveFile),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
