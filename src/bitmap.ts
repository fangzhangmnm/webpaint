// 离屏位图工厂 SSoT。兼容 OffscreenCanvas（Safari 16.4+）+ 回退 HTMLCanvas。
// 历史上 doc.js / ora.js / 各处各抄一份；收口到这里（避免重复造轮子）。
export function makeBitmap(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") {
    try { return new OffscreenCanvas(w, h); } catch (_) { /* 某些上下文禁用 */ }
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
