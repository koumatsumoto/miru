import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class UserError extends Error {}
export const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};
export function absolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  )
    throw new UserError("正規化された絶対パスを指定してください。");
  return value;
}

// One request, never a browser session. An ID carries a relative path and a
// MAC bound to its kind and canonical root; there is no process-local ID map
// to mix tabs, expire, or lose on a successful daemon handover.
export class Workspace {
  root: string | null = null;
  selected: string | null = null;
  readonly home: string;
  readonly #key: Buffer;
  constructor(home: string, key: Buffer = randomBytes(32)) {
    this.home = home;
    this.#key = key;
  }
  #mac(kind: "entry" | "search", root: string, data: string): string {
    return createHmac("sha256", this.#key)
      .update(`miru-id-v1\0${kind}\0${root}\0${data}`)
      .digest("base64url");
  }
  #encode(kind: "entry" | "search", root: string, target: string): string {
    const data = Buffer.from(path.relative(root, target)).toString("base64url");
    return `${data}.${this.#mac(kind, root, data)}`;
  }
  #decode(kind: "entry" | "search", root: string, id: unknown): string {
    const match = typeof id === "string" && /^([\w-]*)\.([\w-]{43})$/u.exec(id);
    if (
      !match ||
      !timingSafeEqual(Buffer.from(match[2]), Buffer.from(this.#mac(kind, root, match[1])))
    )
      throw new UserError("この項目は表示範囲から外れました。フォルダを更新してください。");
    const target = path.resolve(root, Buffer.from(match[1], "base64url").toString("utf8"));
    if (!inside(root, target)) throw new UserError("表示範囲外のパスです。");
    return target;
  }
  id(target: string): string {
    if (!this.root) throw new UserError("先にフォルダを開いてください。");
    return this.#encode("entry", this.root, target);
  }
  entryPath(id: unknown): string {
    if (!this.root) throw new UserError("先にフォルダを開いてください。");
    return this.#decode("entry", this.root, id);
  }
  searchId(home: string, target: string): string {
    return this.#encode("search", home, target);
  }
  searchPath(home: string, id: unknown): string {
    return this.#decode("search", home, id);
  }
  async open(target: string, boundary?: string): Promise<void> {
    const resolved = await realpath(target);
    if (boundary && !inside(boundary, resolved)) throw new UserError("表示範囲外のパスです。");
    const info = await stat(resolved);
    if (!info.isDirectory() && !info.isFile())
      throw new UserError("通常のファイル・フォルダだけを開けます。");
    this.root = info.isDirectory() ? resolved : path.dirname(resolved);
    this.selected = info.isFile() ? resolved : null;
  }
  async openHome(): Promise<void> {
    await this.open(this.home);
  }
  // The UI sends back a *canonical* root, not a new launch target. Don't
  // silently rebase a tab if its former root was replaced with a symlink.
  async restoreRoot(root: string): Promise<void> {
    const actual = await realpath(absolutePath(root));
    if (path.relative(root, actual) !== "" || !(await stat(actual)).isDirectory())
      throw new UserError(
        "表示中のフォルダが変わりました。検索欄か、ターミナルの miru <path> から開き直してください。",
      );
    this.root = actual;
  }
  async resolve(id: unknown, missing = false): Promise<string> {
    const target = this.entryPath(id);
    const root = this.root!;
    try {
      const actual = await realpath(target);
      if (!inside(root, actual))
        throw new UserError(
          "このシンボリックリンクは表示範囲外です。対象をCLIから直接指定してください。",
        );
      return actual;
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // Deleted Git paths still have to have an in-scope, non-symlink parent.
        let parent = path.dirname(target);
        for (;;) {
          try {
            const actual = await realpath(parent);
            if (!inside(root, actual)) throw new UserError("表示範囲外のパスです。");
            break;
          } catch (parentError) {
            if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
            const next = path.dirname(parent);
            if (next === parent) throw new UserError("このパスは利用できません。");
            parent = next;
          }
        }
        return target;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new UserError("この項目は見つかりません。フォルダを更新してください。");
      throw error;
    }
  }
  async parent(): Promise<void> {
    if (!this.root) throw new UserError("先にフォルダを開いてください。");
    await this.open(path.dirname(this.root));
  }
  async top(id: unknown): Promise<void> {
    const target = await this.resolve(id);
    if (!(await lstat(target)).isDirectory()) throw new UserError("フォルダを選んでください。");
    await this.open(target, this.root!);
  }
}
