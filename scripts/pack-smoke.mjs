import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
const directory = await mkdtemp(path.join(os.tmpdir(), "ev-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let child;
try {
  const info = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" }),
  )[0];
  const tarball = path.resolve(info.filename);
  try {
    const install = path.join(directory, "install");
    execFileSync(
      npm,
      [
        "install",
        "--prefix",
        install,
        "--omit=dev",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { stdio: "pipe" },
    );
    const root = path.join(install, "node_modules", "@koumatsumoto", "miru");
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (manifest.bin.miru !== "dist/cli.mjs" || manifest.bin.ev !== "dist/cli.mjs")
      throw new Error("MIRU or compatibility CLI alias is missing.");
    if (
      !execFileSync(process.execPath, [path.join(root, "dist", "cli.mjs"), "--help"], {
        encoding: "utf8",
      }).includes("MIRU")
    )
      throw new Error("Packaged CLI help unavailable.");
    const licenses = await readFile(path.join(root, "dist", "THIRD_PARTY_LICENSES.txt"), "utf8");
    if (!licenses.includes("@mermaid-js/tiny")) throw new Error("Bundled Mermaid license missing.");
    for (const notice of ["@shikijs/engine-javascript", "tm-grammars", "tm-themes"]) {
      if (!licenses.includes(notice)) throw new Error(`Bundled attribution missing: ${notice}`);
    }
    const viewRoot = path.join(directory, "view");
    await mkdir(viewRoot);
    child = spawn(
      process.execPath,
      [path.join(root, "dist", "cli.mjs"), "--foreground", viewRoot],
      {
        env: { ...process.env, EV_NO_OPEN: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const url = await Promise.race([
      new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (data) => {
          output += data.toString();
          const match = output.match(/http:\/\/localhost:\d+/u);
          if (match) resolve(match[0]);
        });
        child.once("exit", () => reject(new Error("Packaged CLI exited before startup.")));
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Packaged CLI startup timed out.")), 10000);
        timer.unref();
      }),
    ]);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Packaged HTML unavailable.");
    const html = await response.text();
    const renderer = await fetch(url + "/renderer/mermaid");
    if (!renderer.ok || !(await renderer.text()).includes('globalThis["mermaid"]'))
      throw new Error("Bundled offline Mermaid renderer missing.");
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/gu)) {
      if (!(await fetch(url + match[1])).ok) throw new Error("Packaged asset missing.");
    }
    if (!info.files.some((file) => /pdf\.worker.*\.mjs$/u.test(file.path)))
      throw new Error("PDF worker missing.");
    for (const asset of [/syntax-worker-.*\.js$/u, /typescript-.*\.js$/u, /json-.*\.js$/u]) {
      const bundled = info.files.find((file) => asset.test(file.path));
      if (!bundled || !(await fetch(url + bundled.path.replace("dist/web", ""))).ok)
        throw new Error("Packaged syntax asset missing.");
    }
    console.log(
      "PASS: packed CLI installed without runtime dependencies; HTML, assets, worker and licenses present.",
    );
  } finally {
    await rm(tarball, { force: true });
  }
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGINT");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
