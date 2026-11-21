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
import { currentTheme, setTheme } from "./theme";
import type { Theme } from "./colors";
import { bindExplorerResize } from "./explorer-resize";
bindExplorerResize(element("explorer-resize"));
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
const filterToggle = element<HTMLButtonElement>("tree-filter-toggle");
const filterPanel = element("tree-filters");
const treeQuery = element<HTMLInputElement>("tree-query");
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let treeQueryGeneration = 0;
let runningTreeQuery = false;
let pendingTreeQuery: number | undefined;
function setFilterPanel(open: boolean, restoreFocus = false) {
  filterPanel.hidden = !open;
  filterToggle.setAttribute("aria-expanded", String(open));
  if (open) treeQuery.focus();
  else if (restoreFocus) filterToggle.focus();
}
filterToggle.onclick = () => setFilterPanel(filterPanel.hasAttribute("hidden"), true);
document.addEventListener("pointerdown", (event) => {
  if (
    event.target instanceof Node &&
    !filterPanel.contains(event.target) &&
    !filterToggle.contains(event.target)
  )
    setFilterPanel(false);
});
filterPanel.addEventListener("focusout", (event) => {
  if (
    event.relatedTarget instanceof Node &&
    !filterPanel.contains(event.relatedTarget) &&
    !filterToggle.contains(event.relatedTarget)
  )
    setFilterPanel(false);
});
for (const control of [filterPanel, filterToggle])
  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !filterPanel.hidden && !event.isComposing) {
      event.preventDefault();
      setFilterPanel(false, true);
    }
  });
function updateFilterIndicator() {
  const filters = effectiveFilters();
  const active = filters.excludeIgnored || filters.changedOnly || Boolean(treeQuery.value.trim());
  filterToggle.toggleAttribute("data-active", active);
  if (active) filterToggle.setAttribute("aria-description", "絞り込み中");
  else filterToggle.removeAttribute("aria-description");
}

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
  updateFilterIndicator();
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
  element("file-bar").hidden = !selected;
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
    setSettings(false);
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
async function apply(state: State, keepMode = false) {
  generation++;
  disposePreview();
  const previous = tabView();
  clearTimeout(filterTimer);
  treeQueryGeneration++;
  const sameFolder =
    previous?.context.root === (state.root?.displayPath ?? null) &&
    previous.context.diffMode === state.diffMode;
  mode =
    keepMode && sameFolder && previous && state.selected?.id === previous.context.selected
      ? previous.mode
      : state.diffMode
        ? "diff"
        : "preview";
  if (!sameFolder) treeQuery.value = "";
  expanded = sameFolder ? (currentState ? expanded : new Set(previous?.expanded)) : new Set();
  filterPreferences ??= { excludeIgnored: false, changedOnly: state.diffMode };
  currentState = state;
  preferDiff = state.diffMode;
  selected = state.selected;
  const view = saveView(state);
  updateFileControls();
  updateFilterControls();
  element("external").hidden = true;
  if (!selected) {
    element("file-name").textContent = "";
    content.replaceChildren();
  }
  // A Git/list error must not prevent an already selected file from being opened.
  await Promise.all([
    tree.render(state, view.context, expanded, effectiveFilters(state), treeQuery.value),
    selected ? show() : undefined,
  ]);
  if (state.gitMessage) notify(state.gitMessage);
}
function setBusy(value: boolean) {
  busy = value;
  if (value) tree.cancelExpansion();
  document.body.setAttribute("aria-busy", String(value));
  for (const id of ["refresh", "external"]) element<HTMLButtonElement>(id).disabled = value;
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
  clearTimeout(filterTimer);
  treeQueryGeneration++;
  const input = filterInputs[key];
  const restoreFocus = document.activeElement === input;
  filterPreferences = { ...previous, [key]: input.checked };
  saveView(state);
  setBusy(true);
  try {
    await tree.render(state, context, expanded, effectiveFilters(state), treeQuery.value);
  } catch (error) {
    filterPreferences = previous;
    saveView(state);
    // The former choice and preview remain usable if Git cannot apply a filter.
    await tree
      .render(state, context, expanded, effectiveFilters(state), treeQuery.value)
      .catch(() => {});
    notify((error as Error).message);
  } finally {
    setBusy(false);
    if (restoreFocus && document.activeElement === document.body) input.focus();
  }
}
filterInputs.excludeIgnored.onchange = () => void changeFilter("excludeIgnored");
filterInputs.changedOnly.onchange = () => void changeFilter("changedOnly");
async function runTreeQuery(current: number) {
  const state = currentState;
  const context = tabView()?.context;
  if (!state || !context || busy || current !== treeQueryGeneration) return;
  if (runningTreeQuery) {
    pendingTreeQuery = current;
    return;
  }
  runningTreeQuery = true;
  try {
    await tree.render(state, context, expanded, effectiveFilters(state), treeQuery.value);
  } catch (error) {
    if (current === treeQueryGeneration) notify((error as Error).message);
  } finally {
    runningTreeQuery = false;
    const pending = pendingTreeQuery;
    pendingTreeQuery = undefined;
    if (pending !== undefined) void runTreeQuery(pending);
  }
}
function refreshTreeQuery() {
  updateFilterIndicator();
  const current = ++treeQueryGeneration;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => void runTreeQuery(current), 130);
}
treeQuery.oninput = (event) => {
  if (!(event as InputEvent).isComposing) refreshTreeQuery();
};
treeQuery.addEventListener("compositionend", refreshTreeQuery);

