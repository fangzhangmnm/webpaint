// 选区笔（v0.7.25，user 拍板：lasso/fill 子工具，与魔棒/矩形/椭圆平级）。
//
// 原则（user 2026-07-30：「不接 ResolvedBrush 才会屎山，尽量避免一个逻辑写两条」）：
// 完整复用笔刷管线的**动力学**——ResolvedBrush → BrushEngine buffered 路径
// （spacing/压感/taper/引擎平滑，一行不重写），只换出口：抬笔 collectStamps() →
// alpha 平面 → ≥128 二值 → Selection（选区恒二值不变量，user 2026-07-29）→
// lasso._applySelectionUpdate 按布尔模式合成（subtract 即减选，无需独立橡皮）。
//
// 三变体逐字段抄内置笔手感（builtin-brushes.json；名字不叫橡皮——user）：
//   hard = 硬圆（硬橡皮 args：零平滑 / spacing .04 / 双端 taper / 压感全给尺寸）
//   ink  = 勾线（重平滑 streamline+stab .5 / 轻压变粗 γ.5 / 起笔尖）
//   pixel= 像素（硬边 / spacing .5 / 零平滑；**不带 pixelMode**——动力学走 buffered 同源，
//          落纸在 input 侧用引擎的 Bresenham disc 字节核 CPU 光栅，见 stampsToBinaryGray8）
//
// 选区结果与色带颜色无关；flow 恒 1 + 三变体 opa/flowCoeff 全 0 → stampAlpha≈1，
// GPU wash(MAX) 累积后 α=硬度衰减曲线，阈值 128 = 半径中线，taper 尖端靠 size 缩放保留。

import { resolveBrush } from "./resolved-brush.ts";
import type { ResolvedBrush, ResolveBrushArgs } from "./resolved-brush.ts";

export type SelPenVariant = "hard" | "ink" | "pixel";
export const SEL_PEN_VARIANTS: { id: SelPenVariant; labelKey: string }[] = [
  { id: "hard", labelKey: "sp.hard" },
  { id: "ink", labelKey: "sp.ink" },
  { id: "pixel", labelKey: "sp.pixel" },
];
/** 预览色带颜色（仅视觉反馈；半透明由 opacity=0.5 提供） */
export const SEL_PEN_BAND = "#3b82f6";
export const SEL_PEN_DEFAULT_SIZE: Record<SelPenVariant, number> = { hard: 30, ink: 8, pixel: 1 };
export const SEL_PEN_SIZE_MAX: Record<SelPenVariant, number> = { hard: 300, ink: 60, pixel: 64 };

// BrushPreset 嵌套形（resolveBrush 的读法），值逐字段对齐 builtin-brushes.json
const PRESETS: Record<SelPenVariant, object> = {
  hard: { shape: { kind: "round", hardness: 0.5 }, taper: { in: 0.5, out: 0.5 },
          sizeCoeff: 1, opaCoeff: 0, flowCoeff: 0, pressureGamma: 1, pressureLPF: 50,
          compositeMode: "wash", spacing: 0.04, smooth: { streamline: 0, stabilization: 0 } },
  ink:  { shape: { kind: "round", hardness: 0.5 }, taper: { in: 0.5, out: 0 },
          sizeCoeff: 0.95, opaCoeff: 0, flowCoeff: 0, pressureGamma: 0.5, pressureLPF: 50,
          compositeMode: "wash", spacing: 0.06, smooth: { streamline: 0.5, stabilization: 0.5 } },
  pixel: { shape: { kind: "round", hardness: 1 }, taper: { in: 0, out: 0 },
          sizeCoeff: 0, opaCoeff: 0, flowCoeff: 0, pressureGamma: 1, pressureLPF: 0,
          compositeMode: "wash", spacing: 0.5, smooth: { streamline: 0, stabilization: 0 } },
};

export function resolveSelPenBrush(variant: SelPenVariant, size: number): ResolvedBrush {
  const v: SelPenVariant = PRESETS[variant] ? variant : "hard";
  const max = SEL_PEN_SIZE_MAX[v];
  const s = Math.max(1, Math.min(max, Math.round(size) || SEL_PEN_DEFAULT_SIZE[v]));
  return resolveBrush({ preset: PRESETS[v] as ResolveBrushArgs["preset"], size: s, opacity: 0.5, color: SEL_PEN_BAND });
}

/**
 * stamps → 二值 gray8 bbox 平面（像素变体主路径 + GL 不可用回退）。
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
