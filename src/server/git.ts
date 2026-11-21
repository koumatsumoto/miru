import { execFile } from "node:child_process";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { readRegular } from "./files.js";
import { inside, UserError } from "./workspace.js";
export interface GitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}
export interface GitDiff {
  before: string;
  after: string;
  binary: boolean;
  message?: string;
  notice?: string;
}
const LIMIT = 2 * 1024 * 1024;
import { checkoutEnvironment } from "./git-environment.js";
async function git(repo: string, args: string[], input?: Buffer): Promise<Buffer> {
  const checkIgnore = args[0] === "check-ignore";
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        "--no-optional-locks",
        // check-ignore rejects even plain names under --literal-pathspecs.
        // Its caller passes ./-prefixed, NUL-delimited names via stdin instead.
        ...(checkIgnore ? [] : ["--literal-pathspecs"]),
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "status.submoduleSummary=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "diff.external=",
        "-c",
        "core.pager=cat",
        "-C",
        repo,
        ...args,
      ],
      {
        encoding: "buffer",
        maxBuffer: LIMIT,
        timeout: 6000,
        windowsHide: true,
        env: {
          ...checkoutEnvironment(),
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          // Defense in depth for Git versions/configuration that still attempt a fetch.
          GIT_ALLOW_PROTOCOL: "",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          GIT_EXTERNAL_DIFF: "",
          GIT_CONFIG_COUNT: "0",
          GIT_LITERAL_PATHSPECS: "0",
          GIT_GLOB_PATHSPECS: "0",
          GIT_NOGLOB_PATHSPECS: "0",
          GIT_ICASE_PATHSPECS: "0",
        },
      },
      (error, stdout) =>
        error && !(checkIgnore && error.code === 1) ? reject(error) : resolve(stdout),
    );
    if (input !== undefined) {
      child.stdin?.on("error", reject);
      child.stdin?.end(input);
    }
  });
}
export async function detectRepository(top: string): Promise<string | null> {
  try {
    return (await git(top, ["rev-parse", "--show-toplevel"]))
      .toString("utf8")
      .replace(/\r?\n$/u, "");
  } catch {
    return null;
  }
}

// Never pass directory contents as a shell command or one unbounded argument
// list. Each input and its possible check-ignore output fit under LIMIT.
function* nameBatches(names: Iterable<string>, byteLimit: number) {
  let batch: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const size = Buffer.byteLength(name) + 1;
    if (batch.length && bytes + size > byteLimit) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(name);
    bytes += size;
  }
  if (batch.length) yield batch;
}

