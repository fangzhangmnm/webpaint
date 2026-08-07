import type { ResolvedBrush } from "./resolved-brush.ts";
/** 预览色带颜色（仅视觉反馈；选区结果与色无关，半透明由 opacity=0.5 提供） */
export declare const SEL_PEN_BAND = "#3b82f6";
/**
 * 笔架当前笔 → 选区笔描边态：色带覆写 + pixelMode 压平（动力学 buffered 同源；
 * 原 pixelMode 由 input 侧记住，抬笔改走 Bresenham disc 字节核——像素手感的精确落纸）。
 */
export declare function selPenSettingsFrom(base: ResolvedBrush): ResolvedBrush;
/**
 * stamps → 二值 gray8 bbox 平面（像素笔抬笔主路径 + GL 不可用回退）。
 * disc = 引擎的 Bresenham 圆盘字节核（BrushEngine.pixelDiscInto 注入——与像素笔同一核，
 * 不产生第二份圆栅格实现）。落格/尺寸取整逐字对齐 brush.ts stampPixels。
 */
export declare function stampsToBinaryGray8(stamps: Array<{
    x: number;
    y: number;
    size: number;
    alpha: number;
}>, bx: number, by: number, bw: number, bh: number, disc: (buf: Uint8ClampedArray, rw: number, rh: number, ox: number, oy: number, ix: number, iy: number, intSize: number) => void): Uint8Array;
