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

import { DEFAULT_SETTINGS } from "./brush.ts";

// 笔架里的一把预设（黑盒；只读这里用到的字段）。
export interface BrushPreset {
  shape?: { kind?: string; aspect?: number; rotation?: number; hardness?: number };
  taper?: { in?: number; out?: number };
  sizeCoeff?: number;
  opaCoeff?: number;
  flowCoeff?: number;
  pressureGamma?: number;
  pressureLPF?: number;
  compositeMode?: string;
  blendMode?: string;
  spacing?: number | { value?: number };
  pixelMode?: boolean;
  smooth?: { streamline?: number; stabilization?: number };
  pressureToSize?: boolean;      // 2026-07-14：压感→尺寸/透明 从全局开关 deprecate 成**每笔**（缺=DEFAULT true）；per-brush UI 下一轮
  pressureToOpacity?: boolean;
}

// 引擎吃的扁平笔。字段集 = DEFAULT_SETTINGS 全集；index 签名兜住本模块不显式列举的默认字段
// （type / taperFloor 等旧 applyBrushPresetFrozen 不碰、但 spread 保留下来的）。
export interface BrushSettings {
  size: number;
  opacity: number;
  flow: number;
  color: string;
  shapeKind: string;
  shapeAspect: number;
  shapeRotation: number;
  hardness: number;
  taperIn: number;
  taperOut: number;
  sizeCoeff: number;
  opaCoeff: number;
  flowCoeff: number;
  pressureGamma: number;
  pressureLPF: number;
  compositeMode: string;
  blendMode: string;
  spacing: number;
  pixelMode: boolean;
  streamline: number;
  stabilization: number;
  pressureToSize: boolean;
  pressureToOpacity: boolean;
  [k: string]: unknown;
}

// 引擎只读这个不可变值。
export type ResolvedBrush = Readonly<BrushSettings>;

export interface ResolveBrushArgs {
  preset?: BrushPreset | null;
  size?: number;
  opacity?: number;
  flow?: number;
  color?: string;
}

// 从 SSoT 解析出当前笔。**等价于旧 applyBrushPresetFrozen ⊕ applyToolState ⊕ syncBrushColor**，
// 但输出是 Object.freeze 的新值（绝不复用/原地改）。
//   preset：活动预设；null = 无笔架，走 DEFAULT 兜底。
//   size/opacity/flow：per-tool dial（toolState）；缺省保留 DEFAULT。
//   color：全局色（#rrggbb）。压感开关 pressureToSize/pressureToOpacity = **每笔**（preset 带则用，缺则 DEFAULT true）。
export function resolveBrush({
  preset = null, size, opacity, flow, color,
}: ResolveBrushArgs = {}): ResolvedBrush {
  // base = 引擎默认全集（type / taperFloor 等旧 applyBrushPresetFrozen 不碰的字段一并保留）。
  // DEFAULT_SETTINGS 来自未类型化的 brush.js（手感红区，本轮不迁）——在此唯一的领域接缝处断言其形状。
  const b = { ...(DEFAULT_SETTINGS as Record<string, unknown>) } as BrushSettings;

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
    // 压感开关 = **每笔**（2026-07-14 deprecate 全局）：preset 带则用，缺则保留 DEFAULT（true）。
    if (preset.pressureToSize    != null) b.pressureToSize    = !!preset.pressureToSize;
    if (preset.pressureToOpacity != null) b.pressureToOpacity = !!preset.pressureToOpacity;
  }

  // —— 用户旋钮 + 全局色（缺省 = 保留 base 默认）。压感开关不再是全局参数（见上，每笔）——
  if (size              != null) b.size              = size;
  if (opacity           != null) b.opacity           = opacity;
  if (flow              != null) b.flow              = flow;
  if (color             != null) b.color             = color;

  return Object.freeze(b);
}
