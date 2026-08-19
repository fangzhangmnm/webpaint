// 职责（单一）：颜色面板——主色 set/读、浮动色板开关+拖动、吸色 pin tooltip。
// 色轮渲染/HSV 在 ui/color-wheel.ts；本模块只管「当前色 + 面板 chrome + 吸色提示」。
// drawing app 与色彩只经一个 color 值耦合（setColor 写 state.color → 反应式 → currentBrush 重派生）。

import type { AppContext } from "./app-context.ts";
import { els } from "./els.ts";
import { mountColorWheel } from "./ui/color-wheel.ts";
import { raiseWindow } from "./surfaces.ts";
import { desk } from "./workbench-state.ts";

let state: AppContext["state"], colorWheel: ReturnType<typeof mountColorWheel>;

// ---- 色板 target 切换（T4c；v0.8.24 扩到 fill 工具全程）：fill 里色板编辑「将要填的颜色」
// （PendingFill），不碰笔刷色。注册制防环：fill-mode init 时注册 provider（返回 null = 无 target，
// 照旧写笔刷色）。
export interface ColorTarget { get(): string; set(hex: string): void }
let _targetProvider: (() => ColorTarget | null) | null = null;
export function registerColorTarget(p: () => ColorTarget | null): void { _targetProvider = p; }
/** 色板当前显示/编辑的颜色（target 优先，否则笔刷色）。 */
export function currentPanelColor(): string { return _targetProvider?.()?.get() ?? state.color; }
/** 显示面重同步（target 生灭/undo 换色后调；只写 DOM/色轮，不写任何状态）。 */
export function refreshColorDisplay(): void {
  if (!colorWheel) return;   // initColorPanel 之前（node 测试/boot 早期）无显示面可刷
  const c = currentPanelColor();
  els.activeSwatch.style.background = c;
  colorWheel.setColor(c);
}

export function setColor(hex: string) {
  const t = _targetProvider?.();
  if (t) t.set(hex);   // fill 工具期：改的是 PendingFill（预览挂着时可撤销）；笔刷色不动
  else desk.brushTool.color = hex;   // 绑定反应式引擎（→state.color/dialReactive.color 重派生）+ 标脏持久化
  els.activeSwatch.style.background = hex;
  colorWheel?.setColor(hex);   // 推给色轮；组件自己守 round-trip，不会弹 hue（init 前无色轮=只写状态）
}

// restore 路径（载图/新建/重置）的显式笔刷色写入——**绕过 color target**。setColor 会被 fill 期
// 挂着的 target 劫持写进 PendingFill：存档笔刷色被吞、切工具即蒸发，且 swatch/色轮/编辑目标三方
// 不一致（v0.9.11 修；用户手势仍走 setColor，target 语义不变）。
export function setBrushColor(hex: string): void {
  desk.brushTool.color = hex;
  refreshColorDisplay();   // 显示按 target 优先刷（fill 期显示 pending，笔刷色在幕后就位）
}

export function toggleColorPanel(force?: boolean) {
  const hidden = els.colorPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  if (show) {
    desk.colorPanel.enabled = true;
    els.colorPanel.classList.remove("hidden");
    raiseWindow(els.colorPanel);
    const saved = desk.colorPanel.position;
    const w = els.colorPanel.offsetWidth || 264;
    const h = els.colorPanel.offsetHeight || 320;
    if (saved?.width) els.colorPanel.style.width = Math.max(180, saved.width) + "px";   // v0.5.21 持久化宽
    let left = saved?.left, top = saved?.top;
    if (left == null || top == null) { left = window.innerWidth - w - 16; top = 60; }
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(60, Math.min(window.innerHeight - h, top));   // top 地板=出血区（v0.4.11）
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
  } else {
    desk.colorPanel.enabled = false;
    els.colorPanel.classList.add("hidden");
  }
}

let _panelDrag: { id: number; sx: number; sy: number; ol: number; ot: number } | null = null;
let _pickerPinTimer: ReturnType<typeof setTimeout> | undefined;

