import "./styles.css";
import {
  api,
  element,
  initialState,
  notify,
  rememberedFolders,
  rememberView,
  tabView,
  type Entry,
  type Mode,
  type State,
  type TabView,
  type TreeFilters,
} from "./api";
import { createTree, type FileAction } from "./tree";
import { renderPreview, disposePreview, type Content } from "./preview";
import { renderCode } from "./syntax";
import { renderDiff } from "./diff";
import { currentTheme, toggleTheme } from "./theme";
let selected: Pick<Entry, "id" | "name"> | null = null,
  mode: Mode = "preview",
  generation = 0,
  busy = true,
  preferDiff = false;
let currentState: State | null = null;
let expanded = new Set<string>();
let filterPreferences = tabView()?.filters;
const content = element("content");
const stage = element<HTMLSelectElement>("stage");
stage.value = tabView()?.stage ?? "unstaged";
const refresh = element<HTMLButtonElement>("refresh");
const filterInputs = {
  excludeIgnored: element<HTMLInputElement>("exclude-ignored"),
  changedOnly: element<HTMLInputElement>("changed-only"),
} as const;
function effectiveFilters(state = currentState): TreeFilters {
  return {
    excludeIgnored: Boolean(state?.repository && filterPreferences?.excludeIgnored),
    changedOnly: Boolean(state?.repository && !state.gitMessage && filterPreferences?.changedOnly),
  };
}
function updateFilterControls() {
  const activeFilters = effectiveFilters();
  for (const key of ["excludeIgnored", "changedOnly"] as const) {
    const input = filterInputs[key];
    const reason = !currentState?.repository
      ? "Git管理のフォルダで使えます。"
      : key === "changedOnly"
        ? (currentState.gitMessage ?? "")
        : "";
    input.checked = activeFilters[key];
    input.disabled = busy || Boolean(reason);
    input.parentElement!.title = reason;
    if (reason) input.setAttribute("aria-description", reason);
    else input.removeAttribute("aria-description");
  }
}
function saveView(state: State): TabView {
  const view: TabView = {
    context: {
      root: state.root?.displayPath ?? null,
      selected: selected?.id ?? null,
      diffMode: state.diffMode,
    },
    mode,
    stage: stage.value === "staged" ? "staged" : "unstaged",
    expanded: [...expanded].slice(0, rememberedFolders),
    filters: filterPreferences,
  };
  rememberView(view);
  return view;
}
function rememberFolder(id: string, open: boolean) {
  if (!currentState) return;
  // Keep a bounded live expansion set. Only a smaller prefix is saved for page reloads
  // so a previously expanded big repository cannot stall startup.
  if (open) {
    if (expanded.has(id) || expanded.size >= 384) return;
    expanded.add(id);
  } else if (!expanded.delete(id)) return;
  saveView(currentState);
}
function message(text: string) {
  const p = document.createElement("p");
  p.className = "message";
  p.textContent = text;
  content.replaceChildren(p);
}
function updateFileControls() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.classList.toggle("active", button.dataset.mode === mode);
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    button.disabled = busy || !selected;
  }
  element("diff-options").hidden = mode !== "diff" || !selected;
}
async function show() {
  const current = ++generation;
  const entry = selected;
  const context = tabView()?.context ?? null;
  disposePreview();
  updateFileControls();
  element("external").hidden = true;
  if (!entry) return;
  element("file-name").textContent = entry.name;
  message("読み込み中…");
  try {
    let view: HTMLElement;
    if (mode === "diff") {
      const result = await api<{
        before: string;
        after: string;
        binary: boolean;
        message?: string;
        notice?: string;
      }>("diff", { id: entry.id, stage: stage.value }, context);
      if (current !== generation) return;
      if (result.message) {
        message(result.message);
        return;
      }
      view = renderDiff(result.before, result.after);
      if (result.notice) {
        const wrapper = document.createElement("div");
        wrapper.className = "diff-notice";
        const notice = document.createElement("p");
        notice.className = "message";
        notice.textContent = result.notice;
        wrapper.append(notice, view);
        view = wrapper;
      }
    } else {
      const file = await api<Content>("read", { id: entry.id }, context);
      if (current !== generation) return;
      element("external").hidden = file.mime !== "text/html";
      if (mode === "code") {
        const source =
          file.binary || file.data ? "この画像・バイナリのソースは表示できません。" : file.text;
        view = await renderCode(source, file.binary || file.data ? "" : entry.name, currentTheme());
      } else view = await renderPreview(file, entry.id, currentTheme(), entry.name, context);
    }
    if (current === generation) content.replaceChildren(view);
  } catch (error) {
    if (current === generation)
      message(`${(error as Error).message} 削除済みファイルは差分を選んでください。`);
  }
}
const tree = createTree(
  (entry) => {
    if (busy || !currentState) return;
    selected = entry;
    mode = preferDiff ? "diff" : "preview";
    saveView(currentState);
    void show();
  },
  navigate,
  openFileAction,
  rememberFolder,
  (state, warning) => {
    if (state !== currentState) return;
    state.gitMessage = warning;
    updateFilterControls();
    notify(warning);
  },
);
function showEmptyView(state: State) {
  element("file-name").textContent = preferDiff ? "変更と差分" : "ファイル閲覧";
  message(
    preferDiff && state.gitMessage
      ? state.gitMessage
      : preferDiff && !state.repository
        ? "このフォルダはGit管理外です。左のツリーから通常どおりファイルを閲覧できます。"
        : effectiveFilters(state).changedOnly
          ? "表示中のフォルダ内の変更だけを表示しています。ファイルを選ぶと内容や差分を確認できます。"
          : "左のツリーからファイルを選んでください。フォルダを右クリックするとトップにできます。",
  );
}
async function apply(state: State, keepMode = false) {
  generation++;
  disposePreview();
  const previous = tabView();
  const sameFolder =
    previous?.context.root === (state.root?.displayPath ?? null) &&
    previous.context.diffMode === state.diffMode;
  mode =
    keepMode && sameFolder && previous && state.selected?.id === previous.context.selected
      ? previous.mode
      : state.diffMode
        ? "diff"
        : "preview";
  expanded = sameFolder ? (currentState ? expanded : new Set(previous?.expanded)) : new Set();
  filterPreferences ??= { excludeIgnored: false, changedOnly: state.diffMode };
  currentState = state;
  preferDiff = state.diffMode;
  selected = state.selected;
  const view = saveView(state);
  updateFileControls();
  updateFilterControls();
  element("external").hidden = true;
  if (!selected) showEmptyView(state);
  // A Git/list error must not prevent an already selected file from being opened.
  await Promise.all([
    tree.render(state, view.context, expanded, effectiveFilters(state)),
    selected ? show() : undefined,
  ]);
  if (state.gitMessage && !preferDiff) notify(state.gitMessage);
  if (!selected) showEmptyView(state);
}
function setBusy(value: boolean) {
  busy = value;
  if (value) tree.cancelExpansion();
  document.body.setAttribute("aria-busy", String(value));
  for (const id of ["refresh", "theme", "external"])
    element<HTMLButtonElement>(id).disabled = value;
  element<HTMLInputElement>("query").disabled = value;
  document.querySelector("main")!.inert = value;
  element("results").inert = value;
  updateFileControls();
  updateFilterControls();
}
async function changeFilter(key: keyof TreeFilters) {
  const state = currentState;
  const context = tabView()?.context;
  const previous = filterPreferences;
  if (busy || !state || !context || !previous) return;
  const input = filterInputs[key];
  const restoreFocus = document.activeElement === input;
  filterPreferences = { ...previous, [key]: input.checked };
  saveView(state);
  setBusy(true);
  try {
    await tree.render(state, context, expanded, effectiveFilters(state));
    if (!selected) showEmptyView(state);
  } catch (error) {
    filterPreferences = previous;
    saveView(state);
    // The former choice and preview remain usable if Git cannot apply a filter.
    await tree.render(state, context, expanded, effectiveFilters(state)).catch(() => {});
    notify((error as Error).message);
  } finally {
    setBusy(false);
    if (restoreFocus && document.activeElement === document.body) input.focus();
  }
}
filterInputs.excludeIgnored.onchange = () => void changeFilter("excludeIgnored");
filterInputs.changedOnly.onchange = () => void changeFilter("changedOnly");
async function navigate(op: string, id?: string) {
  if (busy) return;
  setBusy(true);
  clearSearch();
  notify("");
  let applied = false;
  try {
    const state = await api<State>(op, { id });
    await apply(state);
    applied = true;
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
  if (applied) element("folder-name").focus();
}
let openingFileAction = false;
async function openFileAction(op: FileAction, id: string) {
  if (busy || openingFileAction || !currentState) return;
  const state = currentState;
  openingFileAction = true;
  try {
    await api(op, { id });
    if (state === currentState)
      notify(
        {
          edit: "テキストエディターで開きました。",
          reveal: "ファイルの場所を表示しました。",
          "open-folder": "ファイルマネージャーでフォルダを表示しました。",
        }[op],
      );
  } catch (error) {
    if (state === currentState) notify((error as Error).message);
  } finally {
    openingFileAction = false;
  }
}
const settings = element("settings");
const settingsToggle = element<HTMLButtonElement>("settings-toggle");
const settingsPanel = element("settings-panel");
element("version-value").textContent = __MIRU_VERSION__;

function closeSettings(restoreFocus = false) {
  if (settingsPanel.hidden) return;
  settingsPanel.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
  if (restoreFocus) settingsToggle.focus();
}
settingsToggle.onclick = () => {
  if (!settingsPanel.hidden) {
    closeSettings();
    return;
  }
  settingsPanel.hidden = false;
  settingsToggle.setAttribute("aria-expanded", "true");
  settingsPanel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
};
settings.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || settingsPanel.hidden) return;
  event.preventDefault();
  closeSettings(true);
});
settings.addEventListener("focusout", (event) => {
  if (event.relatedTarget instanceof Node && !settings.contains(event.relatedTarget))
    closeSettings();
});
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Node && !settings.contains(event.target)) closeSettings();
});
window.addEventListener("blur", () => closeSettings());
element("theme").onclick = () => {
  closeSettings(true);
  toggleTheme();
  if (selected) void show();
};
element("parent").onclick = () => {
  void navigate("parent");
};
refresh.onclick = async () => {
  if (busy) return;
  const restoreFocus = document.activeElement === refresh;
  setBusy(true);
  clearSearch();
  try {
    const state = currentState ? await api<State>("refresh") : await initialState();
    await apply(state, true);
    notify(state.gitMessage ?? "");
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
    if (restoreFocus && document.activeElement === document.body) refresh.focus();
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]"))
  button.onclick = () => {
    if (busy || !selected || !currentState) return;
    mode = button.dataset.mode as Mode;
    saveView(currentState);
    void show();
  };
stage.onchange = () => {
  if (busy || !selected || !currentState) return;
  saveView(currentState);
  void show();
};
element("external").onclick = async () => {
  if (!selected || busy) return;
  setBusy(true);
  try {
    await api("external", { id: selected.id });
    notify("外部ブラウザで開きました。ファイル内のスクリプトが実行される場合があります。");
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
};
const query = element<HTMLInputElement>("query");
const results = element("results");
const searchForm = element<HTMLFormElement>("search-form");
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let composing = false;
let searchActive = false;
let pendingSearch: { value: string; generation: number } | undefined;

function dismissResults() {
  clearTimeout(searchTimer);
  pendingSearch = undefined;
  results.hidden = true;
  results.replaceChildren();
  return ++searchGeneration;
}

function clearSearch() {
  dismissResults();
  query.value = "";
}

function queueSearch(delay = 220) {
  const current = dismissResults();
  const value = query.value.trim();
  if (value.length < 2 || composing || busy) return;
  searchTimer = setTimeout(() => {
    void showSearch(value, current);
  }, delay);
}

async function showSearch(value: string, current: number) {
  if (current !== searchGeneration || busy) return;
  if (searchActive) {
    pendingSearch = { value, generation: current };
    return;
  }
  searchActive = true;
  notify("HOMEを検索中…");
  try {
    const result = await api<{
      results: { id: string; displayPath: string; directory: boolean }[];
      truncated: boolean;
    }>("search", { query: value });
    if (current !== searchGeneration) return;
    for (const item of result.results) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result";
      button.textContent = `${item.directory ? "▸" : "·"} ${item.displayPath}`;
      button.onclick = () => {
        void navigate("openSearch", item.id);
      };
      results.append(button);
    }
    results.hidden = result.results.length === 0;
    notify(
      result.truncated
        ? "検索の上限に達しました。名前やパスを絞り込んでください。"
        : `${result.results.length}件（HOME）`,
    );
  } catch (error) {
    if (current === searchGeneration) notify((error as Error).message);
  } finally {
    searchActive = false;
    const next = pendingSearch;
    pendingSearch = undefined;
    if (next) void showSearch(next.value, next.generation);
  }
}

query.addEventListener("compositionstart", () => {
  composing = true;
  dismissResults();
});
query.addEventListener("compositionend", () => {
  composing = false;
  queueSearch();
});
query.addEventListener("input", (event) => {
  if (composing || (event as InputEvent).isComposing) return;
  if (query.value.trim().length < 2) notify("");
  queueSearch();
});
searchForm.onsubmit = (event) => {
  event.preventDefault();
  if (!composing && results.hidden) queueSearch(0);
};
query.addEventListener("focus", () => {
  if (results.hidden && query.value.trim().length >= 2 && !composing) queueSearch();
});
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Node && !searchForm.contains(event.target)) dismissResults();
});
searchForm.addEventListener("focusout", (event) => {
  if (event.relatedTarget instanceof Node && !searchForm.contains(event.relatedTarget))
    dismissResults();
});
window.addEventListener("blur", () => {
  if (searchForm.contains(document.activeElement)) dismissResults();
});
searchForm.addEventListener("keydown", (event) => {
  if (composing || event.isComposing) return;
  if (event.key === "Escape" && query.value) {
    event.preventDefault();
    clearSearch();
    notify("");
    query.focus();
  } else if (event.key === "ArrowDown" && event.target === query && !results.hidden) {
    event.preventDefault();
    results.querySelector("button")?.focus();
  }
});
element("tree").addEventListener("tree-error", (event) =>
  notify(((event as CustomEvent).detail as Error).message),
);
async function initialize() {
  setBusy(true);
  try {
    const state = await initialState();
    await apply(state, true);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
}
void initialize();
