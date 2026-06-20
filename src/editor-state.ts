// EditorState —— 编辑器「当前设成什么样」的反应式 RAM SSoT（**纯内存**，无持久化职责）。
//
// 单一职责：构造并返回编辑器当前设置的单一真源——主色、每工具 dial（size/opacity/flow/activeBrushId）、
//   全局压感开关、棋盘/长按吸色等开关、filterBrush 瞬态。从 localStorage 种子（记住上次粗细/透/色），
//   但**不**负责落盘：ORA 存档由 session-state 的 _buildOraMeta 读这里的 state.color/toolStates/checkerboard
//   （per-doc 跟文件走），LS 种子只是 boot 兜底。删了这个模块，这套 reactive proxy + LS 种子逻辑会原样
//   回到 app 的 comp-root 中段——它聚的是「编辑器 RAM 态怎么建、怎么反应式」这一处知识。
//
// 不做：当前笔派生（currentBrush computed 在 app，依赖 rack/engine = 组合接线）；工具/transient 相位
//   （editMode）；面板（panel-state）；视口（board，从不进 ORA）。故意不造中央 EditorState god-object——
//   各轴各自反应式，这里只收「dial + 全局开关」这一束。
//
// 反应式桥：color / pressureTo* 用 defineProperty 代理回 dialReactive —— app 里 state.color /
//   state.pressureTo* 的读写零改动，背后是反应式（Vue 组件 computed 自动追踪 → 当前笔重派生）。

import { reactive } from "../vendor/vue/vue.esm-browser.prod.js";
import { safeLS } from "./safe-ls.ts";
import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";

// 编辑器 RAM 态的形状契约见 AppContext（EditorRuntimeState / DialReactive）——本模块是其唯一构造者。
export type EditorState = EditorRuntimeState;

export function createEditorState(): { state: EditorRuntimeState; dialReactive: DialReactive } {
  // state.toolStates：per-tool 持久化（per-doc）。当前笔 = currentBrush computed（在 app）从这束 dial 纯派生。
  // shapes/airbrush **不**自己存——alias 到 brush（见 rack.getRackToolKey）。v98：{ size, opacity, flow, activeBrushId }。
  // reactive：dial 是反应式 SSoT。先建 toolStates → 让 state 字面量一次成形、整体类型化（序列化走 JSON.stringify 无碍）。
  const toolStates: Record<string, ToolDial> = reactive({
    // brush 的 boot dial 从 LS 兜底（保留「记住上次粗细/透」；rack/doc 载入后被 preset/ORA toolStates 覆盖）。
    brush:    { size: parseFloat(safeLS("webpaint.size") || "12"), opacity: parseFloat(safeLS("webpaint.opacity") || "1"), flow: 1.0, activeBrushId: null },
    eraser:   { size: 32, opacity: 0.6, flow: 1.0, activeBrushId: null },
    // v132：size=radius，opacity=transparency/flow，variantId=子算法选择（Filter.brushVariants[].id），空=默认
    filterBrush: { size: 32, opacity: 1.0, flow: 1.0, activeBrushId: null, variantId: null },
  });

  const state: EditorRuntimeState = {
    // tool（当前工具）的 SSoT 在 editMode（editMode.current()）。见 edit-mode.js / CONTEXT.md。
    // v132 filter brush 激活时 = { Filter, params, variantLabel }；空闲 = null
    filterBrush: null,
    color: safeLS("webpaint.color") || "#1b1b1b",
    // 全局（非 per-tool）压感开关。boot 读 LS（v202 修：旧版写 pToSize 从不读回）。未设过→DEFAULT(开)；"0"→关。
    pressureToSize: safeLS("webpaint.pToSize") !== "0",
    pressureToOpacity: safeLS("webpaint.pToOpacity") !== "0",
    longPressPick: safeLS("webpaint.longPressPick") === "1", // 默认关，user 担心误触
    singleFingerDraw: safeLS("webpaint.singleFingerDraw") === "1",  // 默认关——用户要单指默认不作画
    pickMode: safeLS("webpaint.pickMode") || "composite",  // 吸色取样：composite(合并·respect clip+mode) | layer(raw 色)
    // v125 checkerboard 从全局 LS 改 per-doc（跟文件走）。初始 false；adopt 时按文件值覆盖；新建默认 false。
    checkerboard: false,
    toolStates,
  };

  // 反应式 dial SSoT 的其余轴：color / 压感开关 / 当前工具 / 笔架版本 / canDraw。
  const dialReactive: DialReactive = reactive({
    tool: "brush",                 // 镜像 editMode.current()（含 transient）；_syncEditModeUI 同步
    color: state.color,
    pressureToSize: state.pressureToSize,
    pressureToOpacity: state.pressureToOpacity,
    rackVersion: 0,                // 笔架内容改了（编辑保存/重置）bump，让 computed 重算活动预设
    canDraw: true,                 // 镜像 editMode.canDraw()；_syncEditModeUI 同步 → <LeftDial> 滑块 disabled
  });
  // color / 压感读写代理回 dialReactive（app 里 state.color / state.pressureTo* 零改动，背后反应式）。
  // 逐属性显式 defineProperty（避免循环里 keyof 联合的赋值摩擦）。
  Object.defineProperty(state, "color", {
    get: () => dialReactive.color, set: (v: string) => { dialReactive.color = v; },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(state, "pressureToSize", {
    get: () => dialReactive.pressureToSize, set: (v: boolean) => { dialReactive.pressureToSize = v; },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(state, "pressureToOpacity", {
    get: () => dialReactive.pressureToOpacity, set: (v: boolean) => { dialReactive.pressureToOpacity = v; },
    configurable: true, enumerable: true,
  });

  return { state, dialReactive };
}

// 把存档的 per-tool dial（ORA _webpaintState.toolStates[tool]）按 v98 兼容映射成 patch 对象，
// caller Object.assign 到 reactive toolStates[tool]（保留反应式）。saved 无效 → null（不动）。
// 反序列化细节下沉到 editor-state（toolState 形状的所有者；survey rec #5 part b）：
//   v98 起 opacity/flow 分离——老 doc 只有 .intensity 当 opacity；只有 flow 没 opacity 时 flow 也当 opacity。
export function serializedToolStatePatch(current: ToolDial, saved: unknown): Partial<ToolDial> | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Record<string, unknown>;
  const op = typeof s.opacity === "number" ? s.opacity
           : typeof s.intensity === "number" ? s.intensity
           : typeof s.flow === "number" ? s.flow
           : current.opacity;
  const fl = typeof s.flow === "number" && typeof s.opacity === "number" ? s.flow
           : current.flow;
  return {
    size: typeof s.size === "number" ? s.size : current.size,
    opacity: op,
    flow: fl,
    activeBrushId: typeof s.activeBrushId === "string" ? s.activeBrushId : current.activeBrushId,
    activeBrushName: typeof s.activeBrushName === "string" ? s.activeBrushName : current.activeBrushName,
    // v132 filterBrush 多 variantId
    ...(typeof s.variantId === "string" ? { variantId: s.variantId } : {}),
  };
}
