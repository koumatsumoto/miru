import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const output = path.resolve(process.env.MIRU_BUILD_DIR ?? "dist");
const packages = [
  "marked",
  "dompurify",
  "diff",
  "pdfjs-dist",
  "@mermaid-js/tiny",
  "@shikijs/engine-javascript",
  "@shikijs/langs",
  "@shikijs/primitive",
  "@shikijs/themes",
  "@shikijs/types",
  "@shikijs/vscode-textmate",
  "oniguruma-to-es",
  "oniguruma-parser",
  "regex",
  "regex-recursion",
  "regex-utilities",
];
let notices = "# Bundled third-party licenses\n\nThese dependencies are bundled for offline use.\n";
for (const name of packages) {
  const root = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  let license = "";
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    try {
      license = await readFile(`${root}/${candidate}`, "utf8");
      break;
    } catch {}
  }
  if (!license) throw new Error(`Missing license: ${name}`);
  notices += `\n## ${name} ${pkg.version} (${pkg.license})\n\n${license}\n`;
}
// These exact upstream attribution packages match the versions in Shiki's pnpm lockfile.
for (const name of ["tm-grammars", "tm-themes"]) {
  const root = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  const notice = await readFile(`${root}/NOTICE`, "utf8");
  notices += `\n## ${name} ${pkg.version} upstream notices\n\n${notice}\n`;
}
for (const name of ["yaml-textmate", "toml-textmate"]) {
  const notice = await readFile(`licenses/${name}.txt`, "utf8");
  notices += `\n## ${name} grammar\n\n${notice}\n`;
}
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "THIRD_PARTY_LICENSES.txt"), notices);
