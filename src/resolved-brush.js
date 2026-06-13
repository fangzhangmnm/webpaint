// @ts-check
// 当前笔（ResolvedBrush）—— drawing engine 唯一吃的**不可变值**。
//
// 设计（2026-06-08 grill，candidate 3 / docs/reports/20260608-ui-deepening-and-plugin-survey.html）：
//   旧路径里「当前笔」是一个**可变单例** state.brush（BrushSettings），由 applyBrushPresetFrozen
//   + applyToolState + syncBrushColor 三处**原地改**，引擎按引用持有。这把「rack⟂engine」留成约定。
//
//   现在收敛成：当前笔 = 从 SSoT 纯函数派生、**整体替换**的 frozen 值。
//     SSoT = ① 笔架预设（冻结字段）② per-tool dial（size/opacity/flow，toolState）
//            ③ 全局色 ④ 全局压感开关。
//   引擎只读这个值；frozen 让任何回写**响亮失败**而非静默污染。
//
//   mental model（user）：**没有笔架时，console 设一下工具也能画**——所以 preset=null 时
//   这里用 DEFAULT_SETTINGS 兜底出一个完整可画的笔。rack 只是 ResolvedBrush 的**生产者之一**。
//
// 纯模块：无 DOM / 无 IDB / 无 cloud。可 node 直测（test/resolved-brush.test.mjs）。

import { DEFAULT_SETTINGS } from "./brush.js";

/**
 * @typedef {Object} BrushPreset 笔架里的一把预设（黑盒；只读这里用到的字段）。
 * @property {{kind?:string, aspect?:number, rotation?:number, hardness?:number}} [shape]
 * @property {{in?:number, out?:number}} [taper]
 * @property {number} [sizeCoeff] @property {number} [opaCoeff] @property {number} [flowCoeff]
 * @property {number} [pressureGamma] @property {number} [pressureLPF]
 * @property {string} [compositeMode] @property {string} [blendMode]
 * @property {number|{value?:number}} [spacing] @property {boolean} [pixelMode]
 * @property {{streamline?:number, stabilization?:number}} [smooth]
 * @property {{strength?:number, dryness?:number}} [smudge]
 */

/**
 * @typedef {Readonly<Object>} ResolvedBrush
 *   引擎吃的扁平不可变笔。字段集 = DEFAULT_SETTINGS 全集（size, opacity, flow, color,
 *   shape 字段, 各 coeff, spacing, compositeMode, blendMode, pixelMode, smooth 四件套,
 *   taper 段, smudge 段, pressureToSize, pressureToOpacity）。
 */

/**
 * 从 SSoT 解析出当前笔。**等价于旧 applyBrushPresetFrozen ⊕ applyToolState ⊕ syncBrushColor**，
 * 但输出是 Object.freeze 的新值（绝不复用/原地改）。
 *
 * @param {Object} [args]
 * @param {BrushPreset|null} [args.preset] 活动预设；null = 无笔架，走 DEFAULT 兜底。
 * @param {number} [args.size] per-tool dial（toolState.size）。缺省保留 DEFAULT。
 * @param {number} [args.opacity] @param {number} [args.flow]
 * @param {string} [args.color] 全局色（#rrggbb）。
 * @param {boolean} [args.pressureToSize] @param {boolean} [args.pressureToOpacity] 全局开关。
 * @returns {ResolvedBrush}
 */
export function resolveBrush({
  preset = null, size, opacity, flow, color, pressureToSize, pressureToOpacity,
} = {}) {
  // base = 引擎默认全集（type / taperFloor 等旧 applyBrushPresetFrozen 不碰的字段一并保留）。
  const b = { ...DEFAULT_SETTINGS };

  if (preset) {
    // —— 预设冻结字段（逐字段映射，?? 默认值与旧 applyBrushPresetFrozen 逐字对齐）——
    const sh = preset.shape || {};
    b.shapeKind     = sh.kind || "round";
    b.shapeAspect   = sh.aspect ?? 1.0;
    b.shapeRotation = (sh.rotation ?? 0) * Math.PI / 180;   // 度 → 弧度
    b.hardness      = sh.hardness ?? 1.0;
    const tp = preset.taper || {};
    b.taperIn       = tp.in ?? 0;   // taper 纯 stylistic·per-preset，默认 0（无「硬件 taper」概念）
    b.taperOut      = tp.out ?? 0;
    b.sizeCoeff     = preset.sizeCoeff ?? 0.6;
    b.opaCoeff      = preset.opaCoeff ?? 0.6;
    b.flowCoeff     = preset.flowCoeff ?? 0;
    b.pressureGamma = preset.pressureGamma ?? 1.0;
    b.pressureLPF   = preset.pressureLPF ?? 50;
    b.compositeMode = preset.compositeMode || "wash";
    b.blendMode     = preset.blendMode || "source-over";
    b.spacing       = (typeof preset.spacing === "number")
      ? preset.spacing
      : (preset.spacing?.value ?? 0.06);
    b.pixelMode     = !!preset.pixelMode;
    const sm = preset.smooth || {};
    b.streamline    = sm.streamline    ?? 0.15;
    b.stabilization = sm.stabilization ?? 0;
    if (preset.smudge) {
      b.smudgeStrength = preset.smudge.strength ?? 0.8;
      b.smudgeDryness  = preset.smudge.dryness  ?? 0.1;
    }
  }

  // —— 用户旋钮 + 全局色 + 全局压感（缺省 = 保留 base 默认）——
  if (size              != null) b.size              = size;
  if (opacity           != null) b.opacity           = opacity;
  if (flow              != null) b.flow              = flow;
  if (color             != null) b.color             = color;
  if (pressureToSize    != null) b.pressureToSize    = !!pressureToSize;
  if (pressureToOpacity != null) b.pressureToOpacity = !!pressureToOpacity;

  return Object.freeze(b);
}
