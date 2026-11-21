import { execFile } from "node:child_process";
import { release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: 6000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                "外部ブラウザを起動できません。表示されたlocalhost URLを開くか、OSの起動設定を確認してください。",
              ),
            )
          : resolve(stdout),
    );
    if (input !== undefined) {
      child.stdin?.on("error", reject);
      child.stdin?.end(input);
    }
  });
}
// Injectable only for deterministic command-construction tests. No launcher is run
// by those tests, and the HTTP API cannot supply or change this environment.
interface BrowserEnvironment {
  platform: NodeJS.Platform;
  release: string;
  distro?: string;
  run: (command: string, args: string[], input?: string) => Promise<string>;
}
const systemEnvironment = (): BrowserEnvironment => ({
  platform: process.platform,
  release: release(),
  distro: process.env.WSL_DISTRO_NAME,
  run,
});
const isWsl = (env: BrowserEnvironment) =>
  env.platform === "linux" && (/microsoft/iu.test(env.release) || Boolean(env.distro));
async function windowsPathForWsl(target: string, env: BrowserEnvironment): Promise<string> {
  // Remove the command's final line ending, not whitespace belonging to a name.
  const result = (await env.run("wslpath", ["-w", target])).replace(/\r?\n$/u, "");
  if (!path.win32.isAbsolute(result) || result.includes("\0"))
    throw new Error("WSLのファイルパスをWindows形式に変換できませんでした。");
  return result;
}
export async function openBrowser(
  target: string,
  isFile = false,
  environment: BrowserEnvironment = systemEnvironment(),
): Promise<void> {
  const wsl = isWsl(environment);
  let url = target;
  if (isFile) {
    if (wsl) {
      url = pathToFileURL(await windowsPathForWsl(target, environment), { windows: true }).href;
    } else url = pathToFileURL(target, { windows: environment.platform === "win32" }).href;
  }
  if (environment.platform === "win32" || wsl) {
    const command = `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
    await environment.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ]);
  } else if (environment.platform === "darwin") await environment.run("open", [url]);
  else await environment.run("xdg-open", [url]);
}

// Explorer's /select,<path> has its own comma/quote parser and unreliable
// success exit codes, especially through WSL interop. Call Windows' native
// selection API instead. No target reaches PowerShell source or its arguments.
const windowsSelection = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Miru -Name Selection -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("ole32.dll", ExactSpelling=true)]
private static extern int CoInitializeEx(IntPtr reserved, uint flags);
[System.Runtime.InteropServices.DllImport("ole32.dll", ExactSpelling=true)]
private static extern void CoUninitialize();
[System.Runtime.InteropServices.DllImport("shell32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, ExactSpelling=true)]
private static extern int SHParseDisplayName(string path, IntPtr bind, out IntPtr item, uint flags, out uint attrs);
[System.Runtime.InteropServices.DllImport("shell32.dll", ExactSpelling=true)]
private static extern int SHOpenFolderAndSelectItems(IntPtr item, uint count, IntPtr children, uint flags);
public static void WithItem(string filename, Action<IntPtr> use) {
    // COINIT_APARTMENTTHREADED: both S_OK and S_FALSE need a matching uninitialize.
    System.Runtime.InteropServices.Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero, 2));
    try {
        IntPtr item; uint attrs;
        System.Runtime.InteropServices.Marshal.ThrowExceptionForHR(SHParseDisplayName(filename, IntPtr.Zero, out item, 0, out attrs));
        try { use(item); } finally { System.Runtime.InteropServices.Marshal.FreeCoTaskMem(item); }
    } finally { CoUninitialize(); }
}
public static void Reveal(string filename) {
    // A single absolute PIDL and zero children select the item in its parent.
    WithItem(filename, item => System.Runtime.InteropServices.Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(item, 0, IntPtr.Zero, 0)));
}
'@
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
[Miru.Selection]::Reveal($name)`;
export async function revealFile(
  target: string,
  env: BrowserEnvironment = systemEnvironment(),
): Promise<void> {
  if (env.platform === "win32" || isWsl(env)) {
    const filename = isWsl(env) ? await windowsPathForWsl(target, env) : target;
    if (!path.win32.isAbsolute(filename) || filename.includes("\0"))
      throw new Error("無効なファイルパスです。");
    await env.run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(windowsSelection, "utf16le").toString("base64"),
      ],
      Buffer.from(filename, "utf8").toString("base64"),
    );
  } else if (env.platform === "darwin") {
    await env.run("open", ["-R", target]);
  } else {
    // The file manager selects the URI. Never call xdg-open with a user file:
    // the default handler could open or even run it instead of revealing it.
    const uri = pathToFileURL(target, { windows: false }).href;
    await env.run("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.FileManager1",
      "--object-path",
      "/org/freedesktop/FileManager1",
      "--method",
      "org.freedesktop.FileManager1.ShowItems",
      JSON.stringify([uri]),
      "",
    ]);
  }
}
