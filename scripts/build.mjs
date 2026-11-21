import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vp = path.join(root, "node_modules", "vite-plus", "bin", "vp");
try {
  await access(vp);
} catch {
  throw new Error("Vite+ is not installed in this checkout. Run npm ci first.");
}

async function run(file, args = []) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  const [status] = await once(child, "exit");
  if (status !== 0)
    throw new Error(
      `MIRU build step failed: ${path.basename(file)}${args.length ? " " + args.join(" ") : ""}`,
    );
}

await run(vp, ["build"]);
await run(vp, ["pack"]);
await run(path.join(root, "scripts", "assets.mjs"));
await run(path.join(root, "scripts", "licenses.mjs"));
