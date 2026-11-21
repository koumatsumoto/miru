import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
const assets = path.resolve(process.env.MIRU_BUILD_DIR ?? "dist", "web", "assets");
const target = path.join(assets, "pdfjs");
await mkdir(target, { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${directory}`, `${target}/${directory}`, { recursive: true });
await cp(
  "node_modules/@mermaid-js/tiny/dist/mermaid.tiny.js",
  path.join(assets, "mermaid.tiny.js"),
);