// Only the names just listed from this canonical directory are supplied.
// Running inside it lets Git select the correct nested repository/submodule.
export async function ignoredNames(repo: string, directory: string, names: string[]) {
  const ignored = new Set<string>();
  if (!names.length) return ignored;
  const parts = path.relative(repo, directory).split(path.sep);
  const metadata = parts.indexOf(".git");
  // It is legal to browse .git, but Git commands run *inside* it do not have
  // a work tree. Ask from its parent without hiding metadata automatically.
  const cwd = metadata < 0 ? directory : path.join(repo, ...parts.slice(0, metadata));
  const relative = path.relative(cwd, directory).split(path.sep).join("/");
  const prefix = relative ? `${relative}/` : "";
  const literalIndexChecks: string[] = [];
  const ordinary: string[] = [];
  const wild: string[] = [];
  for (const name of names) {
    const value = `./${prefix}${name}`;
    // check-ignore normally consults the index, including tracked descendants.
    // With wildcard characters Git's index check is a pathspec match, not an
    // exact filename match. Resolve just these unusual paths literally below.
    (/[?*[\\]/u.test(prefix + name) ? wild : ordinary).push(value);
  }
  try {
    for (const [paths, noIndex] of [
      [ordinary, false],
      [wild, true],
    ] as const) {
      for (const batch of nameBatches(paths, 256 * 1024)) {
        const result = await git(
          cwd,
          ["check-ignore", "-z", "--stdin", ...(noIndex ? ["--no-index"] : [])],
          Buffer.from(batch.join("\0") + "\0"),
        );
        for (const value of result.toString("utf8").split("\0")) {
          if (!value) continue;
          ignored.add(value.slice(2 + prefix.length));
          if (noIndex) literalIndexChecks.push(value);
        }
      }
    }
    // Keep tracked files and directories with any tracked descendants, even
    // when an ignore rule now matches them. Keep argv below Windows' limit.
    for (const batch of nameBatches(literalIndexChecks, 12 * 1024)) {
      const tracked = await git(cwd, ["ls-files", "--cached", "-z", "--", ...batch]);
      for (const value of tracked.toString("utf8").split("\0"))
        if (value) ignored.delete(value.slice(prefix.length).split("/")[0]);
    }
  } catch {
    throw new UserError("Gitの除外設定を読み込めません。除外フィルターをオフにして表示できます。");
  }
  return ignored;
}
export async function getStatus(repo: string, top: string): Promise<GitChange[]> {
  // status can run clean/process filters merely to compare working files, including
  // filters inherited from user/system config. Do not execute status in such repos.
  // Inspecting config reads values only; no filter commands are ever evaluated here.
  try {
    const filters = await git(repo, [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process)$",
    ]);
    if (filters.length)
      throw new UserError(
        "外部Gitフィルターが設定されているため、Git状態の取得を停止しました。通常のファイル閲覧は利用できます。",
      );
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  const relative = path.relative(repo, top).split(path.sep).join("/") || ".";
  const records = (
    await git(repo, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      relative,
    ])
  )
    .toString("utf8")
    .split("\0");
  const result: GitChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const target = path.resolve(repo, record.slice(3));
    const change: GitChange = { path: target, indexStatus: record[0], worktreeStatus: record[1] };
    if ("RC".includes(record[0]) || "RC".includes(record[1]))
      change.originalPath = path.resolve(repo, records[++i]);
    if (inside(top, target)) result.push(change);
    // A rename leaving the subtree still needs a deleted source entry.
    if (change.originalPath && inside(top, change.originalPath) && !inside(top, target))
      result.push({ ...change, path: change.originalPath, indexStatus: "D" });
  }
  return result;
}
async function hasHead(repo: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    // Only a symbolic HEAD whose branch ref does not exist is an unborn branch.
    // A damaged/missing referenced object is not an empty side of the diff.
    const ref = (await git(repo, ["symbolic-ref", "--quiet", "HEAD"])).toString("utf8").trim();
    try {
      await git(repo, ["show-ref", "--verify", "--quiet", ref]);
    } catch (refError) {
      if ((refError as { code?: number }).code === 1) return false;
      throw refError;
    }
    throw error;
  }
}
async function blob(repo: string, rev: string, target: string): Promise<Buffer> {
  const relative = path.relative(repo, target).split(path.sep).join("/");
  if (!inside(repo, target)) throw new Error("Path outside repository.");
  if (rev && !(await hasHead(repo))) return Buffer.alloc(0);
  const records = (
    await git(
      repo,
      rev
        ? ["ls-tree", "-z", "HEAD", "--", relative]
        : ["ls-files", "--stage", "-z", "--", relative],
    )
  )
    .toString("utf8")
    .split("\0");
  const record = records.find((entry) => entry.slice(entry.indexOf("\t") + 1) === relative);
  if (!record) return Buffer.alloc(0); // A genuinely absent path, not a missing blob.
  const metadata = record.slice(0, record.indexOf("\t")).split(" ");
  const [mode, second, third] = metadata;
  if (mode === "160000") throw new UserError("サブモジュールの内容は差分表示できません。");
  if ((!rev && third !== "0") || (rev && second !== "blob"))
    throw new UserError("このGitエントリは通常のファイルではありません。");
  const oid = rev ? third : second;
  if (!/^[a-f0-9]{40,64}$/u.test(oid)) throw new UserError("Gitオブジェクトを確認できません。");
  try {
    return await git(repo, ["cat-file", "blob", oid]);
  } catch (error) {
    if ((error as { code?: number }).code === 128 || (error as { code?: number }).code === 1)
      throw new UserError(
        "Gitオブジェクトがローカルにないか破損しています。自動取得はしません。通常のファイル閲覧を利用してください。",
      );
    throw error;
  }
}
export async function readDiff(
  repo: string,
  file: string,
  stage: "staged" | "unstaged",
  changes: GitChange[],
  root?: string,
): Promise<GitDiff> {
  const boundary = root ?? repo;
  if (!inside(boundary, file)) throw new UserError("比較対象が表示範囲外です。");
  const change = changes.find((item) => item.path === file);
  if (
    change &&
    (change.indexStatus === "U" ||
      change.worktreeStatus === "U" ||
      ["AA", "DD"].includes(change.indexStatus + change.worktreeStatus))
  )
    return {
      before: "",
      after: "",
      binary: false,
      message: "競合が未解決です。MIRUの外で解決してください。",
    };
  let before: Buffer, after: Buffer;
  let notice: string | undefined;
  if (stage === "staged") {
    const source = change?.originalPath ?? file;
    if (!inside(boundary, source)) {
      before = Buffer.alloc(0);
      notice = "移動元が表示範囲外のため、変更前は読み込まず追加として表示します。";
    } else before = await blob(repo, "HEAD", source);
    after = await blob(repo, "", file);
  } else {
    before = change?.indexStatus === "?" ? Buffer.alloc(0) : await blob(repo, "", file);
    try {
      after = await readRegular(file, LIMIT, root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") after = Buffer.alloc(0);
      else throw error;
    }
  }
  if (before.includes(0) || after.includes(0) || !isUtf8(before) || !isUtf8(after))
    return {
      before: "",
      after: "",
      binary: true,
      message: "バイナリの差分はテキスト表示できません。",
    };
  return {
    before: before.toString("utf8"),
    after: after.toString("utf8"),
    binary: false,
    ...(notice ? { notice } : {}),
  };
}
