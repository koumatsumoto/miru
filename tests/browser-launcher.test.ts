import { expect, it, vi } from "vite-plus/test";
import { editFile, openBrowser, openDirectory, revealFile } from "../src/server/browser";
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

it("reveals a WSL file by sending its converted UNC path as data to the fixed Windows selection API", async () => {
  const file = "/home/user/日本語, a's #%; $.cmd";
  const win = "\\\\wsl.localhost\\Ubuntu\\home\\user\\日本語, a's #%; $.cmd";
  const run = vi.fn(async (cmd: string, _args: string[], _input?: string) =>
    cmd === "wslpath" ? win + "\r\n" : "",
  );
  await revealFile(file, { platform: "linux", release: "microsoft-standard-WSL2", run });
  expect(run.mock.calls[0]).toEqual(["wslpath", ["-w", file]]);
  const [exe, args, input] = run.mock.calls[1];
  expect(exe).toBe("powershell.exe");
  expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
  expect(Buffer.from(input!, "base64").toString("utf8")).toBe(win);
  const script = decode(args);
  expect(script).not.toContain(win);
  expect(script).toContain("SHOpenFolderAndSelectItems(item, 0, IntPtr.Zero, 0)");
  expect(script).toContain("CoInitializeEx(IntPtr.Zero, 2)");
  expect(script).toContain("finally { CoUninitialize(); }");
  expect(script).not.toMatch(/Invoke-Item|Start-Process|Invoke-Expression/i);
  expect(run).toHaveBeenCalledTimes(2);
});
it("passes native Windows file names through stdin, and never launches after a failed WSL conversion", async () => {
  const run = vi.fn(async (_cmd: string, _args: string[], _in?: string) => "relative\n");
  const filename = "C:\\資料\\file ' & (1).ps1";
  await revealFile(filename, { platform: "win32", release: "", run });
  expect(Buffer.from(run.mock.calls[0][2]!, "base64").toString("utf8")).toBe(filename);
  await expect(
    revealFile("/mnt/c/test", { platform: "linux", release: "generic", distro: "Ubuntu", run }),
  ).rejects.toThrow("変換");
  expect(run.mock.calls.slice(1)).toEqual([["wslpath", ["-w", "/mnt/c/test"]]]);
});
it("reveals via Finder or the Linux file-manager selection API, never a file association", async () => {
  const run = vi.fn(async (_cmd: string, _args: string[]) => "");
  const name = "/tmp/A, B/#question?.txt";
  await revealFile(name, { platform: "darwin", release: "", run });
  expect(run.mock.calls[0]).toEqual(["open", ["-R", name]]);
  await revealFile(name, { platform: "linux", release: "generic", run });
  expect(run.mock.calls[1][0]).toBe("gdbus");
  expect(run.mock.calls[1][1]).toContain("org.freedesktop.FileManager1.ShowItems");
  expect(JSON.parse(run.mock.calls[1][1].at(-2)!)).toEqual([
    "file:///tmp/A,%20B/%23question%3F.txt",
  ]);
});

it("passes a WSL filename to system Notepad as stdin data, not source, arguments or an association", async () => {
  const file = "/home/user/日本語, a's #%; & $(touch no).cmd";
  const win = "\\\\wsl.localhost\\Ubuntu\\home\\user\\日本語, a's #%; & $(touch no).cmd";
  const run = vi.fn(async (command: string, _args: string[], _input?: string) =>
    command === "wslpath" ? win + "\r\n" : "",
  );
  await editFile(file, { platform: "linux", release: "microsoft-standard-WSL2", run });
  expect(run.mock.calls[0]).toEqual(["wslpath", ["-w", file]]);
  const [command, args, input] = run.mock.calls[1];
  expect(command).toBe("powershell.exe");
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(Buffer.from(input!, "base64").toString("utf8")).toBe(win);
  const source = decode(args);
  expect(source).toContain("[Environment]::SystemDirectory");
  expect(source).toContain("[IO.Path]::Combine($system, 'notepad.exe')");
  expect(source).toContain("$start.UseShellExecute = $false");
  expect(source).toContain(`$start.Arguments = '"' + $name + '"'`);
  expect(source).not.toContain(win);
  expect(source).not.toMatch(/Invoke-Item|Invoke-Expression|cmd\.exe/iu);
  expect(run).toHaveBeenCalledTimes(2);
});

