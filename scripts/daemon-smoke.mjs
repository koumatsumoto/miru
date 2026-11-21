import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  const launchLog = path.join(root, "browser-shim");
  const blocker = createServer((_request, response) => response.end("unrelated test service"));
  await listen(blocker, 0);
  const port = blocker.address().port;
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    MIRU_RUNTIME_DIR: runtime,
    MIRU_PORT: String(port),
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
    MIRU_SMOKE_BOUND: path.join(root, "candidate-could-bind"),
    MIRU_SMOKE_REMOTE: path.join(root, "remote.git"),
    GIT_SSH_COMMAND: path.join(toolBin, "fixture-ssh"),
    GIT_SSH_VARIANT: "ssh",
    PATH: [toolBin, process.env.PATH ?? ""].join(path.delimiter),
  };
  let canStop = false;
  let legacyStartup;
  let publisher;
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
        '#!/bin/sh\nprintf "shim ran\\n" > "$MIRU_SMOKE_LAUNCH_LOG"\ntest "$MIRU_SMOKE_BROWSER_SUCCESS" = "1"\n',
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
} else if (process.env.MIRU_SMOKE_BUILD === "bad-bind") {
  await writeFile(path.join(out, "cli.mjs"), ${JSON.stringify(failedBindFixture())});
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

    // A known busy fixed port fails explicitly. It cannot silently allocate
    // another one or disturb the unrelated listener.
    await assert.rejects(command(["server"]), (error) => /固定ポート.*使用中/u.test(error.stderr));
    assert.equal(
      await (await get(new URL(`http://127.0.0.1:${port}/`))).text(),
      "unrelated test service",
    );
    await closeServer(blocker);
    await assert.rejects(command(["server"], { MIRU_PORT: "0" }), (error) =>
      /1024〜65535/u.test(error.stderr),
    );

    // If the daemon inherits the CLI's output pipe, command() cannot finish.
    await assert.rejects(command([path.join(home, "does-not-exist.txt")]), (error) =>
      /指定されたファイル・フォルダ/u.test(error.stderr),
    );
    assert.match(await command(["status"]), /stopped/);
    const a = await view(urlOf(await command([firstFile])));
    const readyA = await resident("status");
    assert.equal(readyA.port, port);
    assert.equal(a.state.root.displayPath, first);
    assert.equal(a.state.selected?.name, "first.txt");
    assert.equal(
      (await api(a, { op: "read", id: a.state.selected.id })).text,
      "first scope text\n",
    );

    const b = await view(urlOf(await command([secondFile])));
    const readyB = await resident("server");
    assert.deepEqual(readyB, readyA, "the same daemon and port serve all launches");
    assert.equal(a.url.origin, b.url.origin);
    assert.notEqual(a.grant, b.grant, "launch grants are one-use and independent");
    assert.equal(a.token, b.token, "main browser session survives process changes");
    assert.equal(b.state.root.displayPath, second);
    assert.equal(
      (await api(b, { op: "read", id: b.state.selected.id })).text,
      "other scope text\n",
    );
    assert.equal((await api(a, { op: "state" })).root.displayPath, first);
    await api(b, { op: "read", id: a.state.selected.id }, 400);
    await request(a.url, a.grant, { op: "connect" }, 403);
    await request(a.url, "f".repeat(64), { op: "state" }, 403);
    assert(
      !a.html.includes(a.token) && !a.html.includes(firstFile),
      "public HTML contains no credentials or paths",
    );
    assert.equal((await stat(path.join(runtime, "browser.key"))).mode & 0o777, 0o600);
    assert(
      !a.url.toString().includes(a.token),
      "CLI launch does not reveal the resident credential",
    );

    // A simulated successful system opener must not echo a launch fragment to stdout.
    await assert.rejects(readFile(launchLog, "utf8"), { code: "ENOENT" });
    const auto = await command([firstFile], {
      MIRU_NO_OPEN: "0",
      EV_NO_OPEN: "0",
      MIRU_SMOKE_BROWSER_SUCCESS: "1",
    });
    assert(!auto.includes("#") && !auto.includes(a.token));
    await readFile(launchLog, "utf8");
    console.log(
      "PASS: busy port refusal, one fixed origin, scoped requests, one-use grants, no credential in launcher output or HTML.",
    );

    for (const mode of ["fail", "bad", "bad-bind"]) {
      await assert.rejects(
        command(["update", "--local"], { MIRU_SMOKE_BUILD: mode }),
        (error) => Number.isInteger(error.code) && !error.killed,
        "update should reject a failed build or failed candidate, not hang",
      );
      assert.equal(await readFile(env.MIRU_SMOKE_INVOKED, "utf8"), mode);
      assert.deepEqual(await resident("status"), readyA);
      assert.equal((await api(a, { op: "state" })).root.displayPath, first);
      assert.equal((await api(b, { op: "state" })).root.displayPath, second);
      assert.equal(await readFile(path.join(dist, "web/index.html"), "utf8"), originalIndex);
    }
    assert.equal(await readFile(env.MIRU_SMOKE_BOUND, "utf8"), "old listener paused");
    console.log(
      "PASS: failed build, failed boot, and failed bind after pause all retain the old listener and browser contexts.",
    );

    // Keep the active origin even if the terminal did not export the override
    // that was present on the first invocation.
    await command(["update", "--local"], { MIRU_SMOKE_BUILD: "success", MIRU_PORT: undefined });
    assert.equal(await readFile(env.MIRU_SMOKE_INVOKED, "utf8"), "success");
    const updated = await resident("status");
    assert.notEqual(updated.pid, readyA.pid);
    assert.equal(updated.port, readyA.port);
    assert(
      (await (await get(a.url)).text()).includes(updatedMarker),
      "the same URL serves the updated UI",
    );
    assert.equal((await api(a, { op: "state" })).selected.id, a.state.selected.id);
    assert.equal(
      (await api(b, { op: "read", id: b.state.selected.id })).text,
      "other scope text\n",
    );

    await command(["stop"]);
    await closed(a.url);
    await assert.rejects(stat(path.join(runtime, "browser.key")), { code: "ENOENT" });
    const reopened = await Promise.all(
      [command(["first.txt"]), command([secondFile])].map(async (output) =>
        view(urlOf(await output)),
      ),
    );
    assert(
      reopened.every(({ html }) => html.includes(updatedMarker)),
      "a cold start keeps the active build",
    );
    assert(reopened.every(({ url }) => url.origin === a.url.origin));
    assert.notEqual(reopened[0].token, a.token, "explicit stop revoked the old browser credential");
    await request(a.url, a.token, { op: "state" }, 403);
    assert.deepEqual(
      reopened.map(({ state }) => state.root.displayPath),
      [first, second],
    );

    // A marker that cannot be replaced must not release the original listener.
    const marker = path.join(checkout, ".cache/miru-builds/active.json");
    await rename(marker, marker + ".saved");
    await mkdir(marker);
    try {
      const before = await resident("status");
      await assert.rejects(command(["update", "--local"], { MIRU_SMOKE_BUILD: "marker-failure" }));
      assert.deepEqual(await resident("status"), before);
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
      checkContinuity: async () => {
        const [left, right] = await Promise.all(reopened.map((item) => api(item, { op: "state" })));
        assert.equal(left.root.displayPath, first);
        assert.equal(right.root.displayPath, second);
      },
      resident,
      openView: async () => view(urlOf(await command([firstFile]))),
    });
    await command(["stop"]);
    await closed(a.url);

    // #17–#19 launch the new candidate with just socketPath and probe the
    // unchanged private status format. It must already be bound at that point.
    const socket = "d-00000000000000de.sock";
    await writeFile(path.join(runtime, "active"), socket + "\n", { flag: "wx", mode: 0o600 });
    legacyStartup = spawn(
      process.execPath,
      [cli, "--internal-server", path.join(runtime, socket)],
      {
        cwd: runtime,
        env,
        stdio: "ignore",
      },
    );
    const legacyReady = await waitFor(async () => resident("status"));
    assert.equal(legacyReady.pid, legacyStartup.pid);
    assert.equal(legacyReady.port, port);
    assert.equal((await get(a.url)).status, 200);
    await command(["stop"]);
    await closed(a.url);

    // A candidate that can bind but whose launching CLI disappears before
    // publishing must not strand the port. No sleeps longer than its polling interval.
    const orphanSocket = path.join(runtime, "d-00000000000000ef.sock");
    publisher = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [process.argv[1], "--internal-server",
        process.argv[2], "--prepare", String(process.pid)], { detached:true, stdio:"ignore" });
      child.unref();
      setInterval(() => {}, 1000);
    `,
        cli,
        orphanSocket,
      ],
      { cwd: runtime, env, stdio: "ignore" },
    );
    const prepared = await waitFor(() => privateCall(orphanSocket, "status"));
    assert.equal(prepared.listening, false);
    assert.equal((await privateCall(orphanSocket, "listen")).listening, true);
    assert.equal((await get(a.url)).status, 200);
    const ended = once(publisher, "exit");
    publisher.kill();
    await ended;
    await closed(a.url);
    await waitFor(async () => assert.rejects(stat(orphanSocket), { code: "ENOENT" }));
    assert.equal(
      (await resident("server")).port,
      port,
      "unpublished candidate resolved its lease and released the port",
    );
    await command(["stop"]);
    await closed(a.url);
    canStop = false;
    console.log(
      "PASS: real restart keeps the URL, token and tab contexts; explicit stop revokes token; legacy candidate starts already bound.",
    );
  } catch (error) {
    failure = error;
  } finally {
    if (blocker.listening) await closeServer(blocker);
    try {
      if (canStop) await command(["stop"]);
    } catch (error) {
      if (failure) console.error("Isolated daemon cleanup also failed:", error.code);
      failure ??= error;
    }
    for (const child of [publisher, legacyStartup]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
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
    const match = /\bpid=(\d+)\s+port=(\d+)\s*$/u.exec(stdout);
    assert(match, `No fixed resident status from ${commandName}: ${stdout}`);
    return { pid: Number(match[1]), port: Number(match[2]) };
  }
}

function urlOf(output) {
  const match = /\bhttp:\/\/127\.0\.0\.1:\d+\/#grant=[0-9a-f]{64}(?=\s|$)/u.exec(output);
  assert(match, "MIRU did not return a manual fixed-origin launch link");
  return new URL(match[0]);
}

async function get(url) {
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username + url.password, "");
  return fetch(url.origin + url.pathname, { redirect: "error", signal: AbortSignal.timeout(3000) });
}

async function view(url) {
  const response = await get(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const grant = new URLSearchParams(url.hash.slice(1)).get("grant");
  const { token, target, diff } = await request(url, grant, { op: "connect" });
  assert.match(token, /^[a-f0-9]{64}$/u);
  const state = await request(url, token, { op: "state", target, diffMode: diff });
  return {
    url,
    grant,
    token,
    html,
    state,
    context: {
      root: state.root.displayPath,
      selected: state.selected?.id ?? null,
      diffMode: diff,
    },
  };
}

async function request(url, token, body, status = 200) {
  assert.equal(url.hostname, "127.0.0.1");
  const response = await fetch(new URL("/api", url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url.origin, "X-Ev-Session": token },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, status);
  return status === 403 ? response.text() : response.json();
}

function api({ url, token, context }, body, status = 200) {
  return request(url, token, { ...body, context }, status);
}

async function listen(server, port) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server) {
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closed;
}

async function waitFor(task) {
  for (let i = 0; i < 50; i++) {
    try {
      return await task();
    } catch (error) {
      if (i === 49) throw error;
    }
    await pause(50);
  }
}

function privateCall(socketPath, action) {
  const body = JSON.stringify({ action });
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: "POST",
        path: "/control",
        agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(3000),
      },
      async (response) => {
        try {
          let json = "";
          for await (const chunk of response) json += chunk;
          assert.equal(response.statusCode, 200);
          resolve(JSON.parse(json));
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function failedBindFixture() {
  // Represents a control-ready candidate whose HTTP activation throws. Verify
  // the old process released its port before replying with the failure.
  return `import { createServer, request as httpRequest } from "node:http";
import { chmod, writeFile } from "node:fs/promises";
import { once } from "node:events";
const port = Number(process.env.MIRU_PORT);
const socket = process.argv[3];
const control = createServer(async (request, response) => {
  let input = "";
  for await (const chunk of request) input += chunk;
  const { action } = JSON.parse(input);
  if (action === "listen") {
    const probe = createServer();
    probe.listen(port, "127.0.0.1");
    await once(probe, "listening");
    await new Promise((resolve) => probe.close(resolve));
    await writeFile(process.env.MIRU_SMOKE_BOUND, "old listener paused");
    response.writeHead(503, { Connection: "close" });
    response.end(JSON.stringify({ ok: false, error: "固定ポート test bind failure" }));
    return;
  }
  response.writeHead(200, { Connection: "close" });
  response.end(JSON.stringify({ ok: true, pid: process.pid, views: 0, port, listening: false }));
  if (action === "stop") control.close();
});
control.listen(socket, () => void chmod(socket, 0o600));
`;
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
