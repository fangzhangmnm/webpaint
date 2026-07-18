// 当前笔（ResolvedBrush）—— drawing engine 唯一吃的**不可变值**。
//
// 设计（2026-06-08 grill，candidate 3 / docs/reports/20260608-ui-deepening-and-plugin-survey.html）：
//   旧路径里「当前笔」是一个**可变单例** state.brush（BrushSettings），由 applyBrushPresetFrozen
//   + applyToolState + syncBrushColor 三处**原地改**，引擎按引用持有。这把「rack⟂engine」留成约定。
//
//   现在收敛成：当前笔 = 从 SSoT 纯函数派生、**整体替换**的 frozen 值。
//     SSoT = ① 笔架预设（冻结字段）② per-tool dial（size/opacity，toolState）
//            ③ 全局色 ④ 全局压感开关。
//   引擎只读这个值；frozen 让任何回写**响亮失败**而非静默污染。
//
//   mental model（user）：**没有笔架时，console 设一下工具也能画**——所以 preset=null 时
//   这里用 DEFAULT_CONFIG 兜底出一个完整可画的笔。rack 只是 ResolvedBrush 的**生产者之一**。
//
// 纯模块：无 DOM / 无 IDB / 无 cloud。可 node 直测（test/resolved-brush.test.mjs）。

import { DEFAULT_CONFIG } from "./current-brush-config.ts";
import { computed } from "../vendor/vue/vue.esm-browser.prod.js";
import type { EditorRuntimeState, DialReactive } from "./app-context.ts";
import type { BrushRackController } from "./brush-rack-controller.ts";

// 笔架里的一把预设（黑盒；只读这里用到的字段）。
export interface BrushPreset {
  shape?: { kind?: string; aspect?: number; rotation?: number; hardness?: number };
  taper?: { in?: number; out?: number };
  taperFloor?: number;                 // 平铺（对齐 BrushDraft / collection 里 Brush 的存法，别写成 taper.floor）
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
}

// 引擎吃的扁平笔（不可变值，引擎只读）。字段集 = DEFAULT_CONFIG 全集；index 签名兜住本模块不显式列举的默认字段。
export interface ResolvedBrush {
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
  taperFloor: number;
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
  [k: string]: unknown;
}

export interface ResolveBrushArgs {
  preset?: BrushPreset | null;
  size?: number;
  opacity?: number;
  color?: string;
}

