import type { Theme } from "./colors";
import { fenceLanguage, fileLanguage, isHighlightable, syntaxLimits } from "./syntax-language";
import type { HighlightBlock, HighlightRequest, HighlightResult } from "./syntax-worker";

let worker: Worker | undefined;
let cancel: (() => void) | undefined;

export function cancelHighlighting() {
  cancel?.();
}

function tokenize(blocks: HighlightBlock[], theme: Theme): Promise<Array<HighlightResult | null>> {
  if (!blocks.length) return Promise.resolve([]);
  cancelHighlighting();
  try {
    worker ??= new Worker(new URL("./syntax-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve([]);
  }
  const active = worker;
  return new Promise((resolve) => {
    const settle = (results: Array<HighlightResult | null>, reset = false) => {
      clearTimeout(timeout);
      active.onmessage = active.onerror = active.onmessageerror = null;
      cancel = undefined;
      if (reset) {
        active.terminate();
        worker = undefined;
      }
      resolve(results);
    };
    const timeout = setTimeout(() => settle([], true), 4_000);
    cancel = () => settle([], true);
    active.onmessage = (event: MessageEvent<Array<HighlightResult | null>>) => settle(event.data);
    active.onerror = (event) => {
      event.preventDefault();
      settle([], true);
    };
    active.onmessageerror = () => settle([], true);
    const request: HighlightRequest = { blocks, theme };
    try {
      active.postMessage(request);
    } catch {
      settle([], true);
    }
  });
}

function safeColor(value?: string): string {
  return value && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value) ? value : "";
}

function applyTokens(node: HTMLElement, result: HighlightResult) {
  const doc = node.ownerDocument;
  const fragment = doc.createDocumentFragment();
  for (const { text, color, fontStyle = 0 } of result.tokens) {
    const foreground = safeColor(color);
    if (!foreground && fontStyle <= 0) fragment.append(doc.createTextNode(text));
    else {
      const span = doc.createElement("span");
      span.textContent = text;
      span.style.color = foreground;
      if (fontStyle > 0) {
        if (fontStyle & 1) span.style.fontStyle = "italic";
        if (fontStyle & 2) span.style.fontWeight = "bold";
        if (fontStyle & 4) span.style.textDecorationLine = "underline";
      }
      fragment.append(span);
    }
  }
  node.replaceChildren(fragment);
  const pre = node.closest("pre") ?? node;
  pre.classList.add("syntax-highlighted");
  pre.style.color = safeColor(result.foreground);
  pre.style.backgroundColor = safeColor(result.background);
}

export async function renderCode(
  source: string,
  filename: string,
  theme: Theme,
): Promise<HTMLPreElement> {
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.textContent = source;
  const language = fileLanguage(filename);
  if (language && isHighlightable(source)) {
    const [result] = await tokenize([{ source, language }], theme);
    if (result) applyTokens(pre, result);
  }
  return pre;
}

export async function highlightMarkdown(doc: Document, theme: Theme): Promise<void> {
  let remaining = syntaxLimits.total;
  const blocks: HighlightBlock[] = [];
  const nodes: HTMLElement[] = [];
  for (const node of doc.querySelectorAll<HTMLElement>("pre > code")) {
    if (nodes.length >= syntaxLimits.blocks) break;
    if (node.classList.contains("language-mermaid")) continue;
    const label = Array.from(node.classList).find((name) => name.startsWith("language-"));
    const language = label && fenceLanguage(label.slice("language-".length));
    const source = node.textContent ?? "";
    if (!language || source.length > remaining || !isHighlightable(source)) continue;
    remaining -= source.length;
    blocks.push({ source, language });
    nodes.push(node);
  }
  const results = await tokenize(blocks, theme);
  for (const [index, result] of results.entries()) if (result) applyTokens(nodes[index], result);
}
