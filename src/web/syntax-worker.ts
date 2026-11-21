import { codeToTokensBase, createShikiPrimitiveAsync } from "@shikijs/primitive";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { Theme } from "./colors";
import { syntaxLimits } from "./syntax-language";

const grammars = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  xml: () => import("@shikijs/langs/xml"),
  python: () => import("@shikijs/langs/python"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("./syntax-cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  rust: () => import("@shikijs/langs/rust"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  docker: () => import("@shikijs/langs/docker"),
  markdown: () => import("@shikijs/langs/markdown"),
};

export type HighlightBlock = { source: string; language: string };
export type HighlightRequest = { blocks: HighlightBlock[]; theme: Theme };
export type HighlightResult = {
  foreground?: string;
  background?: string;
  tokens: Array<{ text: string; color?: string; fontStyle?: number }>;
};

const highlighter = createShikiPrimitiveAsync({
  themes: [githubLight, githubDark],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});

function grammar(name: string) {
  return Object.hasOwn(grammars, name) ? grammars[name as keyof typeof grammars] : undefined;
}

async function tokenize(
  block: HighlightBlock,
  theme: Theme,
  tokenBudget: number,
): Promise<HighlightResult | null> {
  const load = grammar(block.language);
  if (!load) return null;
  const shiki = await highlighter;
  if (!shiki.getLoadedLanguages().includes(block.language)) await shiki.loadLanguage(await load());
  const themeId = theme === "dark" ? "github-dark" : "github-light";
  const palette = shiki.getTheme(themeId);
  const lines = codeToTokensBase(shiki, block.source, { lang: block.language, theme: themeId });
  const breaks = block.source.match(/\r\n|[\r\n]/gu) ?? [];
  const tokens: HighlightResult["tokens"] = [];
  for (const [index, line] of lines.entries()) {
    for (const token of line) {
      if (tokens.length >= tokenBudget) return null;
      tokens.push({ text: token.content, color: token.color, fontStyle: token.fontStyle });
    }
    if (index < breaks.length) tokens.push({ text: breaks[index] });
  }
  if (tokens.length > tokenBudget || tokens.map(({ text }) => text).join("") !== block.source)
    return null;
  return { foreground: palette?.fg, background: palette?.bg, tokens };
}

globalThis.onmessage = (message: MessageEvent<HighlightRequest>) => {
  void (async () => {
    let remaining = syntaxLimits.tokens;
    const results: Array<HighlightResult | null> = [];
    for (const block of message.data.blocks) {
      const result = await tokenize(block, message.data.theme, remaining).catch(() => null);
      if (result) remaining -= result.tokens.length;
      results.push(result);
    }
    globalThis.postMessage(results);
  })();
};
