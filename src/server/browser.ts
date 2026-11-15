import { execFile } from "node:child_process";
import { release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
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
    ),
  );
}
// Injectable only for deterministic command-construction tests. No launcher is run
// by those tests, and the HTTP API cannot supply or change this environment.
interface BrowserEnvironment {
  platform: NodeJS.Platform;
  release: string;
  distro?: string;
  run: (command: string, args: string[]) => Promise<string>;
}
export async function openBrowser(
  target: string,
  isFile = false,
  environment: BrowserEnvironment = {
    platform: process.platform,
    release: release(),
    distro: process.env.WSL_DISTRO_NAME,
    run,
  },
): Promise<void> {
  const wsl =
    environment.platform === "linux" &&
    (/microsoft/iu.test(environment.release) || Boolean(environment.distro));
  let url = target;
  if (isFile) {
    if (wsl) {
      // Remove the command's final line ending, not whitespace belonging to a name.
      const windowsPath = (await environment.run("wslpath", ["-w", target])).replace(/\r?\n$/u, "");
      if (!path.win32.isAbsolute(windowsPath) || windowsPath.includes("\0"))
        throw new Error("WSLのファイルパスをWindows形式に変換できませんでした。");
      url = pathToFileURL(windowsPath, { windows: true }).href;
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
