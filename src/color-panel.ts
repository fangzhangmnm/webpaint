// 职责（单一）：颜色面板——主色 set/读、浮动色板开关+拖动、吸色 pin tooltip。
// 色轮渲染/HSV 在 ui/color-wheel.ts；本模块只管「当前色 + 面板 chrome + 吸色提示」。
// drawing app 与色彩只经一个 color 值耦合（setColor 写 state.color → 反应式 → currentBrush 重派生）。

import { els } from "./els.ts";
import { mountColorWheel } from "./ui/color-wheel.ts";

const safeLS = (k: string, f?: any) => { try { return localStorage.getItem(k) ?? f; } catch { return f; } };
const safeLSSet = (k: string, v: any) => { try { localStorage.setItem(k, String(v)); } catch {} };

let state: any, colorWheel: any;

export function setColor(hex: string) {
  state.color = hex;   // 反应式（proxy→dialReactive.color）→ currentBrush computed 自动重派生
  safeLSSet("webpaint.color", hex);
  els.activeSwatch.style.background = hex;
  colorWheel.setColor(hex);   // 推给色轮；组件自己守 round-trip，不会弹 hue
}

export function toggleColorPanel(force?: boolean) {
  const hidden = els.colorPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  if (show) {
    els.colorPanel.classList.remove("hidden");
    const saved = safeLS("webpaint.colorPanel.pos");
    const w = els.colorPanel.offsetWidth || 264;
    const h = els.colorPanel.offsetHeight || 320;
    let left, top;
    if (saved) {
      try { const o = JSON.parse(saved); left = o.left; top = o.top; }
      catch { left = top = null; }
    }
    if (left == null) { left = window.innerWidth - w - 16; top = 60; }
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
  } else {
    els.colorPanel.classList.add("hidden");
  }
}

let _panelDrag: any = null;
let _pickerPinTimer: any = null;

export function initColorPanel(ctx) {
  state = ctx.state;
  colorWheel = mountColorWheel(els.colorPanelBody, {
    getColor: () => state.color,
    onPick: (hex: string) => setColor(hex),
  });
  els.activeSwatch.addEventListener("click", () => toggleColorPanel());
  setColor(state.color);
  els.colorPanelClose.addEventListener("click", () => toggleColorPanel(false));

  // 拖标题栏移动面板
  els.colorPanelHead.addEventListener("pointerdown", (e: any) => {
    if (e.target.closest(".close-x")) return;
    const r = els.colorPanel.getBoundingClientRect();
    _panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.colorPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.colorPanelHead.addEventListener("pointermove", (e: any) => {
    if (!_panelDrag || e.pointerId !== _panelDrag.id) return;
    const w = els.colorPanel.offsetWidth;
    const h = els.colorPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, _panelDrag.ol + (e.clientX - _panelDrag.sx)));
    const top = Math.max(0, Math.min(window.innerHeight - h, _panelDrag.ot + (e.clientY - _panelDrag.sy)));
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
    safeLSSet("webpaint.colorPanel.pos", JSON.stringify({ left, top }));
  });
  els.colorPanelHead.addEventListener("pointerup", (e: any) => {
    if (_panelDrag && e.pointerId === _panelDrag.id) {
      try { els.colorPanelHead.releasePointerCapture(e.pointerId); } catch {}
      _panelDrag = null;
    }
  });
  window.addEventListener("wp:toggleColor", () => toggleColorPanel());

  // 吸色 pin tooltip（input.js _doPick 派发 wp:pickerShow，pin 在采样像素屏坐标，1.5s 自动淡出）
  const pin = document.getElementById("pickerPin");
  window.addEventListener("wp:pickerShow", (e: any) => {
    if (!pin) return;
    const { sx, sy, hex } = e.detail;
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
