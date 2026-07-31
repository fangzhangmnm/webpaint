// 选区笔（v0.7.25 落地，v0.7.26 笔架化）——lasso/fill 子工具 "pen"，与魔棒/矩形平级。
//
// 原则（user 2026-07-30 两连拍板）：
// ①「不接 ResolvedBrush 才会屎山，尽量避免一个逻辑写两条」——笔刷管线动力学
//   （spacing/压感/taper/引擎平滑）零重写，走 BrushEngine buffered 路径；
// ②「笔架不是有滤镜笔画画笔橡皮笔吗，加一个选区笔就行了」——**不自造变体轮子**：
//   笔架第四个工具类别 "selPen"（builtin-brushes.json 三支出厂笔：硬圆/勾线/像素），
//   lasso/fill 经 getRackToolKey 映射；本模块只做「笔架笔 → 选区笔渲染态」的覆写 + 抬笔光栅。
//
// 出口：抬笔 collectStamps() → alpha 平面 → ≥128 二值 → Selection（恒二值不变量，2026-07-29）
// → lasso._applySelectionUpdate 按布尔模式合成（subtract 即减选，无独立橡皮）。

import type { ResolvedBrush } from "./resolved-brush.ts";

/** 预览色带颜色（仅视觉反馈；选区结果与色无关，半透明由 opacity=0.5 提供） */
export const SEL_PEN_BAND = "#3b82f6";

/**
 * 笔架当前笔 → 选区笔描边态：色带覆写 + pixelMode 压平（动力学 buffered 同源；
 * 原 pixelMode 由 input 侧记住，抬笔改走 Bresenham disc 字节核——像素手感的精确落纸）。
 */
export function selPenSettingsFrom(base: ResolvedBrush): ResolvedBrush {
  return Object.freeze({
    ...(base as Record<string, unknown>),
    color: SEL_PEN_BAND, opacity: 0.5, blendMode: "source-over", pixelMode: false,
  }) as ResolvedBrush;
}

/**
 * stamps → 二值 gray8 bbox 平面（像素笔抬笔主路径 + GL 不可用回退）。
 * disc = 引擎的 Bresenham 圆盘字节核（BrushEngine.pixelDiscInto 注入——与像素笔同一核，
 * 不产生第二份圆栅格实现）。落格/尺寸取整逐字对齐 brush.ts stampPixels。
 */
export function stampsToBinaryGray8(
  stamps: Array<{ x: number; y: number; size: number; alpha: number }>,
  bx: number, by: number, bw: number, bh: number,
  disc: (buf: Uint8ClampedArray, rw: number, rh: number, ox: number, oy: number,
         ix: number, iy: number, intSize: number) => void,
): Uint8Array {
  const rgba = new Uint8ClampedArray(bw * bh * 4);
  for (const s of stamps) {
    if (s.alpha < 0.01) continue;
    const intSize = Math.max(1, Math.round(s.size));
    const ix = Math.floor(s.x - (intSize - 1) / 2);
    const iy = Math.floor(s.y - (intSize - 1) / 2);
    disc(rgba, bw, bh, bx, by, ix, iy, intSize);
  }
  const g = new Uint8Array(bw * bh);
  for (let i = 0; i < g.length; i++) g[i] = rgba[i * 4 + 3] >= 128 ? 255 : 0;
  return g;
}
