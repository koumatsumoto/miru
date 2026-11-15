import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { request } from "node:http";
import path from "node:path";
import { startServer } from "../src/server/server";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture(withTarget = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ev-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "web"));
  await mkdir(path.join(root, "web", "assets"));
  await writeFile(
    path.join(root, "web", "index.html"),
    '<meta name="ev-session" content="__EV_SESSION__">',
  );
  await mkdir(path.join(root, "files"));
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "files", "test.md"), "# Local");
  await writeFile(path.join(root, "other", "secret"), "secret");
  const opened: string[] = [];
  const server = await startServer({
    target: withTarget ? path.join(root, "files") : undefined,
    home: root,
    webRoot: path.join(root, "web"),
    opener: async (target) => {
      opened.push(target);
    },
  });
  cleanup.push(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const headers = { Origin: server.url, "X-EV-Session": token, "Content-Type": "application/json" };
  const api = async (op: string, data: Record<string, unknown> = {}) =>
    fetch(server.url + "/api", { method: "POST", headers, body: JSON.stringify({ op, ...data }) });
  return { root, server, headers, api, opened };
}
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
it("starts at the HOME launcher and changes scope only through explicit entry/home actions", async () => {
  const { root, api } = await fixture(false);
  const initial = await (await api("state")).json();
  expect(initial.launcher).toBe(true);
  expect(initial.root.displayPath).toBe(root);
  expect(initial.selected).toBeNull();
  const list = await (await api("list", { id: initial.root.id })).json();
  const folder = list.entries.find((entry: { name: string }) => entry.name === "files");
  const opened = await (await api("openEntry", { id: folder.id })).json();
  expect(opened.launcher).toBe(false);
  expect(opened.root.displayPath).toBe(path.join(root, "files"));
  expect((await api("list", { id: initial.root.id })).status).toBe(400);
  const items = await (await api("list", { id: opened.root.id })).json();
  const file = items.entries[0];
  const selected = await (await api("openEntry", { id: file.id })).json();
  expect(selected.selected.name).toBe("test.md");
  expect((await api("read", { id: file.id })).status).toBe(400);
  const home = await (await api("home")).json();
  expect(home.launcher).toBe(true);
  expect(home.root.displayPath).toBe(root);
  expect(home.selected).toBeNull();
  expect((await api("read", { id: selected.selected.id })).status).toBe(400);
});
it("does not retain search capabilities across refresh or permit entry via an escaping symlink", async () => {
  const { root, api } = await fixture();
  const found = await (await api("search", { query: "secret" })).json();
  await api("refresh");
  expect((await api("openSearch", { id: found.results[0].id })).status).toBe(400);
  await symlink(path.join(root, "other"), path.join(root, "files", "escape"));
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const escape = list.entries.find((entry: { name: string }) => entry.name === "escape");
  expect((await api("openEntry", { id: escape.id })).status).toBe(400);
});
it("allows opaque-ID reads only and invalidates IDs when navigating/refreshing", async () => {
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
    for (const op of ["parent", "external"]) {
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
  for (const op of ["read", "resource", "external"]) {
    const response = await api(op, { id: entry.id, reference: "secret.css" });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
  }
  expect(opened).toEqual([]);
});