it("chooses the same explicit editor for Windows drive paths", async () => {
  const file = "D:\\データ\\a's file #%.txt";
  const run = vi.fn(async (_command: string, _args: string[], _input?: string) => "");
  await editFile(file, { platform: "win32", release: "generic", run });
  expect(run).toHaveBeenCalledOnce();
  const [command, args, input] = run.mock.calls[0];
  expect(command).toBe("powershell.exe");
  expect(decode(args)).toContain("'notepad.exe'");
  expect(Buffer.from(input!, "base64").toString("utf8")).toBe(file);
});

it("does not reinterpret non-representable WSL names as Windows paths, switches or devices", async () => {
  const run = vi.fn(async (_command: string, _args: string[], _input?: string) => "");
  const env = { platform: "linux", release: "microsoft", run } as const;
  for (const file of [
    "/home/me/look\\like.txt",
    '/home/me/a"b.txt',
    "/home/me/file.txt:stream",
    "/home/me/file. ",
    "/home/me/NUL.txt",
    "/home/me/f\nile",
    "relative/filename.txt",
  ]) {
    await expect(editFile(file, env)).rejects.toThrow("Windowsで扱えない");
  }
  expect(run).not.toHaveBeenCalled();
  for (const invalid of [
    "C:\\work\\a.txt:stream",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\work\\file.txt",
    "C:\\work\\..\\secret.txt",
  ]) {
    run.mockResolvedValueOnce(invalid + "\n");
    await expect(editFile("/mnt/c/work/file.txt", env)).rejects.toThrow("Windowsで扱えない");
  }
  expect(run.mock.calls.every(([cmd]) => cmd === "wslpath")).toBe(true);
});

it("uses the system TextEdit app for macOS text, and offers no native Linux file association fallback", async () => {
  const run = vi.fn(async (_command: string, _args: string[], _input?: string) => "");
  const file = "/tmp/A, B/#question?.txt";
  await editFile(file, { platform: "darwin", release: "", run });
  expect(run).toHaveBeenCalledExactlyOnceWith("/usr/bin/open", [
    "-a",
    "/System/Applications/TextEdit.app",
    file,
  ]);
  await expect(
    editFile("/tmp/page.html", { platform: "darwin", release: "", run }),
  ).rejects.toThrow("HTML");
  await expect(editFile(file, { platform: "linux", release: "", run })).rejects.toThrow(
    "対応していません",
  );
  expect(run).toHaveBeenCalledOnce();
});

it("opens a WSL folder in Explorer with its UNC path passed only as data", async () => {
  const target = "/home/user/資料, a's & (1)";
  const win = "\\\\wsl.localhost\\Ubuntu\\home\\user\\資料, a's & (1)";
  const run = vi.fn(async (cmd: string, _args: string[], _input?: string) =>
    cmd === "wslpath" ? win + "\r\n" : "",
  );
  await openDirectory(target, { platform: "linux", release: "microsoft-standard-WSL2", run });
  expect(run.mock.calls[0]).toEqual(["wslpath", ["-w", target]]);
  const [exe, args, input] = run.mock.calls[1];
  expect(exe).toBe("powershell.exe");
  expect(Buffer.from(input!, "base64").toString("utf8")).toBe(win);
  expect(decode(args)).toContain("$shell.Explore($name)");
  expect(decode(args)).not.toContain(win);
});

it("opens directories through the Linux file manager and safely reveals Finder bundles", async () => {
  const run = vi.fn(async (_cmd: string, _args: string[]) => "");
  const target = "/tmp/Folder #.app";
  await openDirectory(target, { platform: "linux", release: "generic", run });
  expect(run.mock.calls[0][1]).toContain("org.freedesktop.FileManager1.ShowFolders");
  expect(JSON.parse(run.mock.calls[0][1].at(-2)!)).toEqual(["file:///tmp/Folder%20%23.app"]);
  await openDirectory(target, { platform: "darwin", release: "", run });
  expect(run.mock.calls[1]).toEqual(["open", ["-R", target]]);
});
