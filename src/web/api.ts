export const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export interface ViewContext {
  root: string | null;
  selected: string | null;
  diffMode: boolean;
}
export type Mode = "preview" | "code" | "diff";
export type Stage = "unstaged" | "staged";
export interface TreeFilters {
  excludeGit: boolean;
  excludeIgnored: boolean;
  changedOnly: boolean;
}
export interface TabView {
  context: ViewContext;
  mode: Mode;
  stage: Stage;
  expanded: string[];
  filters?: TreeFilters;
}
interface Launch {
  target?: string;
  diffMode?: boolean;
}

const storageKey = "miru.tab.v1";
export const rememberedFolders = 32;
const canReadToken = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function readContext(value: unknown): ViewContext | undefined {
  if (
    record(value) &&
    (value.root === null || typeof value.root === "string") &&
    (value.selected === null || typeof value.selected === "string") &&
    typeof value.diffMode === "boolean"
  )
    return { root: value.root, selected: value.selected, diffMode: value.diffMode };
}
function readStorage(): { token?: string; launch?: Launch; view?: TabView } {
  try {
    const raw = sessionStorage.getItem(storageKey);
    const saved: unknown = raw && JSON.parse(raw);
    if (!record(saved) || !canReadToken(saved.token)) return {};
    const launch = record(saved.launch)
      ? {
          target: typeof saved.launch.target === "string" ? saved.launch.target : undefined,
          diffMode: saved.launch.diffMode === true ? true : undefined,
        }
      : undefined;
    if (!record(saved.view)) return { token: saved.token, launch };
    const context = readContext(saved.view.context);
    if (!context) return { token: saved.token, launch };
    const mode =
      saved.view.mode === "diff" || saved.view.mode === "code" ? saved.view.mode : "preview";
    const stage = saved.view.stage === "staged" ? "staged" : "unstaged";
    const expanded = Array.isArray(saved.view.expanded)
      ? saved.view.expanded
          .slice(0, rememberedFolders)
          .filter((id): id is string => typeof id === "string")
      : [];
    const preferences = saved.view.filters;
    const filters =
      record(preferences) &&
      typeof preferences.excludeIgnored === "boolean" &&
      typeof preferences.changedOnly === "boolean"
        ? {
            excludeGit: preferences.excludeGit !== false,
            excludeIgnored: preferences.excludeIgnored,
            changedOnly: preferences.changedOnly,
          }
        : undefined;
    return { token: saved.token, view: { context, mode, stage, expanded, filters } };
  } catch {
    // If the browser denies storage, the current page can still be used.
    return {};
  }
}

function takeGrant() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("grant")) return undefined;
  // Clear the one-use capability without adding another history entry. It
  // must not be stored in sessionStorage or in history.state.
  const clean = new URL(location.href);
  clean.hash = "";
  history.replaceState(null, "", clean.href);
  return params.get("grant");
}
let pendingGrant = takeGrant();
const cliLaunch = pendingGrant !== undefined;
const meta = document.querySelector<HTMLMetaElement>('meta[name="ev-session"]')?.content;
const foreground = canReadToken(meta) ? meta : undefined;
if (foreground || !canReadToken(pendingGrant)) pendingGrant = undefined;
const stored = cliLaunch ? {} : readStorage();
const sameTab = !foreground || foreground === stored.token;
let token = foreground ?? stored.token;
let launch: Launch = (sameTab ? stored.launch : undefined) ?? {};
let view = sameTab ? stored.view : undefined;
// Pasting a new CLI grant into an already-open Miru tab is a same-document
// navigation. Reload once so the new launch gets its own clean bootstrap.
window.addEventListener("hashchange", () => {
  const nextGrant = new URLSearchParams(location.hash.slice(1)).get("grant");
  if (nextGrant === null) return;
  if (!foreground && canReadToken(nextGrant)) location.reload();
  else takeGrant();
});
function persist() {
  try {
    if (token)
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(view ? { token, view } : { token, launch }),
      );
  } catch {
    // Persistence is optional; requests still work with the in-page state.
  }
}
export const tabView = () => view;
export function rememberView(current: TabView) {
  view = current;
  launch = {};
  persist();
}

const reconnect = "ターミナルから miru <path> をもう一度実行し、表示されたURLを開いてください。";
class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function request<T>(session: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EV-Session": session },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  } catch {
    throw new Error("MIRUに接続できません。サーバーが起動しているか確認してください。");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status === 403
        ? reconnect
        : record(result) && typeof result.error === "string"
          ? result.error
          : "読み込みに失敗しました。フォルダを更新してください。",
      response.status,
    );
  if (!record(result)) throw new Error("MIRUから有効な応答がありませんでした。");
  return result as T;
}
let connecting: Promise<string> | undefined;
function session() {
  if (token) return Promise.resolve(token);
  if (connecting) return connecting;
  if (!pendingGrant) return Promise.reject(new Error(reconnect));
  connecting = request<{ token: string; target?: string; diff: boolean }>(pendingGrant, {
    op: "connect",
  })
    .then((result) => {
      if (
        !canReadToken(result.token) ||
        (result.target !== undefined && typeof result.target !== "string") ||
        typeof result.diff !== "boolean"
      )
        throw new Error("MIRUの接続情報を取得できませんでした。");
      token = result.token;
      pendingGrant = undefined;
      launch = { target: result.target, diffMode: result.diff || undefined };
      persist();
      return token;
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) pendingGrant = undefined;
      throw error;
    })
    .finally(() => {
      connecting = undefined;
    });
  return connecting;
}
export async function api<T>(
  op: string,
  data: Record<string, unknown> = {},
  context: ViewContext | null = view?.context ?? null,
): Promise<T> {
  const sessionToken = await session();
  return request<T>(sessionToken, { op, ...data, ...(context ? { context } : {}) });
}
export async function initialState(): Promise<State> {
  const sessionToken = await session();
  const startup = view ? { context: view.context } : launch;
  return request<State>(sessionToken, { op: "state", ...startup });
}
export interface State {
  root: { id: string; name: string; displayPath: string; canParent: boolean } | null;
  selected: { id: string; name: string } | null;
  repository: string | null;
  gitMessage?: string | null;
  diffMode: boolean;
  changeCount: number;
}
export interface Entry {
  id: string;
  name: string;
  directory: boolean;
  deleted: boolean;
  symlink: boolean;
  changed: boolean;
}
export function notify(message: string) {
  element("status").textContent = message;
}
