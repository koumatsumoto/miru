import "./styles.css";
import { api, element, notify, type Entry, type State } from "./api";
import { createTree } from "./tree";
import { renderPreview, disposePreview, type Content } from "./preview";
import { renderCode } from "./syntax";
import { renderDiff } from "./diff";
import { currentTheme, toggleTheme } from "./theme";
type Mode = "preview" | "code" | "diff";
let selected: Pick<Entry, "id" | "name"> | null = null,
  mode: Mode = "preview",
  generation = 0,
  busy = true,
  preferDiff = false;
let currentState: State | null = null;
const content = element("content");
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
  disposePreview();
  updateFileControls();
  element("external").hidden = true;
  if (!selected) return;
  element("file-name").textContent = selected.name;
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
      }>("diff", { id: selected.id, stage: element<HTMLSelectElement>("stage").value });
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
      const file = await api<Content>("read", { id: selected.id });
      if (current !== generation) return;
      element("external").hidden = file.mime !== "text/html";
      if (mode === "code") {
        const source =
          file.binary || file.data ? "この画像・バイナリのソースは表示できません。" : file.text;
        view = await renderCode(
          source,
          file.binary || file.data ? "" : selected.name,
          currentTheme(),
        );
      } else view = await renderPreview(file, selected.id, currentTheme(), selected.name);
    }
    if (current === generation) content.replaceChildren(view);
  } catch (error) {
    if (current === generation)
      message(`${(error as Error).message} 削除済みファイルは差分を選んでください。`);
  }
}
const tree = createTree((entry) => {
  if (busy) return;
  selected = entry;
  mode = preferDiff ? "diff" : "preview";
  void show();
}, navigate);
async function launcher(state: State) {
  const wrapper = document.createElement("section");
  wrapper.className = "launcher";
  const heading = document.createElement("h1");
  heading.textContent = "見たいものから、はじめよう。";
  const description = document.createElement("p");
  description.textContent =
    "HOMEのフォルダやファイルを選択。検索からも開けます。すべて閲覧専用です。";
  const location = document.createElement("p");
  location.className = "launcher-location";
  location.textContent = state.root?.displayPath ?? "HOME";
  const grid = document.createElement("div");
  grid.className = "launcher-grid";
  wrapper.append(heading, description, location, grid);
  content.replaceChildren(wrapper);
  if (!state.root) return;
  const { entries } = await api<{ entries: Entry[] }>("list", { id: state.root.id });
  for (const entry of entries) {
    const button = document.createElement("button");
    button.className = "launcher-entry";
    const icon = document.createElement("span");
    icon.className = "launcher-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = entry.directory ? "▸" : entry.symlink ? "↗" : "▤";
    const label = document.createElement("span");
    label.textContent = entry.name;
    const kind = document.createElement("small");
    kind.textContent = entry.directory ? "フォルダを開く" : "ファイルを開く";
    button.append(icon, label, kind);
    button.onclick = () => {
      void navigate("openEntry", entry.id);
    };
    grid.append(button);
  }
  if (!entries.length) grid.textContent = "HOMEは空です。CLIからパスを指定して開けます。";
}
function updateViewControls() {
  if (!currentState) return;
  updateFileControls();
  document.body.classList.toggle("launcher-mode", currentState.launcher);
  element("external").hidden = true;
  element("diff-options").hidden = currentState.launcher || mode !== "diff" || !selected;
}
async function apply(state: State, keepMode = false) {
  generation++;
  disposePreview();
  if (!keepMode || selected?.id !== state.selected?.id) mode = state.diffMode ? "diff" : "preview";
  currentState = state;
  preferDiff = state.diffMode;
  selected = state.selected;
  updateViewControls();
  if (state.launcher) {
    element("file-name").textContent = "HOME / ランチャー";
    element("tree").replaceChildren();
    element("context-menu").hidden = true;
    await launcher(state);
    return;
  }
  await tree({ ...state, selected }, preferDiff);
  if (selected) await show();
  else {
    element("file-name").textContent = preferDiff ? "変更と差分" : "ファイル閲覧";
    message(
      preferDiff
        ? (state.gitMessage ??
            (state.repository
              ? "表示中のフォルダ内の変更だけを表示しています。ファイルを選ぶと差分を確認できます。"
              : "このフォルダはGit管理外です。通常の閲覧は miru <path> で開いてください。"))
        : "左のツリーからファイルを選んでください。フォルダを右クリックするとトップにできます。",
    );
  }
}
function setBusy(value: boolean) {
  busy = value;
  document.body.setAttribute("aria-busy", String(value));
  for (const id of ["home", "refresh", "theme", "external"])
    element<HTMLButtonElement>(id).disabled = value;
  element<HTMLInputElement>("query").disabled = value;
  document.querySelector("main")!.inert = value;
  element("results").inert = value;
  updateFileControls();
}
async function navigate(op: string, id?: string) {
  if (busy) return;
  setBusy(true);
  clearSearch();
  notify("");
  let focusTarget: string | null = null;
  try {
    const state = await api<State>(op, { id });
    await apply(state);
    focusTarget = state.launcher ? "query" : "folder-name";
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
  if (focusTarget) element(focusTarget).focus();
}
element("home").onclick = () => {
  void navigate("home");
};
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
element("refresh").onclick = async () => {
  if (busy) return;
  closeSettings(true);
  setBusy(true);
  clearSearch();
  try {
    const state = await api<State>("refresh");
    await apply(state, true);
    notify("ディスクから再取得しました。");
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]"))
  button.onclick = () => {
    mode = button.dataset.mode as Mode;
    void show();
  };
element("stage").onchange = () => {
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
    const state = await api<State>("state");
    await apply(state);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
  if (currentState?.launcher) element<HTMLInputElement>("query").focus();
}
void initialize();