async function navigate(op: string, id?: string) {
  if (busy) return;
  setSettings(false);
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
const settingsToggle = element<HTMLButtonElement>("settings-toggle");
const settingsPanel = element("settings-panel");
const themeFields = element<HTMLFieldSetElement>("theme");
const themeMessage = element("theme-message");
element("version-value").textContent = __MIRU_VERSION__;

function setSettings(open: boolean, focus = false) {
  settingsPanel.hidden = !open;
  element("file-pane").hidden = open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  if (focus) (open ? element("settings-title") : settingsToggle).focus();
}
settingsToggle.onclick = () => setSettings(settingsPanel.hasAttribute("hidden"), true);
element("settings-close").onclick = () => setSettings(false, true);
for (const control of [settingsToggle, settingsPanel])
  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsPanel.hidden) {
      event.preventDefault();
      setSettings(false, true);
    }
  });

function showSelectedTheme() {
  for (const input of themeFields.querySelectorAll<HTMLInputElement>("input"))
    input.checked = input.value === currentTheme();
}
async function loadTheme() {
  themeFields.disabled = true;
  try {
    const prefs = await api<{ theme?: Theme }>("preferences", {}, null);
    if (prefs.theme === "light" || prefs.theme === "dark") setTheme(prefs.theme);
    themeMessage.textContent = "";
  } catch (error) {
    themeMessage.textContent = (error as Error).message;
  } finally {
    showSelectedTheme();
    themeFields.disabled = false;
  }
}
themeFields.addEventListener("change", async (event) => {
  const control = event.target;
  if (!(control instanceof HTMLInputElement) || !control.checked || themeFields.disabled) return;
  themeFields.disabled = true;
  try {
    const prefs = await api<{ theme: Theme }>("set-theme", { theme: control.value }, null);
    setTheme(prefs.theme);
    themeMessage.textContent = "";
    if (selected) void show();
  } catch (error) {
    themeMessage.textContent = (error as Error).message;
  } finally {
    showSelectedTheme();
    themeFields.disabled = false;
    if (!settingsPanel.hidden && document.activeElement === document.body) control.focus();
  }
});
showSelectedTheme();
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
    if (!currentState) await loadTheme();
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
    await loadTheme();
    await apply(state, true);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
}
void initialize();
