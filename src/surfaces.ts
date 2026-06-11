// Surfaces —— z-order 深模块。回答一个问题：「这块 UI 该浮在谁上面」。
//
// 设计（v232，docs/surfaces-z-order.md）：
// - 全 app 的 z 是一张静态 band 表，SSoT 在 styles.css :root 的 --z-* 变量：
//     chrome < toolbar < window < sheet < overlay < menu < toast < modal < gate < busy < popout < dev < error
//   band 间关系编译期定死：「菜单/popup 永远在浮窗上面」「图库里的菜单永远在图库上面」是
//   结构不变量，不靠程序员手填数字。新 UI 只选 band 用 var(--z-*)，不发明数字。
// - 本模块只管 **window band 内** 的动态顺序（参考 / 图层 / 颜色 / 调整 / 色板 谁压谁）：
//   z = base + 栈内序号，每次 raise 整栈重新归一化 → z 永远困在 band 内。
//   取代 v113 _bringPanelTop 的无上限递增计数器（点 15 次就爬过菜单层，正是
//   「菜单被窗口盖住」一族 bug 的根）。
// - raise 的两个触发点：① open/toggle 显示窗口时（开谁谁到顶）② pointerdown 点窗口时。
//   ②由 registerWindow 统一挂 capture listener，新窗口接入 = 一行 registerWindow(el)。

let _base = 0;
function base(): number {
  if (!_base) {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--z-window"), 10);
    _base = Number.isFinite(v) && v > 0 ? v : 100;
  }
  return _base;
}

const _stack: HTMLElement[] = [];   // 打开顺序，末位最高

export function raiseWindow(el: HTMLElement | null) {
  if (!el) return;
  const i = _stack.indexOf(el);
  if (i >= 0) _stack.splice(i, 1);
  else el.addEventListener("pointerdown", () => raiseWindow(el), true);
  _stack.push(el);
  const b = base();
  _stack.forEach((w, idx) => { w.style.zIndex = String(b + idx); });
}

// 注册 = 进栈底 + 挂 pointerdown raise；首次真正置顶发生在 open 时（调 raiseWindow）。
export function registerWindow(el: HTMLElement | null) {
  if (!el || _stack.includes(el)) return;
  _stack.unshift(el);
  el.addEventListener("pointerdown", () => raiseWindow(el), true);
}
