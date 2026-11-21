interface HomeSearchOptions {
  form: HTMLFormElement;
  query: HTMLInputElement;
  results: HTMLElement;
  isBusy: () => boolean;
  search: (value: string) => Promise<{
    results: { id: string; displayPath: string; directory: boolean }[];
    truncated: boolean;
  }>;
  open: (id: string) => Promise<void>;
  notify: (message: string) => void;
}

export function bindHomeSearch({
  form,
  query,
  results,
  isBusy,
  search,
  open,
  notify,
}: HomeSearchOptions) {
  const document = form.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let composing = false;
  let active = false;
  let pending: { value: string; generation: number } | undefined;

  function dismissResults() {
    clearTimeout(timer);
    pending = undefined;
    results.hidden = true;
    results.replaceChildren();
    return ++generation;
  }

  function clear() {
    dismissResults();
    query.value = "";
  }

  function queueSearch(delay = 220) {
    const current = dismissResults();
    const value = query.value.trim();
    if (value.length < 2 || composing || isBusy()) return;
    timer = setTimeout(() => {
      void showSearch(value, current);
    }, delay);
  }

  async function showSearch(value: string, current: number) {
    if (current !== generation || isBusy()) return;
    if (active) {
      pending = { value, generation: current };
      return;
    }
    active = true;
    notify("HOMEを検索中…");
    try {
      const result = await search(value);
      if (current !== generation) return;
      for (const item of result.results) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "result";
        button.textContent = `${item.directory ? "▸" : "·"} ${item.displayPath}`;
        button.onclick = () => {
          void open(item.id);
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
      if (current === generation) notify((error as Error).message);
    } finally {
      active = false;
      const next = pending;
      pending = undefined;
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
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!composing && results.hidden) queueSearch(0);
  };
  query.addEventListener("focus", () => {
    if (results.hidden && query.value.trim().length >= 2 && !composing) queueSearch();
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !form.contains(event.target)) dismissResults();
  });
  form.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && !form.contains(event.relatedTarget))
      dismissResults();
  });
  document.defaultView?.addEventListener("blur", () => {
    if (form.contains(document.activeElement)) dismissResults();
  });
  form.addEventListener("keydown", (event) => {
    if (composing || event.isComposing) return;
    if (event.key === "Escape" && query.value) {
      event.preventDefault();
      clear();
      notify("");
      query.focus();
    } else if (event.key === "ArrowDown" && event.target === query && !results.hidden) {
      event.preventDefault();
      results.querySelector("button")?.focus();
    }
  });

  return {
    clear,
    setBusy(value: boolean) {
      query.disabled = value;
      results.inert = value;
    },
  };
}
