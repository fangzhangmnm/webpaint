// PWA 安装入口（v0.9.26，user 2026-08-20：「主菜单和图库主菜单加一个安装的选项」）。壳域：浏览器 API 边界。
// beforeinstallprompt 是 Chromium 专有事件：被捕获后安装按钮才显形（iPad Safari 无此 API → 按钮恒隐，
// iOS 安装走系统分享菜单，不在此处理）；已在安装态（standalone 显示模式）或 appinstalled 后恒隐。
// prompt() 一次性：用掉即弃引用，浏览器认为合适时会再发新事件。
import { reportError } from "./error-badge.ts";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

let _deferred: BeforeInstallPromptEvent | null = null;
const _buttons: HTMLElement[] = [];

function _isStandalone(): boolean {
  try {
    return matchMedia("(display-mode: standalone)").matches
      || (navigator as { standalone?: boolean }).standalone === true;   // iOS 老字段
  } catch { return false; }
}

function _render(): void {
  const show = _deferred != null && !_isStandalone();
  for (const b of _buttons) b.hidden = !show;
}

/** boot 时调一次（settings-menu init）：越早越好——事件发在监听之前就永远收不到了。 */
export function initInstallCapture(): void {
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();   // 压掉 Chrome 自己的 mini-infobar，改由菜单项承载
    _deferred = e as BeforeInstallPromptEvent;
    _render();
  });
  window.addEventListener("appinstalled", () => { _deferred = null; _render(); });
  _render();
}

/** 把一个菜单按钮登记为安装入口：显隐归本模块管，点击=（先跑 owner 的收面板回调再）弹系统安装框。 */
export function bindInstallButton(el: HTMLElement | null, beforePrompt?: () => void): void {
  if (!el) return;
  _buttons.push(el);
  el.addEventListener("click", () => {
    beforePrompt?.();
    const ev = _deferred;
    if (!ev) return;
    _deferred = null; _render();
    ev.prompt().catch((e) => reportError(new Error("[install] prompt failed: " + String(e)), "log"));
  });
  _render();
}
