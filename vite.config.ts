import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
const outDir = path.resolve(
  process.env.MIRU_BUILD_DIR ?? fileURLToPath(new URL("./dist", import.meta.url)),
);
export default defineConfig({
  root: "src/web",
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
