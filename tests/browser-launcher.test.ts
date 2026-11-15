import { expect, it, vi } from "vite-plus/test";
import { openBrowser } from "../src/server/browser";
const decode = (args: string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le");
it("constructs a quoted Windows file URL for Unicode, apostrophes and URL metacharacters", async () => {
  const run = vi.fn(async () => "");
  await openBrowser("C:\\Users\\共有\\report's #1%.html", true, {
    platform: "win32",
    release: "",
    run,
  });
  expect(run).toHaveBeenCalledOnce();
  const [command, args] = run.mock.calls[0] as unknown as [string, string[]];
  expect(command).toBe("powershell.exe");
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(decode(args)).toBe(
    "Start-Process -FilePath 'file:///C:/Users/%E5%85%B1%E6%9C%89/report''s%20%231%25.html'",
  );
});
it("converts WSL Linux paths as one argument and preserves spaces at the end of a filename", async () => {
  const run = vi.fn(async (command: string, _args: string[]) =>
    command === "wslpath" ? "C:\\reports\\name .html \n" : "",
  );
  const file = "/mnt/c/reports/name .html ";
  await openBrowser(file, true, { platform: "linux", release: "microsoft-standard-WSL2", run });
  expect(run.mock.calls[0]).toEqual(["wslpath", ["-w", file]]);
  expect(run.mock.calls[1][0]).toBe("powershell.exe");
  expect(decode(run.mock.calls[1][1])).toBe(
    "Start-Process -FilePath 'file:///C:/reports/name%20.html%20'",
  );
});
it("handles WSL UNC paths and the distro environment fallback without exposing paths to a shell", async () => {
  const run = vi.fn(async (command: string, _args: string[]) =>
    command === "wslpath" ? "\\\\wsl.localhost\\Ubuntu\\home\\user\\日本語 #%.html\r\n" : "",
  );
  await openBrowser("/home/user/日本語 #%.html", true, {
    platform: "linux",
    release: "generic",
    distro: "Ubuntu",
    run,
  });
  expect(decode(run.mock.calls[1][1])).toBe(
    "Start-Process -FilePath 'file://wsl.localhost/Ubuntu/home/user/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%25.html'",
  );
});
for (const output of ["", "relative.html\n", "C:\\bad\0name.html\n"])
  it("never launches a browser after invalid WSL path conversion", async () => {
    const run = vi.fn(async (_command: string, _args: string[]) => output);
    await expect(
      openBrowser("/tmp/page.html", true, { platform: "linux", release: "microsoft", run }),
    ).rejects.toThrow("変換できません");
    expect(run).toHaveBeenCalledOnce();
  });
it("does not fall back to another launcher when wslpath fails", async () => {
  const run = vi.fn(async (_command: string, _args: string[]) => {
    throw new Error("conversion failed");
  });
  await expect(
    openBrowser("/tmp/page.html", true, { platform: "linux", release: "microsoft", run }),
  ).rejects.toThrow("conversion failed");
  expect(run).toHaveBeenCalledOnce();
});
for (const [platform, command] of [
  ["linux", "xdg-open"],
  ["darwin", "open"],
] as const)
  it(`passes a localhost URL to ${command} without shell interpolation`, async () => {
    const run = vi.fn(async (_command: string, _args: string[]) => "");
    await openBrowser("http://localhost:12345", false, { platform, release: "generic", run });
    expect(run).toHaveBeenCalledExactlyOnceWith(command, ["http://localhost:12345"]);
  });
