import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyUpstream } from "./upstream-smoke.mjs";

const MODULE = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const exec = promisify(execFile);
const deadline = 30_000;
const updatedMarker = '<meta name="miru-test-generation" content="updated">';

if (!["linux", "darwin"].includes(process.platform)) {
  console.log("SKIP: detached MIRU daemon v1 is for WSL, Linux and macOS.");
} else await run();

async function run() {
  // Keep the Unix socket below macOS's short limit, even with a long test checkout path.
  // Everything that could persist is under this one disposable tree, never user HOME.
  const root = await realpath(await mkdtemp("/tmp/miru-e2e-"));
  const checkout = path.join(root, "checkout");
  const dist = path.join(checkout, "dist");
  const cli = path.join(dist, "cli.mjs");
  const home = path.join(root, "home");
  const runtime = path.join(root, "run");
  const first = path.join(home, "日本語 first");
  const second = path.join(home, "other scope");
  const firstFile = path.join(first, "first.txt");
  const secondFile = path.join(second, "other.txt");
  const toolBin = path.join(root, "bin");
  const npmCache = path.join(root, "npm-cache");
  const launchLog = path.join(root, "unexpected-browser");
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    MIRU_RUNTIME_DIR: runtime,
    MIRU_NO_OPEN: "1",
    EV_NO_OPEN: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    MIRU_SMOKE_LAUNCH_LOG: launchLog,
    MIRU_SMOKE_DIST: dist,
    MIRU_SMOKE_INVOKED: path.join(root, "build-invoked"),
    MIRU_SMOKE_REMOTE: path.join(root, "remote.git"),
    GIT_SSH_COMMAND: path.join(toolBin, "fixture-ssh"),
    GIT_SSH_VARIANT: "ssh",
    PATH: [toolBin, process.env.PATH ?? ""].join(path.delimiter),
  };
  let canStop = false;
  let failure;
  try {
    await Promise.all(
      [
        first,
        second,
        runtime,
        toolBin,
        npmCache,
        path.join(checkout, "src"),
        path.join(checkout, "scripts"),
      ].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
    );
    await cp(path.dirname(MODULE), dist, { recursive: true });
    await writeFile(firstFile, "first scope text\n");
    await writeFile(secondFile, "other scope text\n");
    // No downloaded dependencies and no shell access to a real browser. These
    // shims fail even if a change accidentally ignores MIRU_NO_OPEN.
    for (const launcher of ["xdg-open", "open", "powershell.exe"]) {
      await writeFile(
        path.join(toolBin, launcher),
        '#!/bin/sh\nprintf "unexpected launch\\n" > "$MIRU_SMOKE_LAUNCH_LOG"\nexit 67\n',
        { mode: 0o700 },
      );
    }
    await writeFile(
      path.join(checkout, "package.json"),
      JSON.stringify({
        name: "@koumatsumoto/miru",
        version: "0.1.0",
        private: true,
        type: "module",
        bin: { miru: "dist/cli.mjs", ev: "dist/cli.mjs" },
      }),
    );
    await writeFile(path.join(checkout, "src", "cli.ts"), "// Disposable updater fixture.\n");
    await writeFile(path.join(checkout, "vite.config.ts"), "export default {};\n");
    await writeFile(
      path.join(checkout, "scripts", "build.mjs"),
      `import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const out = process.env.MIRU_BUILD_DIR;
assert(out && path.isAbsolute(out) && out !== path.resolve("dist"), "not an isolated build");
if (process.env.MIRU_SMOKE_UPSTREAM === "1") {
  assert.notEqual(path.resolve("dist"), process.env.MIRU_SMOKE_DIST);
  assert.equal(await readFile("node_modules/miru-smoke-feature/revision", "utf8"), "remote-only");
}
await writeFile(process.env.MIRU_SMOKE_INVOKED, process.env.MIRU_SMOKE_BUILD);
if (process.env.MIRU_SMOKE_EDIT_DURING_BUILD)
  await writeFile(process.env.MIRU_SMOKE_EDIT_DURING_BUILD, "keep my edit");
await mkdir(out, {recursive:true});
if (process.env.MIRU_SMOKE_BUILD === "fail") {
  await writeFile(path.join(out, "cli.mjs"), "unusable partial artifact");
  process.exit(41);
}
await cp(process.env.MIRU_SMOKE_DIST, out, { recursive: true });
if (process.env.MIRU_SMOKE_BUILD === "bad") {
  await writeFile(path.join(out, "cli.mjs"), "process.exit(42);");
} else {
  const index = path.join(out, "web/index.html");
  const html = await readFile(index, "utf8");
  assert(html.includes("</head>"));
  await writeFile(index, html.replace("</head>", ${JSON.stringify(updatedMarker)} + "</head>"));
}
`,
    );
    const originalIndex = await readFile(path.join(dist, "web/index.html"), "utf8");
    assert(!originalIndex.includes(updatedMarker), "fixture begins on the old generation");
    canStop = true;

    // If the daemon stays attached or inherits the CLI's output pipe, this call
    // cannot finish, and execFile's deadline fails the test.
    const a = await view(urlOf(await command([firstFile])));
    const readyA = await resident("status");
    assert.equal(readyA.views, 1);
    assert.equal(a.state.root.displayPath, first);
    assert.equal(a.state.selected?.name, "first.txt");
    assert.equal(
      (await api(a, { op: "read", id: a.state.selected.id })).text,
      "first scope text\n",
    );

    const b = await view(urlOf(await command([secondFile])));
    const readyB = await resident("server");
    assert.equal(readyB.pid, readyA.pid, "server and second open reuse the original daemon");
    assert.equal(readyB.views, 2);
    assert.notEqual(a.url.origin, b.url.origin, "views get separate loopback origins");
    assert.notEqual(a.token, b.token, "views have distinct session values");
    assert.equal(b.state.root.displayPath, second);
    assert.equal(
      (await api(b, { op: "read", id: b.state.selected.id })).text,
      "other scope text\n",
    );
    assert.equal(
      (await api(a, { op: "state" })).root.displayPath,
      first,
      "opening B does not change A",
    );
    await api(b, { op: "read", id: a.state.selected.id }, 400);

    const c = await view(urlOf(await command([firstFile])));
    assert.notEqual(c.url.origin, a.url.origin, "reopening a path creates a separate view");
    assert.deepEqual(await resident("status"), { pid: readyA.pid, views: 3 });
    await api(c, { op: "read", id: a.state.selected.id }, 400);
    console.log("PASS: detached first open, daemon reuse, scope isolation and fresh views.");

    for (const mode of ["fail", "bad"]) {
      await assert.rejects(
        command(["update", "--local"], { MIRU_SMOKE_BUILD: mode }),
        (error) => Number.isInteger(error.code) && !error.killed,
        "update should reject a failed build or failed candidate, not hang",
      );
      assert.equal(await readFile(env.MIRU_SMOKE_INVOKED, "utf8"), mode);
      assert.deepEqual(await resident("status"), { pid: readyA.pid, views: 3 });
      assert.equal((await api(a, { op: "state" })).root.displayPath, first);
      assert.equal((await api(b, { op: "state" })).root.displayPath, second);
      assert.equal(await readFile(path.join(dist, "web/index.html"), "utf8"), originalIndex);
    }
    console.log("PASS: failed rebuild and unhealthy candidate leave old daemon and views working.");

    await command(["update", "--local"], { MIRU_SMOKE_BUILD: "success" });
    assert.equal(await readFile(env.MIRU_SMOKE_INVOKED, "utf8"), "success");
    const updated = await resident("status");
    assert.notEqual(updated.pid, readyA.pid);
    assert.equal(updated.views, 0);
    await Promise.all([a, b, c].map(({ url }) => closed(url)));
    const after = await view(urlOf(await command([secondFile])));
    assert(after.html.includes(updatedMarker), "reopened view is served from the activated build");
    assert.equal(
      (await api(after, { op: "read", id: after.state.selected.id })).text,
      "other scope text\n",
    );
    assert.deepEqual(await resident("status"), { pid: updated.pid, views: 1 });
    await command(["stop"]);
    await closed(after.url);
    const reopened = await Promise.all(
      [command(["first.txt"]), command([secondFile])].map(async (output) =>
        view(urlOf(await output)),
      ),
    );
    assert(
      reopened.every(({ html }) => html.includes(updatedMarker)),
      "a cold start keeps the active build",
    );
    assert.notEqual(reopened[0].url.origin, reopened[1].url.origin);
    assert.deepEqual(
      reopened.map(({ state }) => state.root.displayPath),
      [first, second],
    );
    assert.equal((await resident("status")).views, 2, "concurrent cold opens share one daemon");
    // A marker that cannot be replaced must not retire the live daemon either.
    const marker = path.join(checkout, ".cache/miru-builds/active.json");
    await rename(marker, marker + ".saved");
    await mkdir(marker);
    try {
      await assert.rejects(command(["update", "--local"], { MIRU_SMOKE_BUILD: "marker-failure" }));
      assert.equal((await resident("status")).views, 2);
      await api(reopened[0], { op: "state" });
    } finally {
      await rm(marker, { recursive: true });
      await rename(marker + ".saved", marker);
    }

    await verifyUpstream({
      root,
      checkout,
      env,
      command,
      assertOld: async (old) => {
        assert.deepEqual(await resident("status"), old);
        await Promise.all(reopened.map((item) => api(item, { op: "state" })));
      },
      resident,
      openView: async () => view(urlOf(await command([firstFile]))),
    });
    await command(["stop"]);
    await Promise.all(reopened.map(({ url }) => closed(url)));
    await assert.rejects(readFile(launchLog, "utf8"), { code: "ENOENT" });
    canStop = false;
    console.log(
      "PASS: healthy update activates rebuilt assets, old views close, stop cleans up; no browser launched.",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (canStop) await command(["stop"]);
    } catch (error) {
      if (failure) console.error("Isolated daemon cleanup also failed:", error.code);
      failure ??= error;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;

  async function command(args, extra = {}) {
    const { stdout } = await exec(process.execPath, [cli, ...args], {
      cwd: first,
      env: { ...env, ...extra },
      timeout: deadline,
      maxBuffer: 512 * 1024,
    });
    return stdout;
  }

  async function resident(commandName) {
    const stdout = await command([commandName]);
    const match = /\bpid=(\d+)\s+views=(\d+)\b/u.exec(stdout);
    assert(match, `No resident status from ${commandName}: ${stdout}`);
    return { pid: Number(match[1]), views: Number(match[2]) };
  }
}

function urlOf(output) {
  const match = /\bhttp:\/\/localhost:\d+\/?\b/u.exec(output);
  assert(match, `No loopback viewer URL: ${output}`);
  return new URL(match[0]);
}

async function get(url) {
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "localhost");
  assert.equal(url.username + url.password, "");
  return fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
}

async function view(url) {
  const response = await get(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const token = /name="ev-session" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  assert(token, "browser view supplies an isolated session value");
  const state = await api({ url, token }, { op: "state" });
  return { url, token, html, state };
}

async function api({ url, token }, body, status = 200) {
  assert.equal(url.hostname, "localhost");
  const response = await fetch(new URL("/api", url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url.origin, "X-Ev-Session": token },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, status);
  return response.json();
}

async function closed(url) {
  for (let i = 0; i < 20; i++) {
    try {
      const previous = await get(url);
      await previous.body?.cancel();
      if (!previous.ok) return;
    } catch (error) {
      if (
        error instanceof TypeError &&
        ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code)
      )
        return;
      throw error;
    }
    await pause(100);
  }
  assert.fail(`Old viewer is still live: ${url.origin}`);
}
