import "./styles.css";
import { api, element, notify, type Entry, type State } from "./api";
import { createTree } from "./tree";
import { renderPreview, disposePreview, type Content } from "./preview";
import { renderDiff } from "./diff";
import { currentTheme, toggleTheme } from "./theme";
type Mode = "preview" | "code" | "diff";
let selected: Pick<Entry, "id" | "name"> | null = null,
  mode: Mode = "preview",
  generation = 0,
  busy = true,
  preferDiff = false;
let currentState: State | null = null;
let viewMode: "file" | "repository" = "file";
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
        view = document.createElement("pre");
        view.className = "code";
        view.textContent =
          file.binary || file.data ? "この画像・バイナリのソースは表示できません。" : file.text;
      } else view = await renderPreview(file, selected.id, currentTheme());
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
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    const active = button.dataset.view === viewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = busy || currentState.launcher;
  }
  document.body.classList.toggle("launcher-mode", currentState.launcher);
  element("external").hidden = true;
  element("diff-options").hidden = currentState.launcher || mode !== "diff" || !selected;
}
async function apply(state: State, keepSelection = false) {
  generation++;
  disposePreview();
  currentState = state;
  if (!keepSelection) selected = state.selected;
  updateViewControls();
  if (state.launcher) {
    element("file-name").textContent = "HOME / ランチャー";
    element("tree").replaceChildren();
    element("context-menu").hidden = true;
    await launcher(state);
    return;
  }
  await tree({ ...state, selected }, viewMode === "repository");
  if (selected) await show();
  else {
    element("file-name").textContent =
      viewMode === "repository" ? "Repository / 変更と差分" : "File / ファイル閲覧";
    message(
      viewMode === "repository"
        ? (state.gitMessage ??
            (state.repository
              ? "表示中のフォルダ内の変更だけを表示しています。ファイルを選ぶと差分を確認できます。"
              : "このフォルダはGit管理外です。Fileモードで通常のファイルを閲覧できます。"))
        : "左のツリーからファイルを選んでください。フォルダを右クリックするとトップにできます。",
    );
  }
}
function setBusy(value: boolean) {
  busy = value;
  document.body.setAttribute("aria-busy", String(value));
  for (const id of ["home", "refresh", "theme", "external"])
    element<HTMLButtonElement>(id).disabled = value;
  for (const control of element("search-form").querySelectorAll<
    HTMLInputElement | HTMLButtonElement
  >("input,button"))
    control.disabled = value;
  document.querySelector("main")!.inert = value;
  element("results").inert = value;
  updateFileControls();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
    button.disabled = value || !currentState || currentState.launcher;
}
async function navigate(op: string, id?: string) {
  if (busy) return;
  setBusy(true);
  notify("");
  let focusTarget: string | null = null;
  try {
    const state = await api<State>(op, { id });
    element("results").replaceChildren();
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
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
  button.onclick = async () => {
    if (busy || !currentState || currentState.launcher) return;
    setBusy(true);
    try {
      viewMode = button.dataset.view as typeof viewMode;
      preferDiff = viewMode === "repository";
      mode = preferDiff ? "diff" : "preview";
      await apply(currentState, true);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
element("theme").onclick = () => {
  toggleTheme();
  if (selected) void show();
};
element("parent").onclick = () => {
  void navigate("parent");
};
element("refresh").onclick = async () => {
  if (busy) return;
  setBusy(true);
  try {
    const state = await api<State>("refresh");
    element("results").replaceChildren();
    await apply(state);
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
element("search-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  const results = element("results");
  results.replaceChildren();
  notify("HOMEを検索中…");
  try {
    const result = await api<{
      results: { id: string; name: string; displayPath: string; directory: boolean }[];
      truncated: boolean;
    }>("search", { query: element<HTMLInputElement>("query").value });
    for (const item of result.results) {
      const button = document.createElement("button");
      button.className = "result";
      button.textContent = `${item.directory ? "▸" : "·"} ${item.displayPath}`;
      button.onclick = () => {
        results.replaceChildren();
        void navigate("openSearch", item.id);
      };
      results.append(button);
    }
    notify(
      result.truncated
        ? "検索の上限に達しました。名前やパスを絞り込んでください。"
        : `${result.results.length}件（HOME）。検索は2文字以上で入力してください。`,
    );
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
};
element("tree").addEventListener("tree-error", (event) =>
  notify(((event as CustomEvent).detail as Error).message),
);
async function initialize() {
  setBusy(true);
  try {
    const state = await api<State>("state");
    preferDiff = state.diffMode;
    viewMode = preferDiff ? "repository" : "file";
    mode = preferDiff ? "diff" : "preview";
    await apply(state);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setBusy(false);
  }
  if (currentState?.launcher) element<HTMLInputElement>("query").focus();
}
void initialize();
