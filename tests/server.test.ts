import { afterEach, expect, it, vi } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from "node:fs/promises";
import os from "node:os";
import { request } from "node:http";
import path from "node:path";
import { startServer } from "../src/server/server";
import { randomBytes } from "node:crypto";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
type Snapshot = {
  root: { displayPath: string };
  selected: { id: string } | null;
  diffMode: boolean;
};
function tabClient(url: string, headers: Record<string, string>) {
  let context: { root: string; selected: string | null; diffMode: boolean } | undefined;
  return async (op: string, data: Record<string, unknown> = {}) => {
    const response = await fetch(url + "/api", {
      method: "POST",
      headers,
      body: JSON.stringify({ op, context, ...data }),
    });
    if (
      response.ok &&
      ["state", "home", "parent", "top", "openSearch", "openEntry", "refresh"].includes(op)
    ) {
      const result = (await response.clone().json()) as Snapshot;
      context = {
        root: result.root.displayPath,
        selected: result.selected?.id ?? null,
        diffMode: result.diffMode,
      };
    }
    return response;
  };
}
async function fixture(withTarget = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ev-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "web"));
  await mkdir(path.join(root, "web", "assets"));
  await writeFile(
    path.join(root, "web", "assets", "mermaid.tiny.js"),
    "/* synthetic renderer bundle */",
  );
  await writeFile(
    path.join(root, "web", "index.html"),
    '<meta name="ev-session" content="__EV_SESSION__">',
  );
  await mkdir(path.join(root, "files"));
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "files", "test.md"), "# Local");
  await writeFile(path.join(root, "other", "secret"), "secret");
  const opened: string[] = [];
  const revealed: string[] = [];
  const foldersOpened: string[] = [];
  const edited: string[] = [];
  const server = await startServer({
    target: withTarget ? path.join(root, "files") : undefined,
    home: root,
    webRoot: path.join(root, "web"),
    editor: async (target) => {
      edited.push(target);
    },
    directoryOpener: async (target) => {
      foldersOpened.push(target);
    },
    revealer: async (target) => {
      revealed.push(target);
    },
    opener: async (target) => {
      opened.push(target);
    },
  });
  cleanup.push(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const headers = { Origin: server.url, "X-EV-Session": token, "Content-Type": "application/json" };
  const newTab = () => tabClient(server.url, headers);
  return { root, server, headers, api: newTab(), newTab, opened, revealed, foldersOpened, edited };
}
it("writes theme only to the authenticated server home preference, independent of the active folder", async () => {
  const { root, server, headers, api, newTab } = await fixture();
  const settings = path.join(root, ".miru", "settings.json");
  expect(await (await api("preferences")).json()).toEqual({});
  expect((await api("set-theme", { theme: { light: true } })).status).toBe(400);
  for (const extra of [{ Origin: "https://untrusted.test" }, { "X-EV-Session": "wrong" }]) {
    const response = await fetch(server.url + "/api", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ op: "set-theme", theme: "dark" }),
    });
    expect(response.status).toBe(403);
    await response.text();
  }
  await expect(readFile(settings)).rejects.toMatchObject({ code: "ENOENT" });
  await api("state");
  expect(await (await api("set-theme", { theme: "dark", path: "elsewhere" })).json()).toEqual({
    theme: "dark",
  });
  expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ theme: "dark" });
  expect(await (await newTab()("preferences")).json()).toEqual({ theme: "dark" });
});
it("protects bootstrap and API from hostile Host/Origin, missing token, embedded/cross-site requests and paths in URL", async () => {
  const { server, headers } = await fixture();
  for (const extra of [
    { Origin: "https://attacker.test" },
    { Host: "attacker.test" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { headers: extra }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  }
  expect(
    (
      await fetch(server.url + "/api", {
        method: "POST",
        headers: { ...headers, "X-EV-Session": "wrong" },
        body: '{"op":"state"}',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(server.url + "/api", {
        method: "POST",
        headers: { ...headers, Origin: "null" },
        body: '{"op":"state"}',
      })
    ).status,
  ).toBe(403);
  expect((await fetch(server.url + "/api")).status).toBe(405);
  expect((await fetch(server.url + "/?path=/etc/passwd")).status).toBe(404);
  const root = await fetch(server.url);
  expect(root.headers.get("X-Frame-Options")).toBe("DENY");
  expect(root.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(root.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
it("starts with an ordinary HOME directory tree and issues IDs bound to the selected root", async () => {
  const { root, api } = await fixture(false);
  const initial = await (await api("state")).json();
  expect(initial).not.toHaveProperty("launcher");
  expect(initial.root.displayPath).toBe(root);
  expect(initial.selected).toBeNull();
  const list = await (await api("list", { id: initial.root.id })).json();
  const folder = list.entries.find((entry: { name: string }) => entry.name === "files");
  const opened = await (await api("openEntry", { id: folder.id })).json();
  expect(opened.root.displayPath).toBe(path.join(root, "files"));
  expect((await api("list", { id: initial.root.id })).status).toBe(400);
  const items = await (await api("list", { id: opened.root.id })).json();
  const file = items.entries[0];
  const selected = await (await api("openEntry", { id: file.id })).json();
  expect(selected.selected.name).toBe("test.md");
  expect(file.id).toBe(selected.selected.id); // same root, no process-local ID rotation
  expect((await api("read", { id: file.id })).status).toBe(200);
  const home = await (await api("home")).json();
  expect(home.root.displayPath).toBe(root);
  expect(home.selected).toBeNull();
  expect((await api("read", { id: selected.selected.id })).status).toBe(400);
});

it("excludes only Git-ignored entries on request, retaining changed or deleted rows and scoped IDs", async () => {
  const { root, api } = await fixture();
  const directory = path.join(root, "files");
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args]);
  // Ignore CI's unrelated global clean filters when constructing this fixture.
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  try {
    await writeFile(
      path.join(directory, ".gitignore"),
      "*.log\ngone/\nignored-contents/*\nignored-deep/**\nmixed/*\n!mixed/keep.txt\n",
    );
    for (const name of ["ignored-contents", "ignored-deep", "mixed"]) {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, "untracked.txt"), "ignored");
    }
    await writeFile(path.join(directory, "mixed", "keep.txt"), "explicitly unignored");
    await writeFile(path.join(directory, "ignored.log"), "ignored");
    let state = await (await api("state")).json();
    const list = async (id: string, excludeIgnored?: boolean) => {
      const response = await api("list", { id, excludeIgnored });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        entries: { id: string; name: string; changed: boolean; deleted: boolean }[];
        gitMessage?: string;
      };
    };
    expect((await list(state.root.id, true)).entries.map((e) => e.name)).toContain("ignored.log");

    git("init", "-q");
    await mkdir(path.join(directory, "gone"));
    await writeFile(path.join(directory, "gone", "tracked.log"), "before");
    git("add", "-f", "gone/tracked.log", "test.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base");
    git("rm", "-q", "gone/tracked.log");
    state = await (await api("refresh")).json();
    const all = await list(state.root.id);
    const visible = await list(state.root.id, true);
    expect(visible.gitMessage).toBeUndefined();
    expect(visible.entries).toEqual(
      all.entries.filter(
        (e) => !["ignored.log", "ignored-contents", "ignored-deep"].includes(e.name),
      ),
    );
    expect(visible.entries.map((e) => e.name)).toContain(".git");
    const gone = visible.entries.find((e) => e.name === "gone")!;
    expect(gone).toMatchObject({ changed: true, deleted: true });
    expect((await list(gone.id, true)).entries).toMatchObject([
      { name: "tracked.log", changed: true, deleted: true },
    ]);
    expect(await list(state.root.id, false)).toEqual(all);
    expect((await api("list", { id: state.root.id, excludeIgnored: "true" })).status).toBe(400);

    // A list made after a config change reports the live status failure; the
    // independent check-ignore operation still works without invoking a filter.
    git("config", "filter.unused.clean", "must-not-run");
    const blocked = await list(state.root.id, true);
    expect(blocked.gitMessage).toContain("外部Gitフィルター");
    expect(blocked.entries.map((e) => e.name)).not.toContain("ignored.log");
    expect(blocked.entries.map((e) => e.name)).not.toContain("ignored-contents");
    expect(blocked.entries.map((e) => e.name)).toContain("mixed");
  } finally {
    vi.unstubAllEnvs();
  }
});
it("revalidates HOME search results independently of refresh and refuses symlink escapes", async () => {
  const { root, api } = await fixture();
  await api("state");
  const found = await (await api("search", { query: "secret" })).json();
  await api("refresh");
  expect((await api("openSearch", { id: found.results[0].id })).status).toBe(200);
  // Explicit launch back to the files root, independently of search IDs.
  await api("state", { target: path.join(root, "files") });
  await symlink(path.join(root, "other"), path.join(root, "files", "escape"));
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const escape = list.entries.find((entry: { name: string }) => entry.name === "escape");
  expect((await api("openEntry", { id: escape.id })).status).toBe(400);
});
it("allows opaque signed IDs only in the root where they were issued", async () => {
  const { api } = await fixture();
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const id = list.entries[0].id;
  expect(id).not.toContain("/");
  expect((await (await api("read", { id })).json()).text).toBe("# Local");
  expect((await api("read", { id: "/etc/passwd" })).status).toBe(400);
  await api("parent");
  expect((await api("read", { id })).status).toBe(400);
});
it("blocks resource and symlink escapes, tolerates errors, and only opens explicit HTML", async () => {
  const { root, api, opened } = await fixture();
  await symlink(path.join(root, "other"), path.join(root, "files", "escape"));
  await writeFile(path.join(root, "files", "page.html"), "<h1>Page</h1>");
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const html = list.entries.find((entry: { name: string }) => entry.name === "page.html");
  const text = list.entries.find((entry: { name: string }) => entry.name === "test.md");
  expect((await api("resource", { id: html.id, reference: "escape/secret" })).status).toBe(400);
  expect((await api("external", { id: text.id })).status).toBe(400);
  expect(opened).toEqual([]);
  expect((await api("external", { id: html.id })).status).toBe(200);
  expect(opened).toEqual([path.join(root, "files", "page.html")]);
  expect((await api("read", { id: text.id })).status).toBe(200);
});

it("does not open a directory merely because its name has an HTML extension", async () => {
  const { root, api, opened } = await fixture();
  await mkdir(path.join(root, "files", "folder.html"));
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const folder = list.entries.find((entry: { name: string }) => entry.name === "folder.html");
  expect((await api("external", { id: folder.id })).status).toBe(400);
  expect(opened).toEqual([]);
});

it("rejects missing or incorrect API credentials before changing scope or invoking the opener", async () => {
  const { root, server, headers, api, opened } = await fixture();
  await writeFile(path.join(root, "files", "page.html"), "<h1>Public</h1>");
  const initial = await (await api("state")).json();
  const list = await (await api("list", { id: initial.root.id })).json();
  const html = list.entries.find((entry: { name: string }) => entry.name === "page.html");
  const withoutToken: Record<string, string> = { ...headers };
  delete withoutToken["X-EV-Session"];
  const withoutOrigin: Record<string, string> = { ...headers };
  delete withoutOrigin.Origin;
  const incorrectToken =
    (headers["X-EV-Session"][0] === "0" ? "1" : "0") + headers["X-EV-Session"].slice(1);
  for (const attempted of [
    withoutToken,
    withoutOrigin,
    { ...headers, "X-EV-Session": incorrectToken },
    { ...headers, "Content-Type": "text/plain" },
    { ...headers, Origin: `${server.url}.invalid` },
    { ...headers, "Sec-Fetch-Site": "cross-site" },
  ]) {
    for (const op of ["parent", "external", "reveal", "edit"]) {
      const response = await fetch(server.url + "/api", {
        method: "POST",
        headers: attempted,
        body: JSON.stringify({ op, id: html.id }),
      });
      expect(response.status).toBe(403);
      await response.text();
    }
  }
  expect(await (await api("state")).json()).toEqual(initial);
  expect(opened).toEqual([]);
});

it("rejects malformed and oversized API bodies without breaking subsequent authorized reads", async () => {
  const { server, headers, api } = await fixture();
  const initial = await (await api("state")).json();
  for (const body of [
    "{",
    "null",
    "[]",
    '"state"',
    JSON.stringify({ op: "state", extra: "x".repeat(16384) }),
  ]) {
    const response = await fetch(server.url + "/api", { method: "POST", headers, body });
    expect(response.status).toBe(400);
    await response.text();
  }
  expect(await (await api("state")).json()).toEqual(initial);
});

it("revalidates a listed file before read, resource or external opening after a symlink replacement", async () => {
  const { root, api, opened } = await fixture();
  const file = path.join(root, "files", "page.html");
  const secret = "private replacement content";
  await writeFile(file, "<h1>Initially public</h1>");
  await writeFile(path.join(root, "other", "page.html"), secret);
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const entry = list.entries.find((item: { name: string }) => item.name === "page.html");
  await rm(file);
  await symlink(path.join(root, "other", "page.html"), file);
  for (const op of ["read", "resource", "external", "reveal", "edit"]) {
    const response = await api(op, { id: entry.id, reference: "secret.css" });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
  }
  expect(opened).toEqual([]);
});

it("serves the isolated renderer without API credentials and without weakening the main page policy", async () => {
  const { server, headers } = await fixture();
  const response = await fetch(server.url + "/renderer/mermaid");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("synthetic renderer bundle");
  expect(html).not.toContain(headers["X-EV-Session"]);
  expect(html).not.toContain("ev-session");
  expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  const policy = response.headers.get("Content-Security-Policy")!;
  expect(policy).toContain(`frame-ancestors ${server.url}`);
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toMatch(/script-src 'nonce-[a-f0-9]{32}'/u);
  expect(policy).not.toContain("script-src 'self'");
  const main = await fetch(server.url);
  expect(main.headers.get("X-Frame-Options")).toBe("DENY");
  expect(main.headers.get("Content-Security-Policy")).not.toContain("'nonce-");
  for (const extra of [{ Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }] as Record<
    string,
    string
  >[]) {
    const blocked = await fetch(server.url + "/renderer/mermaid", { headers: extra });
    expect(blocked.status).toBe(403);
    await blocked.text();
  }
  const api = await fetch(server.url + "/api", {
    method: "POST",
    headers: { Origin: "null", "Content-Type": "application/json" },
    body: '{"op":"state"}',
  });
  expect(api.status).toBe(403);
  await api.text();
});

it("keeps navigation, search, selection and diff preference isolated between interleaved tabs", async () => {
  const { root, newTab } = await fixture(false);
  const a = newTab(),
    b = newTab();
  const [first, second] = await Promise.all([
    a("state", { target: path.join(root, "files", "test.md"), diffMode: true }).then((r) =>
      r.json(),
    ),
    b("state", { target: path.join(root, "other", "secret") }).then((r) => r.json()),
  ]);
  expect(first).toMatchObject({ selected: { name: "test.md" }, diffMode: true });
  expect(second).toMatchObject({ selected: { name: "secret" }, diffMode: false });
  const [wrongRoot, rightRoot, renewed] = await Promise.all([
    b("read", { id: first.selected.id }),
    a("read", { id: first.selected.id }),
    b("refresh"),
  ]);
  expect(wrongRoot.status).toBe(400);
  expect(await rightRoot.json()).toMatchObject({ text: "# Local" });
  expect(await renewed.json()).toEqual(second);
  await b("home");
  await b("search", { query: "test" });
  expect(await (await a("state")).json()).toEqual(first);
});

it("does not rebase a restored root through a replacement symlink and can recover via HOME or search", async () => {
  const { root, newTab } = await fixture(false);
  const a = newTab(),
    b = newTab();
  await Promise.all([
    a("state", { target: path.join(root, "files") }),
    b("state", { target: path.join(root, "files") }),
  ]);
  await rename(path.join(root, "files"), path.join(root, "moved"));
  await symlink(path.join(root, "other"), path.join(root, "files"));
  expect((await a("refresh")).status).toBe(400);
  expect((await (await a("home")).json()).root.displayPath).toBe(root);
  await rm(path.join(root, "files"));
  const matches = await (await b("search", { query: "secret" })).json();
  expect(matches.results).toHaveLength(1);
  const found = await (await b("openSearch", { id: matches.results[0].id })).json();
  expect(found.selected.name).toBe("secret");
});

it("reveals regular files and opens directories only within the current scope", async () => {
  const { root, api, opened, revealed, foldersOpened } = await fixture();
  const folder = path.join(root, "files");
  await mkdir(path.join(folder, "directory"));
  await symlink(path.join(root, "other"), path.join(folder, "escaped-folder"), "dir");
  await symlink(path.join(root, "other", "secret"), path.join(folder, "escape"));
  const state = await (await api("state")).json();
  const { entries } = await (await api("list", { id: state.root.id })).json();
  const id = (name: string) => entries.find((item: { name: string }) => item.name === name).id;
  expect((await api("reveal", { id: id("directory") })).status).toBe(400);
  expect((await api("reveal", { id: id("escape") })).status).toBe(400);
  expect(await (await api("reveal", { id: id("test.md") })).json()).toEqual({ ok: true });
  expect((await api("open-folder", { id: id("test.md") })).status).toBe(400);
  await rm(path.join(folder, "test.md"));
  expect((await api("reveal", { id: id("test.md") })).status).toBe(400);
  expect(await (await api("open-folder", { id: id("directory") })).json()).toEqual({ ok: true });
  expect(await (await api("open-folder", { id: state.root.id })).json()).toEqual({ ok: true });
  expect((await api("open-folder", { id: id("escape") })).status).toBe(400);
  expect((await api("open-folder", { id: id("escaped-folder") })).status).toBe(400);
  await rm(path.join(folder, "directory"), { recursive: true });
  expect((await api("open-folder", { id: id("directory") })).status).toBe(400);
  expect(foldersOpened).toEqual([path.join(folder, "directory"), folder]);
  expect(revealed).toEqual([path.join(folder, "test.md")]);
  expect(opened).toEqual([]);
  expect((await (await api("state")).json()).selected).toBeNull();
});

it("serves a public resident shell, exchanges a one-use launch grant and restores an old tab on the same port after restart", async () => {
  const { root } = await fixture(false);
  const secret = randomBytes(32).toString("hex"),
    grant = randomBytes(32).toString("hex");
  const target = path.join(root, "files", "test.md");
  const grants = new Map([[grant, { target, diff: true }]]);
  const options = {
    authToken: secret,
    home: root,
    webRoot: path.join(root, "web"),
    redeemGrant(value: string) {
      const result = grants.get(value);
      grants.delete(value);
      return result;
    },
  };
  let service = await startServer(options);
  cleanup.push(() => service.close());
  const url = service.url;
  expect(new URL(url).hostname).toBe("127.0.0.1");
  const headers = { Origin: url, "X-EV-Session": grant, "Content-Type": "application/json" };
  const post = (body: Record<string, unknown>, extra: Record<string, string> = {}) =>
    fetch(url + "/api", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  const shell = await (await fetch(url)).text();
  expect(shell).toContain('name="ev-session" content=""');
  for (const privateData of [grant, secret, target, root]) expect(shell).not.toContain(privateData);
  expect((await post({ op: "state" })).status).toBe(403);
  for (const extra of [
    { Origin: "null" },
    { Origin: url.replace("127.0.0.1", "localhost") },
    { "Sec-Fetch-Site": "cross-site" },
    { "Content-Type": "text/plain" },
  ] as Record<string, string>[])
    expect((await post({ op: "connect" }, extra)).status).toBe(403);
  const exchanges = await Promise.all([post({ op: "connect" }), post({ op: "connect" })]);
  expect(exchanges.map((r) => r.status).sort()).toEqual([200, 403]);
  const accepted = exchanges.find((r) => r.ok)!;
  expect(accepted.headers.get("Cache-Control")).toBe("no-store");
  const launch = await accepted.json();
  expect(launch).toMatchObject({
    target,
    diff: true,
    token: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(launch.token).not.toBe(secret);
  expect(shell).not.toContain(launch.token);
  const auth = { ...headers, "X-EV-Session": launch.token };
  expect((await post({ op: "state" }, { "X-EV-Session": secret })).status).toBe(403);
  const tab = tabClient(url, auth);
  const initial = await (
    await tab("state", { target: launch.target, diffMode: launch.diff })
  ).json();
  await service.close();
  service = await startServer({ ...options, port: Number(new URL(url).port) });
  expect(service.url).toBe(url);
  expect(await (await tab("state")).json()).toEqual(initial);
  expect((await (await tab("read", { id: initial.selected.id })).json()).text).toBe("# Local");
  expect((await post({ op: "connect" })).status).toBe(403);
});

it("hands the selected regular text to the editor only on edit, without modifying it or changing selection", async () => {
  const { root, api, opened, revealed, edited } = await fixture();
  const name = "someone's 日本語 % # ;.cmd";
  const file = path.join(root, "files", name);
  const original = "echo テスト\r\n";
  await writeFile(file, original);
  const before = await (await api("state")).json();
  const { entries } = await (await api("list", { id: before.root.id })).json();
  const id = entries.find((entry: { name: string }) => entry.name === name).id;
  expect(edited).toEqual([]);
  expect(
    await (
      await api("edit", { id, target: path.join(root, "other", "secret"), editor: "cmd.exe" })
    ).json(),
  ).toEqual({ ok: true });
  expect(edited).toEqual([file]);
  expect(opened).toEqual([]);
  expect(revealed).toEqual([]);
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await (await api("state")).json()).toEqual(before);
});

it("rejects editor calls for directory, missing, escaping, binary and oversized targets", async () => {
  const { root, api, edited } = await fixture();
  const top = path.join(root, "files");
  await mkdir(path.join(top, "directory"));
  await writeFile(path.join(top, "nul.bin"), Buffer.from([65, 0, 98]));
  await writeFile(path.join(top, "malformed.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(top, "control.txt"), Buffer.from([65, 27, 74]));
  await writeFile(path.join(top, "fake.pdf"), "%PDF-1.4 printable text");
  await writeFile(path.join(top, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  await writeFile(path.join(top, "moved"), "will be deleted");
  await symlink(path.join(root, "other", "secret"), path.join(top, "escape"));
  const state = await (await api("state")).json();
  const { entries } = await (await api("list", { id: state.root.id })).json();
  await rm(path.join(top, "moved"));
  for (const name of [
    "directory",
    "nul.bin",
    "malformed.txt",
    "control.txt",
    "fake.pdf",
    "big.txt",
    "moved",
    "escape",
  ]) {
    const result = await api("edit", {
      id: entries.find((entry: { name: string }) => entry.name === name).id,
    });
    expect(result.status, name).toBe(400);
    expect(await result.json(), name).toHaveProperty("error");
  }
  expect((await api("edit", { id: path.join(root, "other", "secret") })).status).toBe(400);
  expect(edited).toEqual([]);
});
