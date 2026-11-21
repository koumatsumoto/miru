import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const fixturePackage = {
  name: "@koumatsumoto/miru",
  version: "0.0.0",
  private: true,
  bin: { miru: "dist/cli.mjs" },
};

// Small valid asset set; no build tools, network or OS daemon required.
export async function writeUpdateSources(root: string) {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/cli.ts"), "// fixture\n");
  await writeFile(path.join(root, "vite.config.ts"), "export default {};\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify(fixturePackage));
  await writeFile(
    path.join(root, "scripts/build.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.env.MIRU_BUILD_DIR;
for (const [name, content] of Object.entries({
  "cli.mjs": "// candidate",
  "THIRD_PARTY_LICENSES.txt": "fixture",
  "web/index.html": "<html>__EV_SESSION__</html>",
  "web/assets/mermaid.tiny.js": "fixture",
  "web/assets/pdf.worker.mjs": "fixture",
  "web/assets/pdfjs/cmaps/data": "fixture",
  "web/assets/pdfjs/standard_fonts/data": "fixture",
  "web/assets/pdfjs/wasm/data": "fixture",
})) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}`,
  );
}

export async function linkedLauncher(root: string) {
  await mkdir(path.join(root, "dist"), { recursive: true });
  const entry = path.join(root, "dist/cli.mjs");
  await writeFile(entry, "// stable linked launcher");
  return entry;
}
