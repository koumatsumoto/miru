import { expect, it } from "vite-plus/test";
import { Script } from "node:vm";
import { palette } from "../src/web/colors";
import {
  mermaidConfiguration,
  isMermaidImage,
  mermaidFrameDocument,
  mermaidInputError,
  mermaidLimits,
} from "../src/shared/mermaid";

it("accepts diagram text while rejecting author configuration and bounded-input overflows", () => {
  expect(mermaidInputError("flowchart LR\n A[日本語] --> B[Local]")).toBeNull();
  expect(mermaidInputError("sequenceDiagram\n Alice->>Bob: hello")).toBeNull();
  expect(mermaidInputError("x".repeat(mermaidLimits.sourceCharacters))).toBeNull();
  for (const source of [
    " ",
    '%%{init: {"securityLevel": "loose"}}%%\ngraph TD; A --> B',
    ' %%  {init: {"themeCSS":"unsafe"}}%%',
    "\ufeff---\nconfig:\n  securityLevel: loose\n---\ngraph TD; A --> B",
    "x".repeat(mermaidLimits.sourceCharacters + 1),
    "x\n".repeat(mermaidLimits.sourceLines),
  ])
    expect(mermaidInputError(source)).not.toBeNull();
});

it("keeps both theme configurations strict and free from author-controlled renderer options", () => {
  for (const theme of ["light", "dark"] as const) {
    const config = mermaidConfiguration(theme);
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
      layout: "dagre",
      maxEdges: mermaidLimits.edges,
      maxTextSize: mermaidLimits.sourceCharacters,
    });
    expect(config.secure).toEqual(
      expect.arrayContaining(["securityLevel", "htmlLabels", "maxEdges"]),
    );
    expect(config.themeVariables.primaryTextColor).toBe(palette[theme].fg);
    expect(config.themeVariables.darkMode).toBe(theme === "dark");
  }
});

it("builds an offline nonce-only renderer without allowing a bundled script closing tag to break out", () => {
  const nonce = "a".repeat(32);
  const html = mermaidFrameDocument(
    'const example = "</ScRiPt><img src=https://invalid.test/>";',
    nonce,
  );
  expect(html.match(/<script nonce=/gu)).toHaveLength(2);
  expect(html.match(/<\/script>/gu)).toHaveLength(2);
  expect(html).toContain("<\\/ScRiPt>");
  expect(html).toContain(`script-src 'nonce-${nonce}'`);
  for (const directive of [
    "connect-src",
    "font-src",
    "worker-src",
    "frame-src",
    "object-src",
    "form-action",
    "base-uri",
  ])
    expect(html).toContain(`${directive} 'none'`);
  expect(html).toContain("img-src data:");
  expect(html).not.toContain("allow-same-origin");
  expect(html).not.toContain("unsafe-eval");
  expect(html).not.toContain("x-ev-session");
  expect(html).toContain("event.source !== parent");
  for (const match of html.matchAll(/<script nonce="[a-f0-9]{32}">([\s\S]*?)<\/script>/gu))
    expect(() => new Script(match[1])).not.toThrow();
  expect(() => mermaidFrameDocument("", '"; script-src *')).toThrow("nonce");
});

it("accepts only bounded PNG data URLs from the isolated renderer", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  expect(isMermaidImage(png)).toBe(true);
  for (const output of [
    undefined,
    "https://example.invalid/image.png",
    "data:image/svg+xml,<svg/>",
    "data:text/html;base64,iVBORw0KGgo=",
    "data:image/png;base64,PHN2Zy8+",
    png + "\n",
    "data:image/png;base64,iVBORw0KGgo" + "A".repeat(mermaidLimits.imageCharacters),
  ])
    expect(isMermaidImage(output)).toBe(false);
});
