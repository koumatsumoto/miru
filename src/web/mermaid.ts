import type { Theme } from "./colors";
import { isMermaidImage, mermaidInputError, mermaidLimits } from "../shared/mermaid";

const active = new Set<() => void>();
export function disposeMermaid() {
  for (const cancel of active) cancel();
}

export function renderMermaid(source: string, theme: Theme): Promise<string> {
  const invalid = mermaidInputError(source);
  if (invalid) return Promise.reject(new Error(invalid));
  return new Promise((resolve, reject) => {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const frame = document.createElement("iframe");
    frame.title = "隔離されたMermaid描画処理";
    frame.dataset.mermaidRenderer = "";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.referrerPolicy = "no-referrer";
    frame.tabIndex = -1;
    // Keep layout measurements available without making the transient renderer
    // visible or focusable. It has an opaque origin and no API credentials.
    frame.style.cssText =
      "position:fixed;left:-100000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none;border:0";
    let settled = false;
    let started = false;
    const finish = (error?: Error, png?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      frame.remove();
      active.delete(cancel);
      if (error) reject(error);
      else resolve(png!);
    };
    const cancel = () => finish(new Error("Mermaidの描画を中止しました。"));
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.channel !== nonce) return;
      if (event.data.type === "ready" && !started) {
        started = true;
        frame.contentWindow?.postMessage({ channel: nonce, type: "render", source, theme }, "*");
      } else if (event.data.type === "rendered" && started) {
        if (!isMermaidImage(event.data.png)) finish(new Error("Mermaidの画像出力が不正です。"));
        else finish(undefined, event.data.png);
      } else if (event.data.type === "failed")
        finish(new Error("Mermaidを描画できません。構文や対応する図の種類を確認してください。"));
    };
    // This is a responsiveness watchdog, not a guarantee of CPU preemption.
    const timer = window.setTimeout(
      () => finish(new Error("Mermaidの描画が時間内に完了しませんでした。")),
      mermaidLimits.timeoutMs,
    );
    window.addEventListener("message", receive);
    active.add(cancel);
    // A separately served document has its own tight CSP. srcdoc would inherit
    // the main page's no-inline-script policy and block this trusted renderer.
    frame.src = `/renderer/mermaid#${nonce}`;
    document.body.append(frame);
  });
}
