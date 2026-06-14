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

export interface EditorState {
  state: any;
  dialReactive: any;
}

export function createEditorState(): EditorState {
  const state: any = {
    // tool（当前工具）的 SSoT 在 editMode（editMode.current()）。见 edit-mode.js / CONTEXT.md。
    // v132 filter brush 激活时 = { Filter, params, variantLabel }；空闲 = null
    filterBrush: null,
    color: safeLS("webpaint.color") || "#1b1b1b",
    // 旧 state.brush（可变 BrushSettings 单例）已收敛成不可变 ResolvedBrush（currentBrush computed，
    //   从反应式 SSoT 纯派生）。当前笔的 SSoT = toolStates(dial) + 预设 + color + 下面两个全局压感开关。
    // 全局（非 per-tool）压感开关。boot 读 LS（v202 修原始 bug：旧版写 webpaint.pToSize 从不读回 → 重载弹回默认）。
    //   未设过 → DEFAULT(开)；显式 "0" → 关。applyPressureSize/Opacity 仍按 toggle 写 LS。
    pressureToSize: safeLS("webpaint.pToSize") !== "0",
    pressureToOpacity: safeLS("webpaint.pToOpacity") !== "0",
    longPressPick: safeLS("webpaint.longPressPick") === "1", // 默认关，user 担心误触
    singleFingerDraw: safeLS("webpaint.singleFingerDraw") === "1",  // 默认关——用户要单指默认不作画
    // v125 (user：「透明背景显示棋盘这个设置跟文件走」)
    //   checkerboard 从全局 LS 改 per-doc：保存在 webpaint/state.json，跟文件走。
    //   初始 false；adoptLoadedDoc 时按文件值覆盖；新建 doc 默认 false
    checkerboard: false,
    // 注：液化设置不在这里——液化 v132 migrate 进 filterBrush，mode=variant 下拉、size/strength=左栏 slider。
  };

  // state.toolStates：per-tool 持久化（per-doc）。当前笔 = currentBrush computed（在 app）从这束 dial 纯派生。
  // shapes/airbrush **不**自己存——alias 到 brush（见 rack.getRackToolKey）。
  // v98：toolStates { size, opacity, flow, activeBrushId }；opacity=左栏 slider2（透），flow=笔设里调。
  // reactive：dial 是反应式 SSoT（candidate 1）。任何 dial 改动自动重派生当前笔。
  // 序列化安全：ORA 走 JSON.stringify（ora.js），透读 reactive 代理无碍（非 structuredClone）。
  state.toolStates = reactive({
    // brush 的 boot dial 从 LS 兜底（保留「记住上次粗细/透」；rack/doc 载入后被 preset/ORA toolStates 覆盖）。
    brush:    { size: parseFloat(safeLS("webpaint.size") || "12"), opacity: parseFloat(safeLS("webpaint.opacity") || "1"), flow: 1.0, activeBrushId: null },
    smudge:   { size: 16, opacity: 1.0, flow: 0.8, activeBrushId: null },
    eraser:   { size: 32, opacity: 0.6, flow: 1.0, activeBrushId: null },
    // v132：size=radius，opacity=transparency/flow，variantId=子算法选择（Filter.brushVariants[].id），空=默认
    filterBrush: { size: 32, opacity: 1.0, flow: 1.0, activeBrushId: null, variantId: null },
  });

  // 反应式 dial SSoT 的其余轴：color / 压感开关 / 当前工具 / 笔架版本 / canDraw。
  const dialReactive = reactive({
    tool: "brush",                 // 镜像 editMode.current()（含 transient）；_syncEditModeUI 同步
    color: state.color,
    pressureToSize: state.pressureToSize,
    pressureToOpacity: state.pressureToOpacity,
    rackVersion: 0,                // 笔架内容改了（编辑保存/重置）bump，让 computed 重算活动预设
    canDraw: true,                 // 镜像 editMode.canDraw()；_syncEditModeUI 同步 → <LeftDial> 滑块 disabled
  });
  // color / 压感读写代理回 dialReactive（app 里 state.color / state.pressureTo* 零改动，背后反应式）。
  for (const _k of ["color", "pressureToSize", "pressureToOpacity"]) {
    Object.defineProperty(state, _k, {
      get: () => dialReactive[_k], set: (v) => { dialReactive[_k] = v; },
      configurable: true, enumerable: true,
    });
  }

  return { state, dialReactive };
}

// 把存档的 per-tool dial（ORA _webpaintState.toolStates[tool]）按 v98 兼容映射成 patch 对象，
// caller Object.assign 到 reactive toolStates[tool]（保留反应式）。saved 无效 → null（不动）。
// 反序列化细节下沉到 editor-state（toolState 形状的所有者；survey rec #5 part b）：
//   v98 起 opacity/flow 分离——老 doc 只有 .intensity 当 opacity；只有 flow 没 opacity 时 flow 也当 opacity。
export function serializedToolStatePatch(current: any, saved: any): any | null {
  if (!saved || typeof saved !== "object") return null;
  const op = typeof saved.opacity === "number" ? saved.opacity
           : typeof saved.intensity === "number" ? saved.intensity
           : typeof saved.flow === "number" ? saved.flow
           : current.opacity;
  const fl = typeof saved.flow === "number" && typeof saved.opacity === "number" ? saved.flow
           : current.flow;
  return {
    size: typeof saved.size === "number" ? saved.size : current.size,
    opacity: op,
    flow: fl,
    activeBrushId: typeof saved.activeBrushId === "string" ? saved.activeBrushId : current.activeBrushId,
    activeBrushName: typeof saved.activeBrushName === "string" ? saved.activeBrushName : current.activeBrushName,
    // v132 filterBrush 多 variantId
    ...(typeof saved.variantId === "string" ? { variantId: saved.variantId } : {}),
  };
}
