// 职责（单一）：transient 模式（lasso transform / crop / adjust）下的浮动面板抑制·复原
//   + transform commit/cancel 护栏。
// 进 transient：把不相关 float panel 暂时藏起（mode-specific allowList 决定留谁）；退出时复原。
// brush rack 走 closeExclusive 顺手关。z-order：点 panel 把它带到同层最高 z（_bringPanelTop）。
// _suppressTransientPanels/_restoreTransientPanels/_bringPanelTop/_commitTransform/_cancelTransform
// 经 ctx 被 toolbar / selection-ops / doc-ops / filters-adjust 消费，故全部 export。
import { closeExclusive } from "./panel-state.js";
import { updateLassoToolbar } from "./toolbar.ts";

let input: any, board: any;

// v116: transient mode panel suppression
// user：「transient 的时候有些窗口应该暂时 hide... 大部分窗口都是准模态的，而不是一直留在画布上」
// 进 transient (lasso transform / crop / color adjust)：把不相关 float 暂时藏起；
// 退出时复原。brush rack 走 closeExclusive 顺便关；brush settings 全屏 view 不动 (用户主动开的)
let _suppressedDuringTransient = [];
export function _suppressTransientPanels(mode) {
  const allow = {
    transform:      ["referencePanel", "layersPanel"],     // transform 时还要看引用图 / 切活动层
    crop:           ["referencePanel"],
    "adjust-color": ["referencePanel", "layersPanel"],
  };
  const allowList = allow[mode] || [];
  const candidates = ["colorPanel", "paletteWindow", "referencePanel", "layersPanel"];
  // 防递归 (transition 间套用)：先复原再藏
  _restoreTransientPanels();
  for (const id of candidates) {
    if (allowList.includes(id)) continue;
    const el = document.getElementById(id);
    if (!el || el.classList.contains("hidden")) continue;
    _suppressedDuringTransient.push({ el, id });
    el.classList.add("hidden");
  }
  // brush rack: closeExclusive 一把关
  try { closeExclusive(); } catch {}
}
export function _restoreTransientPanels() {
  for (const { el } of _suppressedDuringTransient) {
    el.classList.remove("hidden");
  }
  _suppressedDuringTransient = [];
}

// v113: panel z-order —— 点击 panel 把它带到同 panel 层内最高 z
// user：「adjust panel 点出来之后在 color panel 下面，导致我以为坏了，能不能点开谁谁到这一层的 top」
let _panelTopZ = 15;     // float-panel 默认 z = 15；递增不限上限
export function _bringPanelTop(el) {
  if (!el) return;
  _panelTopZ++;
  el.style.zIndex = _panelTopZ;
}

// transform 浮层的 commit / cancel（lasso commit/cancel 按钮 + 决定性动作都走这两个）
export function _commitTransform() {
  input.commitLassoIfFloating();
  updateLassoToolbar();
  _restoreTransientPanels();
}
export function _cancelTransform() {
  if (input.lasso.hasFloating()) {
    input.lasso.cancel();
    board.invalidateAll();
    updateLassoToolbar();
  }
  _restoreTransientPanels();
}

export function initTransientPanels(ctx) {
  input = ctx.input;
  board = ctx.board;

  // 给每个可能弹出来的 float panel 在 pointerdown 时 bringTop
  const panels = [
    "colorPanel", "paletteWindow", "referencePanel",
    "adjustPanel",
  ];
  for (const id of panels) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("pointerdown", () => _bringPanelTop(el), true);
  }
}
