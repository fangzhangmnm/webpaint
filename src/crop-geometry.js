// Crop 框几何（A1，见 docs/reports/20260606-fresh-geological-survey.html）。
// 纯数学（无 DOM / 无 board）：8-handle 拖拽 resize + apply 取整。过去内联在 app.js 的
// cropOverlay pointermove。最易错的是「缩到下限时哪条边不动」的 anchor 钳制——抽出可单测。

// 拖某 handle 后的新框。
//   handle = 'move' | 含 n/s/w/e 的组合（'nw'/'n'/'se'/...）
//   startRect = 按下时的框 {x,y,w,h}（doc 单位）
//   dx/dy = doc 单位位移（caller 已 ÷scale）
//   opts.min/max = w/h 下限/上限（默认 4 / 8192）
// 约束：x/y 可负、w/h 可超 doc（v127 允许向外扩张）；w/h 夹 [min,max]；
//   缩到下限时对边不动（含 'w' 拖左边时钉住右边 → 移 x；含 'n' 同理钉下边 → 移 y）。
export function resizeCropRect(handle, startRect, dx, dy, opts = {}) {
  const min = opts.min ?? 4, max = opts.max ?? 8192;
  const r0 = startRect;
  const r = { ...r0 };
  if (handle === "move") {
    r.x = r0.x + dx;
    r.y = r0.y + dy;
    return r;          // 平移不改尺寸 → 不过 min/max 钳制
  }
  if (handle.includes("n")) { r.y = r0.y + dy; r.h = r0.h - dy; }
  if (handle.includes("s")) { r.h = r0.h + dy; }
  if (handle.includes("w")) { r.x = r0.x + dx; r.w = r0.w - dx; }
  if (handle.includes("e")) { r.w = r0.w + dx; }
  if (r.w < min) { r.w = min; if (handle.includes("w")) r.x = r0.x + r0.w - min; }
  if (r.h < min) { r.h = min; if (handle.includes("n")) r.y = r0.y + r0.h - min; }
  if (r.w > max) { r.w = max; if (handle.includes("w")) r.x = r0.x + r0.w - max; }
  if (r.h > max) { r.h = max; if (handle.includes("n")) r.y = r0.y + r0.h - max; }
  return r;
}

// apply：取整 + w/h 夹 [min,max]（x/y 允许负=向外扩张，不夹）。
export function cropRectToInts(rect, opts = {}) {
  const min = opts.min ?? 1, max = opts.max ?? 8192;
  return {
    x: rect.x | 0,
    y: rect.y | 0,
    w: Math.max(min, Math.min(max, rect.w | 0)),
    h: Math.max(min, Math.min(max, rect.h | 0)),
  };
}
