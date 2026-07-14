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
import { syncedUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";   // 手势开关 = 跨设备偏好
import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";

// 编辑器 RAM 态的形状契约见 AppContext（EditorRuntimeState / DialReactive）——本模块是其唯一构造者。
export type EditorState = EditorRuntimeState;

export function createEditorState(): { state: EditorRuntimeState; dialReactive: DialReactive } {
  // state.toolStates：per-tool 持久化（per-doc）。当前笔 = currentBrush computed（在 app）从这束 dial 纯派生。
  // shapes/airbrush **不**自己存——alias 到 brush（见 rack.getRackToolKey）。v98：{ size, opacity, flow, activeBrushId }。
  // reactive：dial 是反应式 SSoT。先建 toolStates → 让 state 字面量一次成形、整体类型化（序列化走 JSON.stringify 无碍）。
  const toolStates: Record<string, ToolDial> = reactive({
    // brush dial 默认（size/opacity/brushId 归 editorState.brushTool SSoT，boot 后 bindEditorReactive 灌入、doc 载入覆盖；
    //   不再从 LS 种子——desk per-doc，删了 webpaint.size/opacity 设备记忆）。flow 未进 editorState（留下一轮）。
    brush:    { size: 12, opacity: 1.0, flow: 1.0, activeBrushId: null },
    eraser:   { size: 32, opacity: 0.6, flow: 1.0, activeBrushId: null },
    // v132：size=radius，opacity=transparency/flow，variantId=子算法选择（Filter.brushVariants[].id），空=默认
    filterBrush: { size: 32, opacity: 1.0, flow: 1.0, activeBrushId: null, variantId: null },
  });

  const state: EditorRuntimeState = {
    // tool（当前工具）的 SSoT 在 editMode（editMode.current()）。见 edit-mode.js / CONTEXT.md。
    // v132 filter brush 激活时 = { Filter, params, variantLabel }；空闲 = null
    filterBrush: null,
    color: "#1b1b1b",   // 归 editorState.brushTool.color SSoT（boot bind 灌入 / doc 载入覆盖）；删 webpaint.color LS 种子
    // 全局（非 per-tool）压感开关。boot 读 LS（v202 修：旧版写 pToSize 从不读回）。未设过→DEFAULT(开)；"0"→关。
    pressureToSize: safeLS("webpaint.pToSize") !== "0",
    pressureToOpacity: safeLS("webpaint.pToOpacity") !== "0",
    // 手势开关 = 跨设备偏好（synced-user-preference collection；createEditorState 在 boot 门后调，已 hydrate）。
    longPressPick: syncedUserPreference.getItem<boolean>("long-press-pick", PREF_DEFAULTS["long-press-pick"]),
    singleFingerDraw: syncedUserPreference.getItem<boolean>("single-finger-draw", PREF_DEFAULTS["single-finger-draw"]),
    pickMode: "composite",  // 吸色取样 composite|layer；归 editorState.colorPicker.layerMode SSoT（bind 灌入/载入覆盖）；删 webpaint.pickMode LS
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

  // editorState.brushTool / colorPicker.layerMode 绑到反应式引擎态（引擎不改；editorState 作 SSoT 接口）。
  //   绑定即把 editorState 当前 S.g（默认，或 boot 前已 Unserialize 的值）灌进这些 reactive 字段，二者对齐。
  bindEditorReactive({
    getSize: () => toolStates.brush.size ?? 12, setSize: (v) => { toolStates.brush.size = v; },
    getOpacity: () => toolStates.brush.opacity ?? 1.0, setOpacity: (v) => { toolStates.brush.opacity = v; },
    getBrushId: () => toolStates.brush.activeBrushId ?? null, setBrushId: (v) => { toolStates.brush.activeBrushId = v; },
    getColor: () => dialReactive.color, setColor: (v) => { dialReactive.color = v; },
    getPickMode: () => state.pickMode, setPickMode: (v) => { state.pickMode = v; },
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

// ═══════════════════════════════════════════════════════════════════════════════════════
// EditorState struct —— per-doc「desk」的 Hot RAM SSoT + 序列化（2026-07-14）
// ═══════════════════════════════════════════════════════════════════════════════════════
// 「一个 project 就是一个 desk」：editor-state = 跟文档走的编辑器桌面态（面板/导入导出/工具参数/视口/棋盘）。
//   用法像 struct：`editorState.colorPanel.position = {left,top}`（代码热路径）。
//   **永远 Hot、不自动推**；除各字段外只有 Serialize()/Unserialize()/reset()（+ workspaceDirty 读/清）。
//   所有 setter 经 private setDirtyFlag() → workspaceDirty（smart-save：UI 静默但可点、push 非 no-op）。
//   开新文件必 reset()。序列化进 ora 的 `.webpaint/editor-state.json`（stage4 接线）。
//
// ⚠stage3 = **骨架**：字段默认自持、Serialize/Unserialize/reset/dirty 就绪并 node 可测；
//   各模块（color-panel/reference/blender/export/liquify/toolbar/board…）read/write 迁进本 struct
//   + 删设备级 localStorage + 折叠上面 createEditorState 的 dial/color 进 brushTool —— 全留 **stage5**。
//   在 stage5 接线前，本 struct 不被任何模块驱动（setter 无人调 → workspaceDirty 恒 false → save 行为不变）。
//
// setter 纪律（同 collection 浅拷贝）：整枝赋值 position/viewport（`x.position = {...}`），
//   别原地改子对象字段（`x.position.left = 1` 不 mark dirty）。

export interface PanelPos { left: number; top: number; width?: number; height?: number }
export interface EditorViewport { tx: number; ty: number; scale: number; rot: number }

// 序列化形状 = `.webpaint/editor-state.json` 的内容（freshGroups() 即 defaults SSoT）。
function freshGroups() {
  return {
    import:        { source: "file" as string },                                   // "file" | "clipboard"
    export:        { format: "png" as string, target: "file" as string, layerMode: "merged" as string },   // layerMode=scope "merged"|"active"
    exportProject: { format: "ora" as string },                                    // "ora" | "psd"
    colorPanel:    { enabled: false, position: null as PanelPos | null },
    layersPanel:   { enabled: false, position: null as PanelPos | null },
    refPanel:      { enabled: false, position: null as PanelPos | null, viewport: { tx: 0, ty: 0, scale: 1, rot: 0 } as EditorViewport },
    blenderPanel:  { show: false, position: null as PanelPos | null },
    brushTool:     { brushId: null as string | null, size: 12, opacity: 1, color: "#1b1b1b" },
    liquify:       { bleed: "edge" as string },
    colorPicker:   { layerMode: "composite" as string },                           // pick-mode: "composite" | "layer"
    viewport:      null as EditorViewport | null,
    checkboard:    false,
  };
}
export type EditorGroups = ReturnType<typeof freshGroups>;

// ── 私有可变态 + dirty ─────────────────────────────────────────────────────────────────
const S = { g: freshGroups() };       // mutable holder（reset 时整份换，访问器每次 deref S.g → reset 生效）
let _workspaceDirty = false;
let _onDirty: (() => void) | null = null;   // 可选外部通知钩子（如触发 UI 重算）；stage4 接 smart-save
function setDirtyFlag(): void { _workspaceDirty = true; _onDirty?.(); }   // private：所有 setter 接它

// ── 反应式引擎绑定（stage5）：brushTool(size/opacity/brushId/color) + colorPicker.layerMode 是引擎**每笔读**的
//   反应式态。editorState 作 SSoT 接口，底层存储绑到 createEditorState 的 reactive state —— 引擎一行不改、
//   Vue 反应式不断（改 editorState.brushTool.size 直接写 reactive → currentBrush 重算 + workspaceDirty）。
//   未绑定（pre-boot / node 测）→ 回落 S.g 纯值。
interface EngineBind {
  getSize(): number; setSize(v: number): void;
  getOpacity(): number; setOpacity(v: number): void;
  getBrushId(): string | null; setBrushId(v: string | null): void;
  getColor(): string; setColor(v: string): void;
  getPickMode(): string; setPickMode(v: string): void;
}
let _bind: EngineBind | null = null;
// 用 _bind 的 raw setter 灌值（不经 editorState setter → 不 mark dirty；load/reset/bind 用）。
function applyBoundFromGroups(g: EditorGroups): void {
  if (!_bind) return;
  _bind.setSize(g.brushTool.size); _bind.setOpacity(g.brushTool.opacity);
  _bind.setBrushId(g.brushTool.brushId); _bind.setColor(g.brushTool.color);
  _bind.setPickMode(g.colorPicker.layerMode);
}
// boot 时 createEditorState 调：把当前 S.g（默认/已载入）灌进反应式引擎，二者对齐。
export function bindEditorReactive(b: EngineBind): void { _bind = b; applyBoundFromGroups(S.g); }

// 容错合并：present 键覆盖，缺键留 default，深一层（position/viewport）也浅合并。
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
function mergeInto<T extends object>(dst: T, src: unknown): void {
  if (!isObj(src)) return;
  for (const k of Object.keys(dst) as (keyof T & string)[]) {
    if (!(k in src) || src[k] === undefined) continue;
    const dv = dst[k], sv = src[k];
    if (isObj(dv) && isObj(sv)) mergeInto(dv as object, sv);
    else (dst as Record<string, unknown>)[k] = sv;
  }
}

// ── struct 门面：显式访问器（每 setter 接 setDirtyFlag）+ 三方法 ─────────────────────────
export const editorState = {
  // import / export ──
  import:        { get source(): string { return S.g.import.source; }, set source(v: string) { S.g.import.source = v; setDirtyFlag(); } },
  export: {
    get format(): string { return S.g.export.format; }, set format(v: string) { S.g.export.format = v; setDirtyFlag(); },
    get target(): string { return S.g.export.target; }, set target(v: string) { S.g.export.target = v; setDirtyFlag(); },
    get layerMode(): string { return S.g.export.layerMode; }, set layerMode(v: string) { S.g.export.layerMode = v; setDirtyFlag(); },
  },
  exportProject: { get format(): string { return S.g.exportProject.format; }, set format(v: string) { S.g.exportProject.format = v; setDirtyFlag(); } },
  // panels（enabled/position 全 per-doc，决策1「desk 跟画走」）──
  colorPanel: {
    get enabled(): boolean { return S.g.colorPanel.enabled; }, set enabled(v: boolean) { S.g.colorPanel.enabled = v; setDirtyFlag(); },
    get position(): PanelPos | null { return S.g.colorPanel.position; }, set position(v: PanelPos | null) { S.g.colorPanel.position = v; setDirtyFlag(); },
  },
  layersPanel: {
    get enabled(): boolean { return S.g.layersPanel.enabled; }, set enabled(v: boolean) { S.g.layersPanel.enabled = v; setDirtyFlag(); },
    get position(): PanelPos | null { return S.g.layersPanel.position; }, set position(v: PanelPos | null) { S.g.layersPanel.position = v; setDirtyFlag(); },
  },
  refPanel: {
    get enabled(): boolean { return S.g.refPanel.enabled; }, set enabled(v: boolean) { S.g.refPanel.enabled = v; setDirtyFlag(); },
    get position(): PanelPos | null { return S.g.refPanel.position; }, set position(v: PanelPos | null) { S.g.refPanel.position = v; setDirtyFlag(); },
    get viewport(): EditorViewport { return S.g.refPanel.viewport; }, set viewport(v: EditorViewport) { S.g.refPanel.viewport = v; setDirtyFlag(); },
  },
  blenderPanel: {
    get show(): boolean { return S.g.blenderPanel.show; }, set show(v: boolean) { S.g.blenderPanel.show = v; setDirtyFlag(); },
    get position(): PanelPos | null { return S.g.blenderPanel.position; }, set position(v: PanelPos | null) { S.g.blenderPanel.position = v; setDirtyFlag(); },
  },
  // tools（spec 表写了的收；未写的留下一轮）。brushTool + colorPicker 绑反应式引擎（见 EngineBind）──
  brushTool: {
    get brushId(): string | null { return _bind ? _bind.getBrushId() : S.g.brushTool.brushId; },
    set brushId(v: string | null) { if (_bind) _bind.setBrushId(v); else S.g.brushTool.brushId = v; setDirtyFlag(); },
    get size(): number { return _bind ? _bind.getSize() : S.g.brushTool.size; },
    set size(v: number) { if (_bind) _bind.setSize(v); else S.g.brushTool.size = v; setDirtyFlag(); },
    get opacity(): number { return _bind ? _bind.getOpacity() : S.g.brushTool.opacity; },
    set opacity(v: number) { if (_bind) _bind.setOpacity(v); else S.g.brushTool.opacity = v; setDirtyFlag(); },
    get color(): string { return _bind ? _bind.getColor() : S.g.brushTool.color; },
    set color(v: string) { if (_bind) _bind.setColor(v); else S.g.brushTool.color = v; setDirtyFlag(); },
  },
  liquify:     { get bleed(): string { return S.g.liquify.bleed; }, set bleed(v: string) { S.g.liquify.bleed = v; setDirtyFlag(); } },
  colorPicker: {
    get layerMode(): string { return _bind ? _bind.getPickMode() : S.g.colorPicker.layerMode; },
    set layerMode(v: string) { if (_bind) _bind.setPickMode(v); else S.g.colorPicker.layerMode = v; setDirtyFlag(); },
  },
  // viewport / checkboard ──
  get viewport(): EditorViewport | null { return S.g.viewport; }, set viewport(v: EditorViewport | null) { S.g.viewport = v; setDirtyFlag(); },
  get checkboard(): boolean { return S.g.checkboard; }, set checkboard(v: boolean) { S.g.checkboard = v; setDirtyFlag(); },

  // ── 序列化（除各字段外仅此二法 + reset + workspaceDirty 读/清）──
  // 深拷贝：与 live 解耦；即 .webpaint/editor-state.json 内容。绑定字段（brushTool/pickMode）从引擎 live 取。
  Serialize(): EditorGroups {
    const out = JSON.parse(JSON.stringify(S.g)) as EditorGroups;
    if (_bind) {
      out.brushTool = { brushId: _bind.getBrushId(), size: _bind.getSize(), opacity: _bind.getOpacity(), color: _bind.getColor() };
      out.colorPicker = { layerMode: _bind.getPickMode() };
    }
    return out;
  },
  // 载入（非编辑→不脏）：合并进 S.g，再把绑定字段灌进反应式引擎。
  Unserialize(json: unknown): void { const d = freshGroups(); mergeInto(d, json); S.g = d; applyBoundFromGroups(d); _workspaceDirty = false; },
  // 开新文件必调：回默认 + 灌引擎。
  reset(): void { S.g = freshGroups(); applyBoundFromGroups(S.g); _workspaceDirty = false; },

  // smart-save 用（stage4 接线）：workspaceDirty = editor-state 改过、未落盘（UI 静默、push 非 no-op）。
  isWorkspaceDirty(): boolean { return _workspaceDirty; },
  clearWorkspaceDirty(): void { _workspaceDirty = false; },                     // 存/推成功后清（stage4）
  _setOnDirty(cb: (() => void) | null): void { _onDirty = cb; },               // 可选：dirty 时通知外部
};
export type EditorStateStruct = typeof editorState;
