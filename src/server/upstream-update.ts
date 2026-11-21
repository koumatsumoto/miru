import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { checkoutEnvironment } from "./git-environment.js";

const exec = promisify(execFile);
const official =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/|ssh:\/\/git@ssh\.github\.com:443\/)koumatsumoto\/miru(?:\.git)?\/?$/iu;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "branch.main.mergeOptions=",
      "-C",
      root,
      ...args,
    ],
    {
      env: {
        ...checkoutEnvironment(),
        GIT_CONFIG_COUNT: "0",
        GIT_ALLOW_PROTOCOL: "https:ssh",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return stdout.replace(/\r?\n$/u, "");
}

function refused(reason: string): never {
  throw new Error(
    `miru update: ${reason} To build your own edits without Git or npm ci, use miru update --local.`,
  );
}

async function checkoutHead(root: string): Promise<string> {
  if ((await git(root, "rev-parse", "--show-toplevel").catch(() => "")) !== root)
    refused("The linked source must be the root of a Git checkout.");
  if ((await git(root, "symbolic-ref", "--quiet", "HEAD").catch(() => "")) !== "refs/heads/main")
    refused("The linked checkout is not on main; no branch was switched.");
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
    "BISECT_START",
  ]) {
    const state = await lstat(path.join(gitDir, name)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (state) refused("Finish the in-progress Git operation first.");
  }
  if (
    await git(
      root,
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    )
  )
    refused("There are uncommitted or untracked files; no changes were stashed or overwritten.");
  // status intentionally overlooks assume-unchanged/skip-worktree entries; don't
  // treat a sparse or otherwise partially hidden working tree as a clean clone.
  if (/^(?:[a-z]|S) /mu.test(await git(root, "ls-files", "-v")))
    refused("The checkout has hidden index entries (assume-unchanged/skip-worktree).");
  const head = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  if (!oid.test(head)) refused("Could not identify the checked-out commit.");
  return head;
}

async function officialOrigin(root: string): Promise<string> {
  // Check configured and rewritten destinations, then fetch the exact URL, not
  // an arbitrary remote helper, uploadpack, refspec or branch tracking config.
  const raw = await git(root, "config", "--get-all", "remote.origin.url").catch(() => "");
  const resolved = await git(root, "remote", "get-url", "--all", "origin").catch(() => "");
  if (!official.test(raw) || !official.test(resolved))
    refused("origin must point directly to github.com/koumatsumoto/miru (HTTPS or SSH).");
  return raw;
}

export interface UpstreamUpdate {
  revision: string;
  buildFrom: (task: (source: string) => Promise<void>) => Promise<void>;
  advance: () => Promise<boolean>;
}

// Only called by the explicit CLI update command. Never derive a checkout or
// remote from a browsed folder, the invoking shell's cwd, or UI input.
export async function withUpstreamUpdate<T>(
  root: string,
  run: (update: UpstreamUpdate) => Promise<T>,
): Promise<T> {
  const head = await checkoutHead(root);
  const url = await officialOrigin(root);
  const ref = `refs/miru/update-${randomUUID()}`;
  try {
    await git(
      root,
      "fetch",
      "--atomic",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      url,
      `refs/heads/main:${ref}`,
      "+refs/heads/main:refs/remotes/origin/main",
    ).catch(() => {
      throw new Error(
        "Cannot fetch official origin/main. Check the network and Git credentials; the running MIRU server was not changed.",
      );
    });
    const revision = await git(root, "rev-parse", "--verify", `${ref}^{commit}`);
    if (!oid.test(revision)) refused("Could not identify the fetched GitHub main commit.");
    await git(root, "merge-base", "--is-ancestor", head, revision).catch(() => {
      refused("Local main is ahead, diverged, or has insufficient history for a fast-forward.");
    });
    return await run({
      revision,
      buildFrom: async (task) => {
        const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "miru-source-")));
        const source = path.join(parent, "source");
        try {
          await git(root, "worktree", "add", "--detach", source, revision);
          try {
            // Never remove/replace the linked checkout's node_modules, even on
            // install failure. No dependency lifecycle scripts, audit or funding calls.
            const npm = spawn(
              "npm",
              [
                "ci",
                "--prefix",
                source,
                "--include=dev",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
              ],
              {
                cwd: source,
                env: checkoutEnvironment(),
                stdio: "inherit",
              },
            );
            const [code] = await once(npm, "exit");
            if (code !== 0) throw new Error("npm ci failed for the fetched revision.");
            await task(source);
          } finally {
            // This is our freshly created private, disposable detached worktree.
            await git(root, "worktree", "remove", "--force", source);
          }
        } finally {
          await rm(parent, { recursive: true, force: true });
        }
      },
      advance: async () => {
        // A fetch/build can take time: recheck the user's actual branch and
        // index just before the fast-forward. Never stash, reset, or force it.
        if ((await checkoutHead(root)) !== head || (await officialOrigin(root)) !== url)
          refused("The linked checkout changed during the update; retry when it is stable.");
        if (head !== revision) {
          await git(
            root,
            "merge",
            "--ff-only",
            "--no-autostash",
            "--no-overwrite-ignore",
            "--no-edit",
            revision,
          ).catch(() => {
            refused("Cannot fast-forward safely; check for a conflicting local or ignored file.");
          });
          if ((await git(root, "rev-parse", "HEAD")) !== revision)
            refused("The checkout no longer matches the candidate.");
        }
        return head !== revision;
      },
    });
  } finally {
    await git(root, "update-ref", "-d", ref).catch(() => {});
  }
}
