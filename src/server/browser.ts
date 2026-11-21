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

// Pass the selected filename to a fixed program as data, never as PowerShell
// source. Use the system Notepad rather than PATH or a file association.
const windowsEdit = `
$ErrorActionPreference = 'Stop'
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
if (-not [IO.File]::Exists($name)) { throw 'File unavailable' }
$system = [Environment]::SystemDirectory
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = [IO.Path]::Combine($system, 'notepad.exe')
$start.WorkingDirectory = $system
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
# Child handles must not keep the parent Node process's request pipes open.
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
# The validated path contains no quote, ends in a filename, and is the only argument.
$start.Arguments = '"' + $name + '"'
$editor = [Diagnostics.Process]::Start($start)
$editor.Dispose()`;

export class EditorError extends Error {}

function windowsName(part: string) {
  // Win32 normalizes trailing dots/spaces and gives devices special meanings.
  return (
    !!part &&
    !/[<>:"/\\|?*]/u.test(part) &&
    !Array.from(part).some((character) => character.charCodeAt(0) < 32) &&
    !/[. ]$/u.test(part) &&
    !/^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/iu.test(part)
  );
}

export async function editFile(
  target: string,
  env: BrowserEnvironment = systemEnvironment(),
): Promise<void> {
  const wsl = isWsl(env);
  try {
    if (env.platform === "win32" || wsl) {
      const invalid = () =>
        new EditorError("Windowsで扱えないファイル名のため、メモ帳に渡せません。");
      // A literal backslash (or other Win32-reserved character) in a Linux
      // component must not turn into a different Windows path or data stream.
      if (wsl && (!path.posix.isAbsolute(target) || !target.slice(1).split("/").every(windowsName)))
        throw invalid();
      const filename = wsl ? await windowsPathForWsl(target, env) : target;
      const drive = /^[a-z]:\\/iu.exec(filename);
      const unc = /^\\\\([^\\]+)\\([^\\]+)\\/u.exec(filename);
      const prefix = drive ?? unc;
      if (
        !prefix ||
        (unc &&
          (!windowsName(unc[1]) ||
            !windowsName(unc[2]) ||
            (wsl && !/^(?:wsl\.localhost|wsl\$)$/iu.test(unc[1])))) ||
        !filename.slice(prefix[0].length).split("\\").every(windowsName)
      )
        throw invalid();
      await env.run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsEdit, "utf16le").toString("base64"),
        ],
        Buffer.from(filename, "utf8").toString("base64"),
      );
    } else if (env.platform === "darwin") {
      if (!path.posix.isAbsolute(target)) throw new EditorError("有効なファイルを選んでください。");
      // TextEdit may render rich documents instead of opening their source.
      if (/\.(?:html?|xhtml|shtml|rtf|rtfd|webarchive)$/iu.test(target))
        throw new EditorError("macOSではHTML・リッチテキストをMiruから編集できません。");
      await env.run("/usr/bin/open", ["-a", "/System/Applications/TextEdit.app", target]);
    } else {
      throw new EditorError("このOSでは外部エディターへの引き渡しに対応していません。");
    }
  } catch (error) {
    if (error instanceof EditorError) throw error;
    throw new EditorError("テキストエディターを起動できません。OSの設定を確認してください。");
  }
}
