import { api, element, type Entry, type State } from "./api";
const svgNamespace = "http://www.w3.org/2000/svg";
const iconPaths = {
  chevron: "m6 4 4 4-4 4",
  folder: "M2 4h4l1.5 2H14v7H2Z",
  folderOpen: "M2 12.5V4h4l1.5 2H14v1.5 M2 13l2.2-5.5H15L13 13Z",
  file: "M4 2h5l3 3v9H4Z M9 2v3h3",
  document: "M4 2h5l3 3v9H4Z M9 2v3h3 M6 8h4 M6 11h4",
  code: "m5 5-3 3 3 3 M11 5l3 3-3 3 M9 4l-2 8",
  media: "M2.5 3.5h11v9h-11Z M2.5 11l3-3 2 2 2-2 4 4 M10.5 6h.1",
  link: "M9 5h4v4 M13 5l-5 5 M7 4H3v9h9V9",
} as const;
type Icon = keyof typeof iconPaths;

function treeIcon(kind: Icon, className: string) {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute("d", iconPaths[kind]);
  svg.append(path);
  return svg;
}

function fileIcon(entry: Entry): Icon {
  if (entry.directory) return "folder";
  if (entry.symlink) return "link";
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (
    /^(?:ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|sh|html|htm|css|json|ya?ml|toml|xml|sql)$/.test(
      ext ?? "",
    )
  )
    return "code";
  if (/^(?:md|markdown|txt|pdf|csv|tsv|rst)$/.test(ext ?? "")) return "document";
  if (/^(?:png|jpe?g|gif|svg|webp|avif|bmp|ico)$/.test(ext ?? "")) return "media";
  return "file";
}