// 从 SSoT 解析出当前笔。**等价于旧 applyBrushPresetFrozen ⊕ applyToolState ⊕ syncBrushColor**，
// 但输出是 Object.freeze 的新值（绝不复用/原地改）。
//   preset：活动预设；null = 无笔架，走 DEFAULT 兜底。
//   size/opacity：per-tool dial（toolState）；缺省保留 DEFAULT。flow 无 dial（见下）。
//   color：全局色（#rrggbb）。
//   压感→尺寸/透明的**每笔**开关就是 sizeCoeff / opaCoeff（-1..1，0=不响应压感）——有 UI（ui/brush-settings）、
//   随笔架持久化、brush.ts 的 signedLerp 真在算。v409 删了同语义的冗余影子字段 pressureToSize/pressureToOpacity：
//   它们从 preset 读进 ResolvedBrush 后**零消费方**（没 UI 写、没引擎读、builtin-brushes.json 也没这键）。
//   要"关掉压感对粗细的影响"就把 sizeCoeff 设 0，别再引入第二个开关。
export function resolveBrush({
  preset = null, size, opacity, color,
}: ResolveBrushArgs = {}): ResolvedBrush {
  // base = 引擎默认全集。
  // DEFAULT_CONFIG 来自 current-brush-config.ts（纯数据契约）——在此唯一的领域接缝处断言其形状。
  const b = { ...(DEFAULT_CONFIG as Record<string, unknown>) } as ResolvedBrush;

  if (preset) {
    // —— 预设冻结字段（逐字段映射，?? 默认值与旧 applyBrushPresetFrozen 逐字对齐）——
    const sh = preset.shape || {};
    b.shapeKind     = sh.kind || "round";
    b.shapeAspect   = sh.aspect ?? 1.0;
    b.shapeRotation = (sh.rotation ?? 0) * Math.PI / 180;   // 度 → 弧度
    b.hardness      = sh.hardness ?? 0.75;   // 四处默认统一 0.75（v415；此前 DEFAULT_CONFIG 0.75 vs 这里/ensure 1.0）
    const tp = preset.taper || {};
    b.taperIn       = tp.in ?? 0;   // taper 纯 stylistic·per-preset，默认 0（无「硬件 taper」概念）
    b.taperOut      = tp.out ?? 0;
    // taperFloor：taper 包络的最小压感系数。v415 前 BrushPreset 根本没这字段、resolveBrush 也不映射
    //   → 引擎恒读 DEFAULT_CONFIG 的常量 0.4，draft 存进 collection 的 per-brush 值被整个丢弃（真悬空）。
    //   ⚠ 存法是**平铺** b.taperFloor（ensureBrushConfigDefaults 就写这儿），不是 taper.floor。
    b.taperFloor    = preset.taperFloor ?? 0.4;
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
  }

  // —— 用户旋钮 + 全局色（缺省 = 保留 base 默认）。压感开关不再是全局参数（见上，每笔）——
  if (size              != null) b.size              = size;
  if (opacity           != null) b.opacity           = opacity;
  if (color             != null) b.color             = color;
  // flow 没有 dial：它恒为 DEFAULT_CONFIG.flow(=1.0)，压感对流量的影响全靠 per-preset 的 flowCoeff。
  //   （user 早有决定：「默认 opacity 默认 flow 两个字段不要，都是 1」——见 brushes.ts 顶部。
  //    v415 前 toolStates 里那个 flow 被四处钉死 1.0、无滑块、无 preset 来源 = 纯摆设，已删。）

  return Object.freeze(b);
}

// ——「当前笔」反应式派生 + 引擎桥（从组合根 app.js 下沉，survey rec #3）——
//
// currentBrush = Vue computed，把 4 个反应式 SSoT 装配成引擎唯一吃的不可变 ResolvedBrush：
//   ① 当前工具 dial（toolStates：size/opacity，per-doc reactive）
//   ② 活动预设（笔架：findToolBrushPure 读 controller 的 shallowRef 镜像 → 依赖自动建立）③ 全局 color
// **手感数学全在 resolveBrush（上方），这里只装配、不碰任何公式/时间常数。**
// 引擎只读 currentBrush.value（stroke begin 时取，非每 stamp）。
//
// 接线风险（boot-smoke 抓不到、本模块的 node 测专门守）：依赖集漏一个 → 改 dial/color/预设
// 笔不更新（「功能不响应」级 bug，非手感漂移）。故 current-brush.test.mjs 验「改 dep → currentBrush 重算」。
// （旧的 bindEngine→invalidateStamp 引擎桥已删：stamp 缓存随 GPU 栅格归档，无缓存可作废。）

interface CurrentBrushDeps { state: EditorRuntimeState; dialReactive: DialReactive; rack: BrushRackController; }

export function makeCurrentBrush({ state, dialReactive, rack }: CurrentBrushDeps) {
  // **必须纯**：computed 内不写 toolStates（GUID healing 回写用 findToolBrushPure 的纯版；写回留显式路径）。
  const currentBrush = computed(() => {
    const ts = state.toolStates[rack.getRackToolKey(dialReactive.tool)] || state.toolStates.brush;
    const preset = rack.findToolBrushPure(ts);   // 无笔架 → null → DEFAULT 兜底
    return resolveBrush({
      // 同一运行时 brush 对象的两个视图：rack 存的是完整 Brush，resolveBrush 只读 BrushPreset 子集。
      preset: preset as BrushPreset | null,
      size: ts.size, opacity: ts.opacity ?? 1.0,
      color: state.color,
      // 压感开关不再全局传入（2026-07-14 deprecate）——每笔自带（resolveBrush 从 preset 取，缺则 DEFAULT true）。
    });
  });

  return { currentBrush };
}
