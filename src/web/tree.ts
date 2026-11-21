import { api, element, type Entry, type State, type TreeFilters, type ViewContext } from "./api";
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
export type FileAction = "reveal" | "edit" | "open-folder";
const expansionLimits = { folders: 150, depth: 12, rows: 4000, ms: 5000 } as const;
class ExpansionLimit extends Error {}
interface Folder {
  id: string;
  recursive: boolean;
  open(wanted: () => boolean, budget?: { rows: number }): Promise<Folder[]>;
}

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
  sync: () => Promise<void>,
  expansionChanged: (id: string, expanded: boolean) => void,
  gitWarning: (state: State, message: string) => void,
) {
  const tree = element("tree");
  const heading = element("folder-name");
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
  context.onpointermove = () => delete context.dataset.keyboard;
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
    context.dataset.keyboard = "";
    items[index]?.focus();
  };
  function menu(
    event: MouseEvent | KeyboardEvent,
    entry: Entry | null,
    root = false,
    expand?: () => Promise<void>,
  ) {
    event.preventDefault();
    close();
    menuTrigger = event.currentTarget as HTMLElement;
    const rect = menuTrigger.getBoundingClientRect();
    const x = event instanceof MouseEvent ? event.clientX : rect.left;
    const y = event instanceof MouseEvent ? event.clientY : rect.bottom;
    function addItem(label: string, action: () => Promise<void>) {
      const button = document.createElement("button");
      button.className = "navigation-item";
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
    if (entry?.directory) {
      addItem(root ? "親を一段表示" : "ここをトップにして表示", () =>
        navigate(root ? "parent" : "top", entry.id),
      );
      if (!entry.deleted)
        addItem("エクスプローラーで開く", () => fileAction("open-folder", entry.id));
      if (expand) addItem("サブフォルダをすべて展開", expand);
    } else if (entry) {
      addItem("エクスプローラーで開く", () => fileAction("reveal", entry.id));
      addItem("編集する", () => fileAction("edit", entry.id));
    }
    addItem("最新に同期", sync);
    context.setAttribute(
      "aria-label",
      !entry || entry.directory ? "フォルダの操作" : "ファイルの操作",
    );
    context.toggleAttribute("data-keyboard", !(event instanceof MouseEvent));
    context.hidden = false;
    context.style.left = `${Math.max(0, Math.min(x, window.innerWidth - context.offsetWidth - 4))}px`;
    context.style.top = `${Math.max(0, Math.min(y, window.innerHeight - context.offsetHeight - 4))}px`;
    context.querySelector<HTMLButtonElement>("button")?.focus();
  }
  function keyboardMenu(
    event: KeyboardEvent,
    entry: Entry | null,
    root = false,
    expand?: () => Promise<void>,
  ) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      menu(event, entry, root, expand);
  }
  function bindHeading(entry: Entry | null, expand?: () => Promise<void>) {
    heading.oncontextmenu = (event) => menu(event, entry, true, expand);
    heading.onkeydown = (event) => keyboardMenu(event, entry, true, expand);
  }
  bindHeading(null);
  function bindFileMenu(button: HTMLButtonElement, entry: Entry) {
    if (entry.directory || entry.deleted) return;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-description", "Shift+F10でファイルの操作メニューを開きます。");
    button.oncontextmenu = (event) => menu(event, entry);
    button.onkeydown = (event) => keyboardMenu(event, entry);
  }
  let generation = 0;
  let expansion = 0;
  function cancelExpansion() {
    expansion++;
  }
  function report(error: unknown) {
    tree.dispatchEvent(new CustomEvent("tree-error", { detail: error }));
  }
  async function render(
    state: State,
    view: ViewContext,
    expandedFolders: ReadonlySet<string>,
    filters: TreeFilters,
    query = "",
    currentQuery = () => true,
  ) {
    const current = ++generation;
    cancelExpansion();
    close();
    tree.replaceChildren();
    const active = () => generation === current && currentQuery();
    let selectedId = view.selected;
    let changedOnly = filters.changedOnly;
    let rootDrawn = false;
    async function list(id: string) {
      const result = await api<{ entries: Entry[]; gitMessage?: string }>(
        "list",
        filters.excludeIgnored ? { id, excludeIgnored: true } : { id },
        view,
      );
      if (!active()) return [];
      if (result.gitMessage) {
        const wasFiltered = changedOnly;
        changedOnly = false;
        gitWarning(state, result.gitMessage);
        // Git can become unavailable while expanding under a previously filtered
        // root. Rebuild the whole tree without that filter rather than mixing scopes.
        if (wasFiltered && rootDrawn) {
          const fallbackGeneration = generation + 1;
          try {
            await render(state, { ...view, selected: selectedId }, expandedFolders, {
              ...filters,
              changedOnly: false,
            });
          } catch (error) {
            if (generation === fallbackGeneration) report(error);
          }
          return [];
        }
      }
      return result.entries.filter(
        (entry) =>
          (!filters.excludeGit || entry.name !== ".git") && (!changedOnly || entry.changed),
      );
    }
    async function walk(folders: Folder[], wanted: () => boolean, all = false) {
      if (!active() || !wanted()) return;
      const queue: { folder: Folder; depth: number }[] = [];
      const deadline = performance.now() + expansionLimits.ms;
      const budget = { rows: expansionLimits.rows };
      let limited = false;
      let failed = "";
      let opened = 0;
      const enqueue = (items: Folder[], depth: number) => {
        for (const folder of items) {
          if (!folder.recursive || (!all && !expandedFolders.has(folder.id))) continue;
          if (depth > expansionLimits.depth || queue.length >= expansionLimits.folders) {
            limited = true;
            return;
          }
          queue.push({ folder, depth });
        }
      };
      enqueue(folders, 1);
      for (let index = 0; index < queue.length; index++) {
        if (!active() || !wanted()) return;
        if (performance.now() >= deadline) {
          limited = true;
          break;
        }
        const { folder, depth } = queue[index];
        try {
          const descendants = await folder.open(
            () => wanted() && performance.now() < deadline,
            budget,
          );
          if (!active() || !wanted()) return;
          if (performance.now() >= deadline) {
            limited = true;
            break;
          }
          opened++;
          if (all) expansionChanged(folder.id, true);
          enqueue(descendants, depth + 1);
        } catch (error) {
          if (error instanceof ExpansionLimit) limited = true;
          else failed ||= (error as Error).message;
        }
      }
      if (all && active() && wanted() && (limited || failed)) {
        const summary = opened
          ? "サブフォルダを一部だけ展開しました。"
          : "サブフォルダを展開できませんでした。";
        report(new Error(summary + (failed || "表示の上限に達しました。残りは個別に開けます。")));
      }
    }
    function expandAll(folders: Folder[]) {
      const run = ++expansion;
      return walk(folders, () => run === expansion, true);
    }
    function draw(
      entries: (Entry & { displayPath?: string })[],
      container: HTMLElement,
      depth: number,
    ): Folder[] {
      const folders: Folder[] = [];
      for (const entry of entries) {
        const group = document.createElement("div");
        group.className = "tree-group";
        const button = document.createElement("button");
        button.className = `tree-entry${entry.changed ? " changed" : ""}${entry.deleted ? " deleted" : ""}`;
        button.classList.toggle("selected", entry.id === selectedId);
        if (!entry.directory && entry.id === selectedId)
          button.setAttribute("aria-current", "true");
        button.title = [
          entry.displayPath ?? entry.name,
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
        } else bindFileMenu(button, entry);
        const kind = fileIcon(entry);
        const marker = treeIcon("chevron", "tree-chevron");
        marker.classList.toggle("tree-chevron-spacer", !entry.directory);
        const icon = treeIcon(kind, `tree-icon tree-icon-${kind}`);
        const name = document.createElement("span");
        name.className = "tree-label";
        name.textContent = entry.displayPath ?? entry.name;
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
        let expanded = false;
        let loading = false;
        let listed: Folder[] | undefined;
        let pending: Promise<Entry[]> | undefined;
        const nested = document.createElement("div");
        nested.className = "tree-children";
        nested.id = `children-${entry.id}`;
        nested.style.setProperty("--tree-depth", String(depth));
        if (entry.directory) button.setAttribute("aria-controls", nested.id);
        nested.hidden = true;
        group.append(nested);
        function setExpanded(open: boolean) {
          expanded = open;
          nested.hidden = !open;
          icon
            .querySelector("path")
            ?.setAttribute("d", open ? iconPaths.folderOpen : iconPaths.folder);
          button.setAttribute("aria-expanded", String(open));
        }
        const folder: Folder | undefined = entry.directory
          ? {
              id: entry.id,
              recursive: !entry.symlink && !entry.deleted,
              async open(wanted, budget) {
                if (!active() || !wanted()) return [];
                if (!listed) {
                  pending ??= list(entry.id).finally(() => {
                    pending = undefined;
                  });
                  const next = await pending;
                  if (!active() || !wanted()) return [];
                  if (!listed) {
                    if (budget) {
                      if (next.length > budget.rows) throw new ExpansionLimit();
                      budget.rows -= next.length;
                    }
                    listed = draw(next, nested, depth + 1);
                  }
                }
                setExpanded(true);
                return listed;
              },
            }
          : undefined;
        if (folder) {
          folders.push(folder);
          const recursive = folder.recursive ? () => expandAll([folder]) : undefined;
          button.oncontextmenu = (event) => menu(event, entry, false, recursive);
          button.onkeydown = (event) => keyboardMenu(event, entry, false, recursive);
        }
        button.onclick = async () => {
          if (loading || !active()) return;
          loading = true;
          try {
            if (folder) {
              cancelExpansion();
              if (expanded) {
                setExpanded(false);
                expansionChanged(entry.id, false);
              } else {
                const descendants = await folder.open(active);
                if (!active()) return;
                expansionChanged(entry.id, true);
                await walk(descendants, () => expanded);
              }
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
            if (active()) report(error);
          } finally {
            loading = false;
          }
        };
      }
      if (!entries.length && !changedOnly) {
        const empty = document.createElement("small");
        empty.className = "muted tree-empty";
        empty.style.setProperty("--tree-depth", String(depth));
        empty.textContent = filters.excludeIgnored ? "表示する項目はありません" : "空のフォルダ";
        container.append(empty);
      }
      return folders;
    }
    element("folder-name").textContent = state.root?.name ?? "ファイルをすぐに確認。";
    element("location").textContent = state.root?.displayPath ?? "HOMEを検索して始めてください。";
    element<HTMLButtonElement>("parent").disabled = !state.root?.canParent;
    const rootEntry = state.root
      ? { ...state.root, directory: true, deleted: false, symlink: false, changed: false }
      : null;
    bindHeading(rootEntry);
    if (rootEntry) {
      if (query.trim()) {
        const result = await api<{
          entries: (Entry & { displayPath: string })[];
          truncated: boolean;
          gitMessage?: string;
        }>("tree-search", { query, ...filters }, view);
        if (!active()) return;
        if (result.gitMessage) gitWarning(state, result.gitMessage);
        draw(result.entries, tree, 0);
        if (result.truncated)
          report(new Error("表示の上限に達しました。ファイル名を絞り込んでください。"));
        return;
      }
      const entries = await list(rootEntry.id);
      if (!active()) return;
      const folders = draw(entries, tree, 0);
      rootDrawn = true;
      bindHeading(rootEntry, () => expandAll(folders));
      await walk(folders, active);
    }
  }
  return { render, cancelExpansion };
}
