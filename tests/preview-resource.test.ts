import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localResource } from "../src/server/preview";
import { UserError, Workspace } from "../src/server/workspace";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "miru-resource-"));
  dirs.push(root);
  const visible = path.join(root, "visible");
  const outside = path.join(root, "visible-neighbor");
  await mkdir(visible);
  await mkdir(outside);
  await writeFile(path.join(visible, "page.html"), "<h1>Local</h1>");
  await writeFile(path.join(outside, "secret.css"), "/* private outside scope */");
  const workspace = new Workspace(root);
  await workspace.open(visible);
  return { visible, outside, workspace, id: workspace.id(path.join(visible, "page.html")) };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("rejects decoded traversal, remote schemes, controls and malformed references", async () => {
  const { workspace, id } = await fixture();
  for (const reference of [
    "../visible-neighbor/secret.css",
    "%2e%2e/visible-neighbor/secret.css",
    "..%2Fvisible-neighbor%2Fsecret.css",
    "%2e%2e%2fvisible-neighbor/secret.css?version=1#theme",
    "HTTPS://example.invalid/style.css",
    "//example.invalid/style.css",
    "file:///tmp/style.css",
    "javascript:alert(1)",
    "data:text/css,body{}",
    "https%3A%2F%2Fexample.invalid/style.css",
    "%2Ftmp/style.css",
    "C%3A%5Cstyle.css",
    "%5C%5Cserver%5Cshare%5Cstyle.css",
    "style\0.css",
    "style%00.css",
    "style\n.css",
    "style%0a.css",
    "%",
    "%GG.css",
    "%E0%A4%A.css",
    "#fragment",
    "x".repeat(4097),
    null,
    42,
  ])
    await expect(localResource(workspace, id, reference)).rejects.toBeInstanceOf(UserError);
});

it("allows URL-encoded literal names, local parent references and in-scope resource symlinks", async () => {
  const { visible, workspace, id } = await fixture();
  const name = "日本語 #?%.css";
  const css = "body { color: red; }";
  await writeFile(path.join(visible, name), css);
  expect(
    await localResource(workspace, id, `${encodeURIComponent(name)}?version=1#theme`),
  ).toMatchObject({ mime: "text/css", text: css });
  await mkdir(path.join(visible, "nested"));
  await writeFile(path.join(visible, "nested", "page.md"), "# Nested");
  const nestedId = workspace.id(path.join(visible, "nested", "page.md"));
  expect((await localResource(workspace, nestedId, `../${encodeURIComponent(name)}`)).text).toBe(
    css,
  );
  await symlink(path.join(visible, name), path.join(visible, "linked.css"));
  expect((await localResource(workspace, id, "linked.css")).text).toBe(css);
});

it("decodes only once so double-encoded dot segments remain literal filenames", async () => {
  const { visible, workspace, id } = await fixture();
  await mkdir(path.join(visible, "%2e%2e"));
  await writeFile(path.join(visible, "%2e%2e", "literal.css"), "/* literal directory */");
  expect((await localResource(workspace, id, "%252e%252e/literal.css")).text).toBe(
    "/* literal directory */",
  );
});

it("revalidates resource and base paths after a directory is replaced by an escaping symlink", async () => {
  const { visible, outside, workspace, id } = await fixture();
  const assets = path.join(visible, "assets");
  await mkdir(assets);
  await writeFile(path.join(assets, "secret.css"), "/* initially public */");
  await writeFile(path.join(assets, "page.html"), "<h1>Initial</h1>");
  await writeFile(path.join(outside, "page.html"), "<h1>Private</h1>");
  const nestedId = workspace.id(path.join(assets, "page.html"));
  expect((await localResource(workspace, id, "assets/secret.css")).text).toContain("public");
  await rename(assets, path.join(visible, "old-assets"));
  await symlink(outside, assets);
  await expect(localResource(workspace, id, "assets/secret.css")).rejects.toBeInstanceOf(UserError);
  await expect(localResource(workspace, nestedId, "secret.css")).rejects.toBeInstanceOf(UserError);
});
