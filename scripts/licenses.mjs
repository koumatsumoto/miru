import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const output = path.resolve(process.env.MIRU_BUILD_DIR ?? "dist");
const packages = ["marked", "dompurify", "diff", "pdfjs-dist", "@mermaid-js/tiny"];
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
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "THIRD_PARTY_LICENSES.txt"), notices);
