import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

export const daemonControlPath = "/control";
export const daemonControlLimit = 32 * 1024;

// Do not expose a checkout path in the protocol. An activated build directory
// is immutable and uniquely named, including across independent linked clones.
export function entryGeneration(entry: string): string {
  return createHash("sha256").update(entry).digest("hex");
}

export type DaemonRequest =
  | { action: "status" }
  | { action: "stop" }
  | { action: "open"; target?: string; diff?: boolean };

export type DaemonResponse =
  | { ok: true; pid: number; views: number; generation?: string; url?: string }
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
