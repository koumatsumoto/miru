import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { preferredEntry, updateLocalBuild } from "../src/server/local-update";
import { fixturePackage, linkedLauncher, writeUpdateSources } from "./fixtures/update-source";
import { withUpstreamUpdate } from "../src/server/upstream-update";

it.skipIf(process.platform === "win32")(
  "pins official main, installs new locked dependencies off-tree, and refuses a changed checkout",
  async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "miru-upstream-test-")));
    try {
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
      vi.stubEnv("NPM_CONFIG_CACHE", path.join(base, "cache"));
      vi.stubEnv("NPM_CONFIG_OFFLINE", "true");
      const root = path.join(base, "linked");
      const author = path.join(base, "author");
      const remote = path.join(base, "remote.git");
      const shim = path.join(base, "ssh");
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=MIRU test",
            "-c",
            "user.email=test@example.invalid",
            "-C",
            cwd,
            ...args,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      const commit = (cwd: string, message: string) => {
        git(cwd, "add", ".");
        git(cwd, "commit", "-qm", message);
      };
      // No external network or test-only origin override in production.
      await writeFile(shim, '#!/bin/sh\nexec git-upload-pack "$MIRU_TEST_REMOTE"\n', {
        mode: 0o700,
      });
      vi.stubEnv("GIT_SSH_VARIANT", "ssh");
      vi.stubEnv("GIT_SSH_COMMAND", shim);
      vi.stubEnv("MIRU_TEST_REMOTE", remote);
      git(base, "init", "-q", "--bare", "-b", "main", remote);
      git(base, "init", "-q", "-b", "main", author);
      await writeUpdateSources(author);
      await writeFile(
        path.join(author, ".gitignore"),
        ".cache/\ndist/\nnode_modules/\nignored.fixture\n",
      );
      commit(author, "base");
      git(author, "push", remote, "main");
      git(base, "clone", "-q", remote, root);
      const previous = git(root, "rev-parse", "HEAD");
      await expect(withUpstreamUpdate(root, async () => {})).rejects.toThrow(
        "origin must point directly",
      );
      git(root, "remote", "set-url", "origin", "git@github.com:koumatsumoto/miru.git");
      await mkdir(path.join(author, "feature"));
      await writeFile(
        path.join(author, "feature/package.json"),
        '{"name":"feature","version":"1.0.0"}',
      );
      await writeFile(path.join(author, "feature/revision"), "new dependency");
      await writeFile(
        path.join(author, "package.json"),
        JSON.stringify({ ...fixturePackage, devDependencies: { feature: "file:./feature" } }),
      );
      execFileSync(
        "npm",
        [
          "install",
          "--offline",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: author, stdio: "pipe" },
      );
      await writeFile(path.join(author, "ignored.fixture"), "upstream");
      git(author, "add", "-f", "ignored.fixture");
      commit(author, "new release");
      git(author, "push", remote, "main");
      const target = git(author, "rev-parse", "HEAD");
      await mkdir(path.join(root, "node_modules"));
      const local = path.join(root, "node_modules", "sentinel");
      await writeFile(local, "leave me alone");
      const edit = path.join(root, "new-note");
      await expect(
        withUpstreamUpdate(root, async ({ revision, buildFrom, advance }) => {
          expect(revision).toBe(target);
          await buildFrom(async (source) => {
            expect(source).not.toBe(root);
            expect(git(source, "rev-parse", "HEAD")).toBe(target);
            expect(await readFile(path.join(source, "node_modules/feature/revision"), "utf8")).toBe(
              "new dependency",
            );
            expect(git(root, "rev-parse", "HEAD")).toBe(previous);
            await writeFile(edit, "new local edit");
          });
          await advance();
        }),
      ).rejects.toThrow("uncommitted or untracked");
      expect(await readFile(edit, "utf8")).toBe("new local edit");
      await rm(edit);
      const ignored = path.join(root, "ignored.fixture");
      await writeFile(ignored, "keep my ignored data");
      await expect(withUpstreamUpdate(root, (candidate) => candidate.advance())).rejects.toThrow(
        "Cannot fast-forward safely",
      );
      expect(await readFile(ignored, "utf8")).toBe("keep my ignored data");
      expect(git(root, "rev-parse", "HEAD")).toBe(previous);
      await rm(ignored);
      const launcher = await linkedLauncher(root);
      // A healthy boot is simulated; the real checkout advancement, marker
      // installation/rollback, build and npm operations run in disposable dirs.
      const activateNormally: Parameters<typeof updateLocalBuild>[2] = async (_, publish) => {
        await publish(async () => {});
        return {};
      };
      await updateLocalBuild(launcher, "local", activateNormally);
      const oldBuild = await preferredEntry(launcher);
      await expect(
        updateLocalBuild(launcher, "upstream", async (_, publish) => {
          await publish(async () => {
            throw new Error("injected runtime publish failure");
          });
          return {};
        }),
      ).rejects.toThrow("Local main was already fast-forwarded");
      expect(git(root, "rev-parse", "HEAD")).toBe(target);
      expect(await preferredEntry(launcher)).toBe(oldBuild);
      const retry = await updateLocalBuild(launcher, "upstream", activateNormally);
      expect(retry.revision).toBe(target);
      const fresh = await preferredEntry(launcher);
      expect(fresh).not.toBe(oldBuild);
      await updateLocalBuild(launcher, "upstream", activateNormally);
      expect(await preferredEntry(launcher)).toBe(fresh);
      expect(git(root, "rev-parse", "HEAD")).toBe(target);
      expect(git(root, "rev-parse", "origin/main")).toBe(target);
      expect(await readFile(local, "utf8")).toBe("leave me alone");
      expect(git(root, "status", "--porcelain")).toBe("");
      expect(git(root, "for-each-ref", "refs/miru")).toBe("");
      expect(git(root, "worktree", "list", "--porcelain").split("worktree ")).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      await rm(base, { recursive: true, force: true });
    }
  },
);
