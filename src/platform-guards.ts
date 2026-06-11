// 平台手势护栏 —— 单一职责：全局 capture-phase 拦截 + pointer 自愈，挡掉 iPad/触屏系统手势对画布的劫持。
//
// 防御面（docs/ipad-doubletap-architecture.md layer 2/4）：
//   - pointer 自愈：window 级 pointercancel / app 隐藏 / 失焦 → input.cancelAllPointers()（清 ghost finger）。
//   - dblclick 拦截：防 iPad 系统级「双击文本选中 / 双击拖窗」。
//   - 3 指以上 touchstart 拦截：挡系统 split-view / slide-over 抢手。
//   - gesturestart/gesturechange 拦截：iOS Safari 多点缩放专属事件。
// 文本输入元素（INPUT/TEXTAREA/contenteditable）一律放行，不拦。

let input: any;

function isTextEditableTarget(t: any) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (t.isContentEditable) return true;
  return false;
}

export function initPlatformGuards(ctx: any) {
  input = ctx.input;

  // pointer 自愈兜底：window 级 cancel / app 隐藏 / 窗口失焦 都 cancelAllPointers。
  window.addEventListener("pointercancel", () => input.cancelAllPointers(), true);
  window.addEventListener("blur", () => input.cancelAllPointers());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") input.cancelAllPointers();
  });

  // capture-phase 拦 dblclick（防 iPad 系统级"双击文本选中 / 双击拖窗"劫持）
  window.addEventListener("dblclick", (e) => {
    if (isTextEditableTarget(e.target)) return;
    e.preventDefault();
  }, { capture: true, passive: false });
  // 3 指及以上 touchstart：拦掉系统 split-view / slide-over 抢手
  window.addEventListener("touchstart", (e) => {
    if (e.touches.length >= 3 && !isTextEditableTarget(e.target)) {
      e.preventDefault();
    }
  }, { capture: true, passive: false });
  // gesturestart（iOS Safari 多点缩放专属事件）也拦
  window.addEventListener("gesturestart", (e) => e.preventDefault(), { capture: true, passive: false });
  window.addEventListener("gesturechange", (e) => e.preventDefault(), { capture: true, passive: false });

  // v232 (user：「画画误触还是会弹 拷贝/翻译/共享 系统菜单」)：CSS user-select:none 之外的双保险。
  // ① selectstart 拦截：非文本输入元素一律不许起文本选择（callout 菜单的前置条件就是有 selection）。
  document.addEventListener("selectstart", (e) => {
    if (isTextEditableTarget(e.target)) return;
    e.preventDefault();
  }, { capture: true });
  // ② selectionchange 兜底：iOS 偶发无视 preventDefault / 从 WKWebView 层面起选择。
  //    出现落在非输入区的非空 selection → 立刻清 ranges，系统菜单失去依附就不弹（或一闪而灭）。
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    let n: any = sel.anchorNode;
    if (n && n.nodeType === Node.TEXT_NODE) n = n.parentElement;
    for (let el = n; el; el = el.parentElement) {
      if (isTextEditableTarget(el)) return;   // 输入框内的选择放行（改名/搜索要选词粘贴）
    }
    sel.removeAllRanges();
  });
}
