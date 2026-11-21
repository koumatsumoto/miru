const aliases = new Map(
  Object.entries({
    bash: "shellscript",
    sh: "shellscript",
    zsh: "shellscript",
    shell: "shellscript",
    csharp: "csharp",
    cs: "csharp",
    "c#": "csharp",
    "c++": "cpp",
    cc: "cpp",
    cxx: "cpp",
    h: "c",
    hpp: "cpp",
    hxx: "cpp",
    dockerfile: "docker",
    golang: "go",
    htm: "html",
    javascript: "javascript",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json5: "json5",
    md: "markdown",
    mdown: "markdown",
    py: "python",
    pyw: "python",
    rb: "ruby",
    rs: "rust",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    yml: "yaml",
    xhtml: "xml",
    xsd: "xml",
    xsl: "xml",
    svg: "xml",
  }),
);
const supported = new Set([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "jsonc",
  "json5",
  "html",
  "css",
  "scss",
  "xml",
  "python",
  "shellscript",
  "yaml",
  "toml",
  "sql",
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "rust",
  "ruby",
  "php",
  "powershell",
  "docker",
  "markdown",
]);

export function fenceLanguage(info: string): string | undefined {
  const input = info.trim().toLowerCase();
  const language = aliases.get(input) ?? input;
  return supported.has(language) ? language : undefined;
}

export function fileLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/^(?:dockerfile|containerfile)(?:\.|$)/u.test(lower)) return "docker";
  if ([".bashrc", ".zshrc", ".bash_profile", ".profile"].includes(lower)) return "shellscript";
  if (lower.endsWith(".ps1") || lower.endsWith(".psm1") || lower.endsWith(".psd1"))
    return "powershell";
  return fenceLanguage(lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower);
}

export const syntaxLimits = {
  block: 32_000,
  total: 64_000,
  lines: 800,
  line: 1_000,
  blocks: 24,
  tokens: 12_000,
};
export function isHighlightable(source: string): boolean {
  if (!source || source.length > syntaxLimits.block) return false;
  const lines = source.split(/\r\n|[\r\n]/u);
  return (
    lines.length <= syntaxLimits.lines && lines.every((line) => line.length <= syntaxLimits.line)
  );
}
