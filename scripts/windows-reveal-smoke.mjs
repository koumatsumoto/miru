// Native Windows only. Node 24 can load this dependency-free TypeScript module
// directly. Exercise the production path conversion/COM code with a real file;
// replace only the final invocation that would actually display an Explorer UI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { revealFile } from "../src/server/browser.ts";

assert.equal(process.platform, "win32", "Run this smoke test on Windows.");
const directory = await mkdtemp(path.join(os.tmpdir(), "miru-shell-"));
try {
  const file = path.join(directory, "資料, someone’s file's #1 & (copy).txt");
  await writeFile(file, "selection fixture");
  await revealFile(file, {
    platform: "win32",
    release: os.release(),
    async run(exe, args, input) {
      assert.equal(exe, "powershell.exe");
      assert.equal(Buffer.from(input, "base64").toString("utf8"), file);
      const program = Buffer.from(args.at(-1), "base64").toString("utf16le");
      const show = "[Miru.Selection]::Reveal($name)";
      assert.ok(program.endsWith(show));
      const probe = `
$flags = [Reflection.BindingFlags]'Static, NonPublic'
[Runtime.InteropServices.Marshal]::Prelink([Miru.Selection].GetMethod('SHOpenFolderAndSelectItems', $flags))
[Miru.Selection]::WithItem($name, [Action[IntPtr]]{ param($item)
    if ($item -eq [IntPtr]::Zero) { throw 'No shell item' }
    [Console]::WriteLine('MIRU-SHELL-OK')
})`;
      const check = Buffer.from(program.slice(0, -show.length) + probe, "utf16le").toString(
        "base64",
      );
      const output = execFileSync(exe, [...args.slice(0, -1), check], {
        input,
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      });
      assert.match(output, /MIRU-SHELL-OK/u);
      return output;
    },
  });
  console.log(
    "PASS: native selection API linked and Unicode file resolved, without opening a window.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
