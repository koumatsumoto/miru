import { palette, type Theme } from "./theme.js";

export const mermaidLimits = {
  diagrams: 8,
  sourceCharacters: 12000,
  sourceLines: 200,
  edges: 150,
  svgCharacters: 1000000,
  imageCharacters: 2 * 1024 * 1024,
  timeoutMs: 5000,
} as const;

export function isMermaidImage(value: unknown): value is string {
  if (typeof value !== "string" || value.length > mermaidLimits.imageCharacters) return false;
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix)) return false;
  const data = value.slice(prefix.length);
  return data.length % 4 === 0 && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(data);
}

export function mermaidInputError(source: string): string | null {
  if (!source.trim()) return "Mermaidの内容が空です。";
  if (
    source.length > mermaidLimits.sourceCharacters ||
    source.split("\n").length > mermaidLimits.sourceLines
  )
    return "Mermaidが大きすぎます（12,000文字・200行まで）。";
  // Author-controlled initialization/frontmatter can weaken renderer settings.
  // Reject it rather than trying to merge selected keys from an untrusted config.
  if (/%%\s*\{/u.test(source) || /^---(?:\r?\n|$)/u.test(source.trimStart()))
    return "Mermaidの初期化指示・frontmatterは安全のため使用できません。";
  return null;
}

export function mermaidConfiguration(theme: Theme) {
  const colors = palette[theme];
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: mermaidLimits.sourceCharacters,
    maxEdges: mermaidLimits.edges,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    layout: "dagre",
    look: "classic",
    theme: "base",
    logLevel: 5,
    deterministicIds: true,
    deterministicIDSeed: "miru",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "suppressErrorRendering",
      "maxTextSize",
      "maxEdges",
      "htmlLabels",
      "flowchart",
      "layout",
      "theme",
      "themeVariables",
    ],
    themeVariables: {
      darkMode: theme === "dark",
      background: colors.bg,
      primaryColor: colors.canvas,
      primaryTextColor: colors.fg,
      primaryBorderColor: colors.border,
      secondaryColor: colors.selected,
      secondaryTextColor: colors.fg,
      secondaryBorderColor: colors.border,
      tertiaryColor: colors.canvas,
      tertiaryTextColor: colors.fg,
      tertiaryBorderColor: colors.border,
      lineColor: colors.accent,
      textColor: colors.fg,
      fontFamily: "sans-serif",
    },
  };
}

export function mermaidFrameDocument(bundle: string, nonce: string): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error("Invalid renderer nonce.");
  const configurations = JSON.stringify({
    light: mermaidConfiguration("light"),
    dark: mermaidConfiguration("dark"),
  });
  // Only trusted bundled JavaScript and fixed configuration enter srcdoc. Diagram
  // source arrives later through postMessage, never through HTML interpolation.
  const bootstrap = `"use strict";
const channel = location.hash.slice(1);
if (!/^[a-f0-9]{32}$/.test(channel)) throw new Error("Invalid renderer channel");
const configurations = ${configurations};
let started = false;
mermaid.initialize(configurations.light);
addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.channel !== channel || event.data?.type !== "render" || started) return;
  started = true;
  try {
    const {source, theme} = event.data;
    if (typeof source !== "string" || source.length > ${mermaidLimits.sourceCharacters} || !["light", "dark"].includes(theme)) throw new Error("Invalid input");
    mermaid.initialize(configurations[theme]);
    const result = await mermaid.render("miru-diagram", source);
    if (typeof result.svg !== "string" || result.svg.length > ${mermaidLimits.svgCharacters}) throw new Error("Output limit");
    // Parse and rasterize only inside this opaque, network-disabled renderer.
    // The parent receives PNG bytes, never raw generated SVG or active markup.
    const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    const svg = parsed.documentElement;
    if (svg.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("Invalid SVG");
    const box = (svg.getAttribute("viewBox") || "").trim().split(/[\\s,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error("Invalid dimensions");
    const scale = Math.min(2, 4096 / box[2], 4096 / box[3], Math.sqrt(4000000 / (box[2] * box[3])));
    if (scale < 0.25) throw new Error("Diagram dimensions too large");
    const width = Math.max(1, Math.floor(box[2] * scale)), height = Math.max(1, Math.floor(box[3] * scale));
    svg.removeAttribute("style");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Image unavailable"));
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    });
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0, width, height);
    const png = canvas.toDataURL("image/png");
    if (png.length > ${mermaidLimits.imageCharacters}) throw new Error("Image output limit");
    parent.postMessage({channel, type:"rendered", png}, "*");
  } catch {
    parent.postMessage({channel, type:"failed"}, "*");
  }
});
parent.postMessage({channel, type:"ready"}, "*");`;
  const script = (source: string) =>
    `<script nonce="${nonce}">${source.replace(/<\/script/giu, (tag) => tag.replace("/", "\\/"))}</script>`;
  const csp = mermaidFrameCsp(nonce);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body>${script(bundle)}${script(bootstrap)}</body></html>`;
}

export function mermaidFrameCsp(nonce: string): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error("Invalid renderer nonce.");
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; worker-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'`;
}
