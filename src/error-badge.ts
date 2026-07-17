// 统一 error report（universal error banner）——全 app + store 的错误唯一汇拢点。
//   职责：把一条错误按 severity 分流到正确的 UI 面，并作为**最终消费者** console.log（层层上报只有这里 log）。
//   - "error"   → 顶层红条 banner（#__errBar，z-9999，盖过 gallery overlay/busy/gate/modal）+ console.error
//   - "warning" → 顶层琥珀条 banner + console.warn
//   - "info"    → 状态栏（setStatus，瞬态）
//   - "log"     → 只 console.log（良性 offline/fallback：funnel 但不打扰用户）
//   banner 复用 index.html 内联 bootstrap 落下的 #__errBar 那一档（那份内联 = bundle 加载前的早期兜底；
//   本模块 init 后接管 window.__wp_showFatal，让内联的 error/unhandledrejection handler 也走 severity）。

export type ErrorLevel = "error" | "warning" | "info" | "log";

const BANNER_COLOR: Record<"error" | "warning", string> = {
  error: "#c0392b",
  warning: "#b7791f",
};
const BANNER_CSS =
  "position:fixed;left:0;right:0;top:0;z-index:9999;padding:8px 12px;color:#fff;" +
  "font:13px/1.4 system-ui;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;cursor:pointer";

let statusSink: ((text: string, persist?: boolean) => void) | null = null;

/** app 在 boot 时注入状态栏 sink（info 级走这里）+ 接管全局 fatal handler。 */
export function initErrorBadge(deps: { status: (text: string, persist?: boolean) => void }): void {
  statusSink = deps.status;
  // 接管内联 bootstrap 的 fatal shower：往后 window.error / unhandledrejection 也过 severity（默认当 error）。
  (window as unknown as { __wp_showFatal?: (t: string) => void }).__wp_showFatal = (text: string) => {
    showBanner(text, "error");
  };
}

function errToText(err: unknown): string {
  if (err == null) return "未知错误";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  const anyErr = err as { message?: unknown };
  if (anyErr && typeof anyErr.message === "string") return anyErr.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function showBanner(text: string, level: "error" | "warning"): void {
  let bar = document.getElementById("__errBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "__errBar";
    bar.addEventListener("click", () => bar!.remove());
    (document.body || document.documentElement).appendChild(bar);
  }
  bar.style.cssText = BANNER_CSS + ";background:" + BANNER_COLOR[level];
  bar.textContent = text + "  (点击关闭)";
}

/**
 * 唯一 error 上报入口。app 各处 catch / store 的 ui.reportError 都汇到这里。
 * @param err   任意错误（Error / string / 对象）
 * @param level 默认 "error"。见文件头分流表。
 */
export function reportError(err: unknown, level: ErrorLevel = "error"): void {
  const msg = errToText(err);
  // 最终消费者 log（层层上报只此一处 log）
  if (level === "error") console.error("[wp]", err);
  else if (level === "warning") console.warn("[wp]", err);
  else console.log("[wp]", err);

  if (level === "error" || level === "warning") showBanner(msg, level);
  else if (level === "info") statusSink?.(msg);
  // level === "log"：只 console，不打扰用户
}
