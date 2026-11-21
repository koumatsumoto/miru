import { api, element, type Entry, type State, type ViewContext } from "./api";
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
export type FileAction = "reveal" | "edit";

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
  fileAction: (op: FileAction, id: string) => Promise<void>,
  expansionChanged: (id: string, expanded: boolean) => void,
) {
  const tree = element("tree");
  const context = element("context-menu");
  let menuTrigger: HTMLElement | null = null;
  const close = (restoreFocus = false) => {
    if (context.hidden) return;
    const trigger = menuTrigger;
    menuTrigger = null;
    context.hidden = true;
    context.replaceChildren();
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  };
  document.addEventListener("click", () => close());
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !context.contains(event.target)) close();
  });
  window.addEventListener("blur", () => close());
  document.addEventListener("keydown", (event) => {
    if (context.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(true);
  });
  context.onkeydown = (event) => {
    const items = Array.from(context.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (!items.length) return;
    const focused = items.findIndex((item) => item === document.activeElement);
    let index: number;
    switch (event.key) {
      case "ArrowDown":
        index = (focused + 1) % items.length;
        break;
      case "ArrowUp":
        index = focused <= 0 ? items.length - 1 : focused - 1;
        break;
      case "Home":
        index = 0;
        break;
      case "End":
        index = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[index]?.focus();
  };
  function menu(event: MouseEvent | KeyboardEvent, entry: Entry, root = false) {
    event.preventDefault();
    close();
    menuTrigger = event.currentTarget as HTMLElement;
    const rect = menuTrigger.getBoundingClientRect();
    const x = event instanceof MouseEvent ? event.clientX : rect.left;
    const y = event instanceof MouseEvent ? event.clientY : rect.bottom;
    function addItem(label: string, action: () => Promise<void>) {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.onclick = () => {
        close(true);
        void action();
      };
      context.append(button);
    }
    if (entry.directory) {
      addItem(root ? "親を一段表示" : "ここをトップにして表示", () =>
        navigate(root ? "parent" : "top", entry.id),
      );
    } else {
      addItem("エクスプローラーで開く", () => fileAction("reveal", entry.id));
      addItem("編集する", () => fileAction("edit", entry.id));
    }
    context.setAttribute("aria-label", entry.directory ? "フォルダの操作" : "ファイルの操作");
    context.hidden = false;
    context.style.left = `${Math.max(0, Math.min(x, window.innerWidth - context.offsetWidth - 4))}px`;
    context.style.top = `${Math.max(0, Math.min(y, window.innerHeight - context.offsetHeight - 4))}px`;
    context.querySelector<HTMLButtonElement>("button")?.focus();
  }
  function keyboardMenu(event: KeyboardEvent, entry: Entry, root = false) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      menu(event, entry, root);
  }
  function bindFileMenu(button: HTMLButtonElement, entry: Entry) {
    if (entry.directory || entry.deleted) return;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-description", "Shift+F10でファイルの操作メニューを開きます。");
    button.oncontextmenu = (event) => menu(event, entry);
    button.onkeydown = (event) => keyboardMenu(event, entry);
  }
  let generation = 0;
  function clear() {
    generation++;
    close();
    tree.replaceChildren();
  }
  async function render(state: State, view: ViewContext, expandedFolders: ReadonlySet<string>) {
    clear();
    const current = generation;
    const active = () => generation === current;
    let selectedId = state.selected?.id;
    async function children(id: string, container: HTMLElement, depth = 0) {
      const { entries } = await api<{ entries: Entry[] }>("list", { id }, view);
      if (!active()) return;
      const visible = state.diffMode ? entries.filter((entry) => entry.changed) : entries;
      const restore: (() => Promise<void>)[] = [];
      for (const entry of visible) {
        const group = document.createElement("div");
        group.className = "tree-group";
        const button = document.createElement("button");
        button.className = `tree-entry${entry.changed ? " changed" : ""}${entry.deleted ? " deleted" : ""}`;
        button.classList.toggle("selected", entry.id === selectedId);
        if (!entry.directory && entry.id === selectedId)
          button.setAttribute("aria-current", "true");
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
          button.oncontextmenu = (event) => menu(event, entry);
          button.onkeydown = (event) => keyboardMenu(event, entry);
        } else bindFileMenu(button, entry);
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
        async function setExpanded(open: boolean) {
          if (open && !loaded) {
            await children(entry.id, nested, depth + 1);
            loaded = true;
          }
          if (!active()) return;
          expanded = open;
          nested.hidden = !open;
          icon
            .querySelector("path")
            ?.setAttribute("d", open ? iconPaths.folderOpen : iconPaths.folder);
          button.setAttribute("aria-expanded", String(open));
        }
        button.onclick = async () => {
          if (loading || !active()) return;
          loading = true;
          try {
            if (entry.directory) {
              await setExpanded(!expanded);
              if (active()) expansionChanged(entry.id, expanded);
            } else {
              const previous = tree.querySelector(".selected");
              previous?.classList.remove("selected");
              previous?.removeAttribute("aria-current");
              selectedId = entry.id;
              button.classList.add("selected");
              button.setAttribute("aria-current", "true");
              select(entry);
            }
          } catch (error) {
            container.dispatchEvent(
              new CustomEvent("tree-error", { bubbles: true, detail: error }),
            );
          } finally {
            loading = false;
          }
        };
        if (entry.directory && expandedFolders.has(entry.id))
          restore.push(() => setExpanded(true).catch(() => {}));
      }
      if (!visible.length) {
        const empty = document.createElement("small");
        empty.className = "muted tree-empty";
        empty.style.setProperty("--tree-depth", String(depth));
        empty.textContent = state.diffMode ? "この範囲に変更はありません" : "空のフォルダ";
        container.append(empty);
      }
      // Limit browser-reload work to remembered paths visibly reachable from this root.
      // Restore serially so expanding many siblings does not flood the daemon.
      for (const expand of restore) {
        if (!active()) return;
        await expand();
      }
    }
    element("folder-name").textContent = state.root?.name ?? "ファイルをすぐに確認。";
    element("location").textContent = state.root?.displayPath ?? "HOMEを検索して始めてください。";
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
  }
  return render;
}