// 文档加载/新建后应用该 doc 保存的面板状态：只写 DOM，绝不回写 desk（否则会误标脏）。
function applyColorPanelFromEditorState() {
  refreshColorDisplay();   // swatch+色轮一起按 target 优先刷（原来直读 state.color 且不碰色轮 → fill 期三方不一致）
  if (desk.colorPanel.enabled) {
    els.colorPanel.classList.remove("hidden");
    const saved = desk.colorPanel.position;
    if (saved?.width) els.colorPanel.style.width = Math.max(180, saved.width) + "px";   // v0.5.21 持久化宽
    const w = els.colorPanel.offsetWidth || 264;
    const h = els.colorPanel.offsetHeight || 320;
    let left = saved?.left, top = saved?.top;
    if (left == null || top == null) { left = window.innerWidth - w - 16; top = 60; }
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(60, Math.min(window.innerHeight - h, top));   // top 地板=出血区（v0.4.11）
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
  } else {
    els.colorPanel.classList.add("hidden");
  }
}

export function initColorPanel(ctx: AppContext) {
  state = ctx.state;
  colorWheel = mountColorWheel(els.colorPanelBody as HTMLElement, {
    getColor: () => currentPanelColor(),
    onPick: (hex: string) => setColor(hex),
  });
  els.activeSwatch.addEventListener("click", () => toggleColorPanel());
  setColor(state.color);
  els.colorPanelClose.addEventListener("click", () => toggleColorPanel(false));

  // 拖标题栏移动面板
  els.colorPanelHead.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest(".close-x")) return;
    const r = els.colorPanel.getBoundingClientRect();
    _panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.colorPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.colorPanelHead.addEventListener("pointermove", (e: PointerEvent) => {
    if (!_panelDrag || e.pointerId !== _panelDrag.id) return;
    const w = els.colorPanel.offsetWidth;
    const h = els.colorPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, _panelDrag.ol + (e.clientX - _panelDrag.sx)));
    const top = Math.max(60, Math.min(window.innerHeight - h, _panelDrag.ot + (e.clientY - _panelDrag.sy)));   // top 地板=出血区（v0.4.11，同 layers-panel）
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
    desk.colorPanel.position = { ...(desk.colorPanel.position ?? {}), left, top };
  });
  els.colorPanelHead.addEventListener("pointerup", (e: PointerEvent) => {
    if (_panelDrag && e.pointerId === _panelDrag.id) {
      try { els.colorPanelHead.releasePointerCapture(e.pointerId); } catch {}
      _panelDrag = null;
    }
  });
  // v0.5.21 user：颜色窗口调大小（宽；sv-pad 已流体化，高随内容）。同 layers #13 手柄纪律。
  const resizeEl = document.getElementById("colorPanelResize");
  let _resize: { id: number; sx: number; ow: number } | null = null;
  resizeEl?.addEventListener("pointerdown", (e: PointerEvent) => {
    _resize = { id: e.pointerId, sx: e.clientX, ow: els.colorPanel.offsetWidth };
    resizeEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizeEl?.addEventListener("pointermove", (e: PointerEvent) => {
    if (!_resize || e.pointerId !== _resize.id) return;
    const r = els.colorPanel.getBoundingClientRect();
    const w = Math.max(180, Math.min(window.innerWidth - r.left - 8, _resize.ow + (e.clientX - _resize.sx)));
    els.colorPanel.style.width = w + "px";
    desk.colorPanel.position = { ...(desk.colorPanel.position ?? {}), left: r.left, top: r.top, width: w };
  });
  resizeEl?.addEventListener("pointerup", (e: PointerEvent) => {
    if (_resize && e.pointerId === _resize.id) {
      try { resizeEl.releasePointerCapture(e.pointerId); } catch {}
      _resize = null;
    }
  });
  window.addEventListener("wp:toggleColor", () => toggleColorPanel());
  window.addEventListener("wp:applyEditorState", () => applyColorPanelFromEditorState());

  // 吸色 pin tooltip（input.js _doPick 派发 wp:pickerShow，pin 在采样像素屏坐标，1.5s 自动淡出）
  const pin = document.getElementById("pickerPin");
  window.addEventListener("wp:pickerShow", (e: Event) => {
    if (!pin) return;
    const { sx, sy, hex } = (e as CustomEvent).detail;
    pin.style.left = sx + "px";
    pin.style.top = sy + "px";
    pin.style.setProperty("--head-color", hex);
    pin.classList.remove("hidden");
    clearTimeout(_pickerPinTimer);
    _pickerPinTimer = setTimeout(() => pin.classList.add("hidden"), 1500);
  });
  window.addEventListener("wp:pickerHide", () => {
    if (!pin) return;
    pin.classList.add("hidden");
    clearTimeout(_pickerPinTimer);
  });
}
