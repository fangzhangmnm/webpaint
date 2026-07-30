// Crop 框几何（A1，见 docs/reports/20260606-fresh-geological-survey.html）。
// 纯数学（无 DOM / 无 board）：8-handle 拖拽 resize + apply 取整。过去内联在 app.js 的
// cropOverlay pointermove。最易错的是「缩到下限时哪条边不动」的 anchor 钳制——抽出可单测。

export interface CropRect { x: number; y: number; w: number; h: number; }
export interface CropSizeOpts { min?: number; max?: number; }

// 拖某 handle 后的新框。
//   handle = 'move' | 含 n/s/w/e 的组合（'nw'/'n'/'se'/...）
//   startRect = 按下时的框 {x,y,w,h}（doc 单位）
//   dx/dy = doc 单位位移（caller 已 ÷scale）
//   opts.min/max = w/h 下限/上限（默认 4 / 8192）
// 约束：x/y 可负、w/h 可超 doc（v127 允许向外扩张）；w/h 夹 [min,max]；
//   缩到下限时对边不动（含 'w' 拖左边时钉住右边 → 移 x；含 'n' 同理钉下边 → 移 y）。
export function resizeCropRect(handle: string, startRect: CropRect, dx: number, dy: number, opts: CropSizeOpts = {}): CropRect {
  const min = opts.min ?? 4, max = opts.max ?? 8192;
  const r0 = startRect;
  const r: CropRect = { ...r0 };
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

// 模板模式（v0.6.48）：锁比 resize——先跑普通 resizeCropRect，再把结果修回 aspect（=w/h）。
//   角：以拖动位移的主导轴定尺寸、对角锚定；边：拖动轴定尺寸、另一轴居中对称调整。
//   move 平移不改尺寸。数学抽此可单测（同 resizeCropRect 的存在理由）。
export function resizeCropRectAspect(handle: string, startRect: CropRect, dx: number, dy: number, aspect: number, opts: CropSizeOpts = {}): CropRect {
  const min = opts.min ?? 4, max = opts.max ?? 8192;
  const r0 = startRect;
  if (handle === "move") return { x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h };
  const clampW = (w: number) => Math.max(Math.max(min, min * aspect), Math.min(Math.min(max, max * aspect), w));
  const horiz = handle.includes("w") || handle.includes("e");
  const vert = handle.includes("n") || handle.includes("s");
  if (horiz && vert) {
    // 角：主导轴 = 位移绝对值大的那轴换算成宽
    const wFromX = r0.w + (handle.includes("e") ? dx : -dx);
    const wFromY = (r0.h + (handle.includes("s") ? dy : -dy)) * aspect;
    const w = clampW(Math.abs(wFromX - r0.w) >= Math.abs(wFromY - r0.w) ? wFromX : wFromY);
    const h = w / aspect;
    return {
      x: handle.includes("w") ? r0.x + r0.w - w : r0.x,
      y: handle.includes("n") ? r0.y + r0.h - h : r0.y,
      w, h,
    };
  }
  if (vert) {
    // 上/下边：h 随拖动、w=h·aspect、水平居中
    const h0 = handle.includes("s") ? r0.h + dy : r0.h - dy;
    const w = clampW(h0 * aspect);
    const h = w / aspect;
    return { x: r0.x + (r0.w - w) / 2, y: handle.includes("n") ? r0.y + r0.h - h : r0.y, w, h };
  }
  // 左/右边：w 随拖动、垂直居中
  const w = clampW(handle.includes("e") ? r0.w + dx : r0.w - dx);
  const h = w / aspect;
  return { x: handle.includes("w") ? r0.x + r0.w - w : r0.x, y: r0.y + (r0.h - h) / 2, w, h };
}

// fit（模板模式，基准 = 内容 bbox）：cover=框内缩到被内容盖满（结果无留白、出框内容裁掉）；
// contain=框外扩到含住全部内容（不丢东西、四周留空）。都居中。
export function fitRectToBBox(bbox: CropRect, aspect: number, mode: "cover" | "contain"): CropRect {
  const w = mode === "cover"
    ? Math.min(bbox.w, bbox.h * aspect)
    : Math.max(bbox.w, bbox.h * aspect);
  const h = w / aspect;
  return { x: bbox.x + (bbox.w - w) / 2, y: bbox.y + (bbox.h - h) / 2, w, h };
}

// apply：取整 + w/h 夹 [min,max]（x/y 允许负=向外扩张，不夹）。
export function cropRectToInts(rect: CropRect, opts: CropSizeOpts = {}): CropRect {
  const min = opts.min ?? 1, max = opts.max ?? 8192;
  return {
    x: rect.x | 0,
    y: rect.y | 0,
    w: Math.max(min, Math.min(max, rect.w | 0)),
    h: Math.max(min, Math.min(max, rect.h | 0)),
  };
}
