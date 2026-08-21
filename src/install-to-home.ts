// install-to-home —— 「把本站装到主屏」的能力探测 + 安装入口。
//
// 为什么这是**数据安全**的一环、不只是 UX（2026-08-21 存储驱逐调查）：
//   WebKit 官方原话把「whether the website is opened as a Home Screen Web App」列为它决定
//   给不给持久化存储的**启发式因子之一**。装到主屏 ⇒ 更可能拿到 persistent 存储 ⇒
//   更不容易被浏览器整源驱逐（MDN：驱逐 skips over origins that have been granted data persistence）。
//   详 ai-docs/20260821-storage-eviction-investigation.md §A。
//
// 产品纪律（user 2026-08-21 拍板）：「引导装主屏这个还是放在设置里面。不做强制引导。」
//   ⇒ 本模块**不弹任何东西**、不在首屏拦人、不在 boot 期做任何动作。只提供状态和一个可点的入口，
//     由设置菜单调用。同批拍板：「不做首屏弹窗，数据安全告知靠 UX 来维护。」
//
// ⚠ 别把「装到主屏」当成 ITP 7 天清除的豁免 —— Apple 无文档、开发者报告互相矛盾。文案别这么写。

/** 当前是不是以已安装的 web app 形态在跑（主屏/Dock/独立窗口）。 */
export function isStandalone(): boolean {
  try {
    if (matchMedia && matchMedia("(display-mode: standalone)").matches) return true;
  } catch { /* 老浏览器无 matchMedia */ }
  return (navigator as { standalone?: boolean }).standalone === true;   // iOS Safari 的老接口
}

// Chromium 系会在可安装时抛 beforeinstallprompt，事件对象要**存起来**留到用户点的时候再 prompt()。
// 必须在模块 import 时就挂监听：这个事件在 boot 早期就可能来，挂晚了直接错过。
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let _deferred: InstallPromptEvent | null = null;
window.addEventListener("beforeinstallprompt", (e: Event) => {
  e.preventDefault();                 // 拦下浏览器自带的迷你横幅 —— 入口归设置里那一条（不做强制引导）
  _deferred = e as InstallPromptEvent;
});
window.addEventListener("appinstalled", () => { _deferred = null; });

/** installed=已装；promptable=浏览器给了安装入口（Chromium）；manual=只能教用户手动装（iOS Safari 等）。 */
export type InstallState = "installed" | "promptable" | "manual";
export function installState(): InstallState {
  if (isStandalone()) return "installed";
  return _deferred ? "promptable" : "manual";
}

/** iOS/iPadOS Safari？（决定说明文案走「分享→添加到主屏幕」那套） */
export function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1);
  return iOS && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** 触发原生安装框。**必须在 user-gesture 的同步续体里调**（iOS 红线同款：await 之后活化可能已丢）。
 *  返回 null = 这个浏览器没有可用的原生入口，调用方去弹手动说明。 */
export function promptInstall(): Promise<string> | null {
  const d = _deferred;
  if (!d) return null;
  _deferred = null;                   // 一次性：prompt() 用过就作废
  return d.prompt().then(() => d.userChoice).then((c) => c.outcome).catch(() => "error");
}
