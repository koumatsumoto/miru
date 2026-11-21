// Invoked by daemon-smoke.mjs with its private HOME, runtime and already-open
// views. Only Git's SSH transport is simulated; commits, worktrees, npm ci,
// builds, daemon boots, checkout updates and HTTP requests are real and local.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const origin = "git@github.com:koumatsumoto/miru.git";

export async function verifyUpstream({
  root,
  checkout,
  env,
  command,
  assertOld,
  checkContinuity,
  resident,
  openView,
}) {
  const git = async (cwd, ...args) =>
    (await exec("git", ["-C", cwd, ...args], { env })).stdout.trim();
  const npm = async (cwd, ...args) => exec("npm", args, { cwd, env });
  const bare = env.MIRU_SMOKE_REMOTE;
  const author = path.join(root, "author");
  const gitHere = (...args) => git(checkout, ...args);
  const gitThere = (...args) => git(author, ...args);
  const commit = async (inRepo, message) => {
    await inRepo("add", "-A");
    await inRepo(
      "-c",
      "user.name=MIRU fixture",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      message,
    );
  };
  const fixture = { MIRU_SMOKE_UPSTREAM: "1", MIRU_SMOKE_BUILD: "upstream-ready" };
  const old = await resident("status");
  const reject = async (pattern, extra = {}) => {
    await assert.rejects(
      command(["update"], { ...fixture, ...extra }),
      (e) => !e.killed && e.code === 1 && pattern.test(e.stderr),
    );
    await assertOld(old);
  };
  await writeFile(
    env.GIT_SSH_COMMAND,
    `#!/bin/sh
case "$*" in
  *"git@github.com git-upload-pack 'koumatsumoto/miru.git'")
    test "$MIRU_SMOKE_FETCH" != "fail" || exit 72
    exec git-upload-pack "$MIRU_SMOKE_REMOTE"
    ;;
  *) exit 73 ;;
esac
`,
    { mode: 0o700 },
  );
  await reject(/root of a Git checkout/);
  await gitHere("init", "-q", "-b", "main");
  await writeFile(
    path.join(checkout, ".gitignore"),
    ".cache/\ndist/\nnode_modules/\nignored.fixture\n",
  );
  await npm(
    checkout,
    "install",
    "--package-lock-only",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  );
  await commit(gitHere, "initial checkout");
  const base = await gitHere("rev-parse", "HEAD");
  await git(root, "init", "-q", "--bare", "-b", "main", bare);
  await gitHere("push", bare, "main");
  await git(root, "clone", "-q", bare, author);
  await gitHere("remote", "add", "origin", "https://github.com/other/miru.git");
  await reject(/origin must point directly/);
  await gitHere("remote", "set-url", "origin", origin);
  await gitHere("config", "url.file:///untrusted.insteadOf", origin);
  await reject(/origin must point directly/);
  await gitHere("config", "--unset", "url.file:///untrusted.insteadOf");
  await reject(/Cannot fetch official/, { MIRU_SMOKE_FETCH: "fail" });
  await gitHere("switch", "-qc", "feature");
  await reject(/not on main/);
  assert.equal(await gitHere("branch", "--show-current"), "feature");
  await gitHere("switch", "--detach", "-q", base);
  await reject(/not on main/);
  await gitHere("switch", "-q", "main");
  const dirty = path.join(checkout, "new-note");
  await writeFile(dirty, "keep me");
  await reject(/uncommitted or untracked/);
  await gitHere("add", "new-note");
  await reject(/uncommitted or untracked/);
  assert.equal(await readFile(dirty, "utf8"), "keep me");
  await gitHere("restore", "--staged", "new-note");
  await rm(dirty);
  await commit(gitHere, "local-only commit");
  const ahead = await gitHere("rev-parse", "HEAD");
  await reject(/ahead, diverged/);

  // The new revision really needs a dependency missing from the linked clone.
  const pkg = JSON.parse(await readFile(path.join(author, "package.json"), "utf8"));
  pkg.devDependencies = { "miru-smoke-feature": "file:./vendor/feature" };
  await mkdir(path.join(author, "vendor/feature"), { recursive: true });
  await writeFile(
    path.join(author, "vendor/feature/package.json"),
    JSON.stringify({ name: "miru-smoke-feature", version: "1.0.0" }),
  );
  await writeFile(path.join(author, "vendor/feature/revision"), "remote-only");
  await writeFile(path.join(author, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(author, "ignored.fixture"), "upstream");
  await gitThere("add", "-f", "ignored.fixture");
  await commit(gitThere, "new feature without matching lock");
  await gitThere("push", "origin", "main");
  await reject(/ahead, diverged/);
  assert.equal(await gitHere("rev-parse", "HEAD"), ahead);
  // Keep the local-only commit on a branch in this disposable fixture.
  await gitHere("switch", "-qc", "local-only");
  await gitHere("branch", "-f", "main", base);
  await gitHere("switch", "-q", "main");
  await mkdir(path.join(checkout, "node_modules"), { recursive: true });
  const sentinel = path.join(checkout, "node_modules/keep");
  await writeFile(sentinel, "keep my dependencies");
  await reject(/dependency installation\/build failed/);
  assert.equal(await gitHere("rev-parse", "HEAD"), base);
  assert.equal(await readFile(sentinel, "utf8"), "keep my dependencies");
  await npm(
    author,
    "install",
    "--package-lock-only",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  );
  await commit(gitThere, "lock new dependency");
  await gitThere("push", "origin", "main");
  const target = await gitThere("rev-parse", "HEAD");

  await reject(/dependency installation\/build failed/, { MIRU_SMOKE_BUILD: "fail" });
  await reject(/起動時に終了/u, { MIRU_SMOKE_BUILD: "bad" });
  await reject(/uncommitted or untracked/, { MIRU_SMOKE_EDIT_DURING_BUILD: dirty });
  assert.equal(await readFile(dirty, "utf8"), "keep my edit");
  await rm(dirty);
  const ignored = path.join(checkout, "ignored.fixture");
  await writeFile(ignored, "my ignored data");
  await reject(/Cannot fast-forward safely/);
  assert.equal(await readFile(ignored, "utf8"), "my ignored data");
  assert.equal(await gitHere("rev-parse", "HEAD"), base);
  await rm(ignored);

  // Fail the launcher publish after Git already advanced. The same command
  // must be safe to retry, without a destructive reset or a lost old view.
  const pointer = path.join(checkout, ".cache/miru-builds/active.json");
  await rename(pointer, pointer + ".saved");
  await mkdir(pointer);
  try {
    await reject(/Local main was already fast-forwarded.*previous server/u);
    assert.equal(await gitHere("rev-parse", "HEAD"), target);
  } finally {
    await rm(pointer, { recursive: true });
    await rename(pointer + ".saved", pointer);
  }

  assert.match(
    await command(["update"], {
      ...fixture,
      GIT_DIR: path.join(root, "unrelated"),
      GIT_INDEX_FILE: path.join(root, "wrong-index"),
    }),
    new RegExp(target.slice(0, 12)),
  );
  assert.equal(await gitHere("rev-parse", "HEAD"), target);
  assert.equal(await gitHere("rev-parse", "refs/remotes/origin/main"), target);
  assert.equal(await gitHere("status", "--porcelain=v1"), "");
  assert.equal(await gitHere("for-each-ref", "refs/miru"), "");
  assert.equal((await gitHere("worktree", "list", "--porcelain")).split("worktree ").length, 2);
  assert.equal(await readFile(sentinel, "utf8"), "keep my dependencies");
  assert.equal(await readFile(env.MIRU_SMOKE_INVOKED, "utf8"), "upstream-ready");
  const updated = await resident("status");
  assert.notEqual(updated.pid, old.pid);
  assert.equal(updated.port, old.port);
  await checkContinuity();
  const nextView = await openView();
  assert(
    nextView.html.includes("miru-test-generation"),
    "the current upstream build serves reopened views",
  );
  const withView = await resident("status");
  assert.match(await command(["update"], { ...fixture, MIRU_SMOKE_BUILD: "fail" }), /すでに最新版/);
  assert.deepEqual(await resident("status"), withView);
  assert.equal(await readFile(env.MIRU_SMOKE_INVOKED, "utf8"), "upstream-ready");
  console.log(
    "PASS: one-command fast-forward from pinned official main, new locked dependency, guarded failures, retained views and no-op retry (offline simulated transport).",
  );
}