export function createTree(
  select: (entry: Entry) => void,
  navigate: (op: string, id?: string) => Promise<void>,
) {
  const tree = element("tree");
  const context = element("context-menu");
  let menuTrigger: HTMLElement | null = null;
  const close = (restoreFocus = false) => {
    context.hidden = true;
    context.replaceChildren();
    if (restoreFocus && menuTrigger?.isConnected) menuTrigger.focus();
    menuTrigger = null;
  };
  document.addEventListener("click", () => close());
  document.addEventListener("keydown", (event) => {
    if (context.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(true);
  });
  context.onkeydown = (event) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      context.querySelector<HTMLButtonElement>("button")?.focus();
    }
  };
  function menu(event: MouseEvent | KeyboardEvent, entry: Entry, root = false) {
    event.preventDefault();
    close();
    if (!entry.directory) return;
    menuTrigger = event.currentTarget as HTMLElement;
    const rect = menuTrigger.getBoundingClientRect();
    const x = event instanceof MouseEvent && event.clientX ? event.clientX : rect.left;
    const y = event instanceof MouseEvent && event.clientY ? event.clientY : rect.bottom;
    const actions = root ? [["親を一段表示", "parent"]] : [["ここをトップにして表示", "top"]];
    for (const [label, op] of actions) {
      const button = document.createElement("button");
      button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.onclick = () => {
        close(true);
        void navigate(op, entry.id);
      };
      context.append(button);
    }
    context.style.left = `${Math.max(0, Math.min(x, window.innerWidth - 240))}px`;
    context.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 70))}px`;
    context.hidden = false;
    context.querySelector<HTMLButtonElement>("button")?.focus();
  }
  function keyboardMenu(event: KeyboardEvent, entry: Entry, root = false) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      menu(event, entry, root);
  }
  let repositoryView = false;
  let selectedId: string | undefined;
  async function children(id: string, container: HTMLElement, depth = 0) {
    const { entries } = await api<{ entries: Entry[] }>("list", { id });
    const visible = repositoryView ? entries.filter((entry) => entry.changed) : entries;
    for (const entry of visible) {
      const group = document.createElement("div");
      group.className = "tree-group";
      const button = document.createElement("button");
      button.className = `tree-entry${entry.changed ? " changed" : ""}${entry.deleted ? " deleted" : ""}`;
      button.classList.toggle("selected", entry.id === selectedId);
      if (!entry.directory && entry.id === selectedId) button.setAttribute("aria-current", "true");
      button.title = [
        entry.name,
        entry.deleted ? "削除済み" : "",
        entry.symlink ? "シンボリックリンク" : "",
        entry.changed ? "Gitの変更あり" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      button.setAttribute("aria-label", button.title);
      if (entry.directory) {
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-description", "Shift+F10でフォルダの操作メニューを開きます。");
      }
      const kind = fileIcon(entry);
      const marker = treeIcon("chevron", "tree-chevron");
      marker.classList.toggle("tree-chevron-spacer", !entry.directory);
      const icon = treeIcon(kind, `tree-icon tree-icon-${kind}`);
      const name = document.createElement("span");
      name.className = "tree-label";
      name.textContent = entry.name;
      button.style.setProperty("--tree-depth", String(depth));
      button.append(marker, icon, name);
      if (entry.changed) {
        const dot = document.createElement("span");
        dot.className = "change-dot";
        dot.setAttribute("aria-hidden", "true");
        button.append(dot);
      }
      group.append(button);
      container.append(group);
      let loaded = false,
        expanded = false,
        loading = false;
      const nested = document.createElement("div");
      nested.className = "tree-children";
      nested.id = `children-${entry.id}`;
      nested.style.setProperty("--tree-depth", String(depth));
      if (entry.directory) button.setAttribute("aria-controls", nested.id);
      nested.hidden = true;
      group.append(nested);
      button.onclick = async () => {
        if (loading) return;
        loading = true;
        try {
          if (entry.directory) {
            if (!loaded) {
              await children(entry.id, nested, depth + 1);
              loaded = true;
            }
            expanded = !expanded;
            nested.hidden = !expanded;
            icon
              .querySelector("path")
              ?.setAttribute("d", expanded ? iconPaths.folderOpen : iconPaths.folder);
            button.setAttribute("aria-expanded", String(expanded));
          } else {
            const previous = tree.querySelector(".selected");
            previous?.classList.remove("selected");
            previous?.removeAttribute("aria-current");
            button.classList.add("selected");
            button.setAttribute("aria-current", "true");
            select(entry);
          }
        } catch (error) {
          container.dispatchEvent(new CustomEvent("tree-error", { bubbles: true, detail: error }));
        } finally {
          loading = false;
        }
      };
      button.oncontextmenu = (event) => menu(event, entry);
      button.onkeydown = (event) => keyboardMenu(event, entry);
    }
    if (!visible.length) {
      const empty = document.createElement("small");
      empty.className = "muted tree-empty";
      empty.style.setProperty("--tree-depth", String(depth));
      empty.textContent = repositoryView ? "この範囲に変更はありません" : "空のフォルダ";
      container.append(empty);
    }
  }
  return async (state: State, changesOnly = false) => {
    repositoryView = changesOnly;
    selectedId = state.selected?.id;
    close();
    tree.replaceChildren();
    element("folder-name").textContent = state.root?.name ?? "ファイルをすぐに確認。";
    element("location").textContent = state.root?.displayPath ?? "HOMEを検索して始めてください。";
    element("repo").textContent = state.root
      ? (state.gitMessage ??
        (state.repository
          ? `Git · ${state.repository} · ${state.changeCount}件の変更（表示範囲内）`
          : "Git管理外"))
      : "";
    element<HTMLButtonElement>("parent").disabled = !state.root?.canParent;
    const rootEntry = state.root
      ? { ...state.root, directory: true, deleted: false, symlink: false, changed: false }
      : null;
    element("folder-name").oncontextmenu = rootEntry
      ? (event) => menu(event, rootEntry, true)
      : null;
    element("folder-name").onkeydown = rootEntry
      ? (event) => keyboardMenu(event, rootEntry, true)
      : null;
    if (state.root) await children(state.root.id, tree);
  };
}
