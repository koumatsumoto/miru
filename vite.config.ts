import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { version } from "./package.json";
const outDir = path.resolve(
  process.env.MIRU_BUILD_DIR ?? fileURLToPath(new URL("./dist", import.meta.url)),
);
let revision = "";
try {
  revision = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  }).trim();
} catch {}
export default defineConfig({
  root: "src/web",
  define: { __MIRU_VERSION__: JSON.stringify(`v${version}${revision ? ` · ${revision}` : ""}`) },
  worker: { format: "es" },
  build: { outDir: path.join(outDir, "web"), emptyOutDir: true, assetsInlineLimit: 0 },
  pack: {
    entry: ["src/cli.ts"],
    outDir,
    format: "esm",
    platform: "node",
    target: "node24",
    clean: false,
    dts: false,
    sourcemap: false,
  },
  test: { root: ".", include: ["tests/**/*.test.ts"], testTimeout: 15000 },
  lint: { ignorePatterns: ["dist/**", "node_modules/**"] },
  fmt: { ignorePatterns: ["dist/**", "node_modules/**", "package-lock.json"] },
});
