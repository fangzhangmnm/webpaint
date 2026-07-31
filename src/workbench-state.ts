// 本文件两块（**刻意同居**：下面的 editorState struct 经 bindEditorReactive 绑住上面的 reactive dial，
//   二者是同一份存储的两个面，拆开就得把桥暴露成跨模块 API）：
//   ① createEditorState() —— 编辑器「当前设成什么样」的**反应式 RAM SSoT**（纯内存）
//   ② editorState struct  —— per-doc「desk」的门面 + 序列化（见下方分隔线）
//
// ① 的单一职责：构造编辑器当前设置的单一真源——主色、每工具 dial（size/opacity/activeBrushId）、
//   棋盘/长按吸色等开关、filterBrush 瞬态。**不**负责落盘：ORA 存档由 session-state 的 _buildOraMeta
//   读 state.color/toolStates/checkerboard（per-doc 跟文件走）。
//   （v406 起**无 localStorage 种子**——desk per-doc，size/opacity/color 归 ② 的 brushTool SSoT，boot 后
//    bindEditorReactive 灌入、doc 载入覆盖。别再写"从 LS 种子"，那是 v405 之前的事。）
//
// ① 不做：当前笔派生（currentBrush computed 在 app，依赖 rack/engine = 组合接线）；工具/transient 相位
//   （editMode）；瞬态面板互斥（panel-state）。故意不造中央 god-object——各轴各自反应式。
//   （视口**会**进 ORA，但走 ② 的 editorState.viewport 存时镜像，不在 ① 里。）
//
// 反应式桥：color 用 defineProperty 代理回 dialReactive —— app 里 state.color 的读写零改动，背后是
//   反应式（Vue 组件 computed 自动追踪 → 当前笔重派生）。
//   （全局 pressureToSize/Opacity 已 deprecate 2026-07-14 → 每笔自带的 sizeCoeff/opaCoeff，见 brush.ts:397。）

import { reactive } from "../vendor/vue/vue.esm-browser.prod.js";
import { PREF_DEFAULTS } from "./app-prefs.ts";   // 手势开关默认值（真值由 app.ts fixup 相灌入，见下）
import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";

// 编辑器 RAM 态的形状契约见 AppContext（EditorRuntimeState / DialReactive）——本模块是其唯一构造者。
export type EditorState = EditorRuntimeState;

export function createEditorState(): { state: EditorRuntimeState; dialReactive: DialReactive } {
  // state.toolStates：per-tool 持久化（per-doc）。当前笔 = currentBrush computed（在 app）从这束 dial 纯派生。
  // shapes/airbrush **不**自己存——alias 到 brush（见 rack.getRackToolKey）。形状：{ size, opacity, activeBrushId }。
  // reactive：dial 是反应式 SSoT。先建 toolStates → 让 state 字面量一次成形、整体类型化（序列化走 JSON.stringify 无碍）。
  const toolStates: Record<string, ToolDial> = reactive({
    // brush dial 默认（size/opacity/activeBrushId 归 editorState.brushTool SSoT，boot 后 bindEditorReactive 灌入、doc 载入覆盖；
    //   不再从 LS 种子——desk per-doc，删了 webpaint.size/opacity 设备记忆）。
    //   v415 删了 flow：四处钉死 1.0、无滑块、无 preset 来源——压感对流量的影响走 per-preset 的 flowCoeff。
    brush:    { size: 12, opacity: 1.0, activeBrushId: null },
    eraser:   { size: 32, opacity: 0.6, activeBrushId: null },
    // v132：size=radius，opacity=transparency，variantId=子算法选择（Filter.brushVariants[].id），空=默认
    filterBrush: { size: 32, opacity: 1.0, activeBrushId: null, variantId: null },
  });

  const state: EditorRuntimeState = {
    // tool（当前工具）的 SSoT 在 editMode（editMode.current()）。见 edit-mode.js / CONTEXT.md。
    // v132 filter brush 激活时 = { Filter, params, variantLabel }；空闲 = null
    filterBrush: null,
    color: "#1b1b1b",   // 归 editorState.brushTool.color SSoT（boot bind 灌入 / doc 载入覆盖）；删 webpaint.color LS 种子
    // （全局压感开关 pressureToSize/Opacity 已 deprecate 2026-07-14 → 每笔自带，见 resolved-brush；删 webpaint.pToSize/pToOpacity LS）
    // 手势开关 = 跨设备偏好（synced-user-preference collection）。
    // ⚠v409 起 createEditorState 在 collection hydrate **之前**跑（TLA 门已拆）→ 这里只能拿到 DEFAULTS。
    //   真值由 app.ts 的 fixup 相（await prefsReady）经 settings-menu 的 renderSettingsFromPrefs() 灌入。
    //   消费方是 thunk 惰性读（app.ts 的 getLongPressPickEnabled/getSingleFingerDraw，每次 pointerdown 求值）
    //   → 灌入即生效，不需要反应式。
    longPressPick: PREF_DEFAULTS["long-press-pick"],
    singleFingerDraw: PREF_DEFAULTS["single-finger-draw"],
    pickMode: "composite",  // 吸色取样 composite|layer；归 editorState.colorPicker.layerMode SSoT（bind 灌入/载入覆盖）；删 webpaint.pickMode LS
    // v125 checkerboard 从全局 LS 改 per-doc（跟文件走）。初始 false；adopt 时按文件值覆盖；新建默认 false。
    checkerboard: false,
    toolStates,
  };

  // 反应式 dial SSoT 的其余轴：color / 当前工具 / 笔架版本 / canDraw。
  const dialReactive: DialReactive = reactive({
    tool: "brush",                 // 镜像 editMode.current()（含 transient）；_syncEditModeUI 同步
    color: state.color,
    canDraw: true,                 // 镜像 editMode.canDraw()；_syncEditModeUI 同步 → <LeftDial> 滑块 disabled
    pressureOff: false,            // 禁用笔压（per-doc desk：editorState.pressureDisabled 绑定于此；引擎经 input.ts thunk 读）
  });
  // color 读写代理回 dialReactive（app 里 state.color 零改动，背后反应式）。
  Object.defineProperty(state, "color", {
    get: () => dialReactive.color, set: (v: string) => { dialReactive.color = v; },
    configurable: true, enumerable: true,
  });

  // editorState.brushTool / colorPicker.layerMode 绑到反应式引擎态（引擎不改；editorState 作 SSoT 接口）。
  //   绑定即把 editorState 当前 S.g（默认，或 boot 前已 Unserialize 的值）灌进这些 reactive 字段，二者对齐。
  bindEditorReactive({
    getSize: () => toolStates.brush.size ?? 12, setSize: (v) => { toolStates.brush.size = v; },
    getOpacity: () => toolStates.brush.opacity ?? 1.0, setOpacity: (v) => { toolStates.brush.opacity = v; },
    getActiveBrushId: () => toolStates.brush.activeBrushId ?? null, setActiveBrushId: (v) => { toolStates.brush.activeBrushId = v; },
    getColor: () => dialReactive.color, setColor: (v) => { dialReactive.color = v; },
    getPickMode: () => state.pickMode, setPickMode: (v) => { state.pickMode = v; },
    getPressureOff: () => dialReactive.pressureOff, setPressureOff: (v) => { dialReactive.pressureOff = v; },
  });

  return { state, dialReactive };
}

// 把存档的 per-tool dial（ORA _webpaintState.toolStates[tool]）按 v98 兼容映射成 patch 对象，
// caller Object.assign 到 reactive toolStates[tool]（保留反应式）。saved 无效 → null（不动）。
// 反序列化细节下沉到 editor-state（toolState 形状的所有者；survey rec #5 part b）：
//   老 doc 兼容（**保留**）：只有 .intensity 当 opacity；只有 flow 没 opacity 时 flow 也当 opacity。
//   v415 起 dial 没有 flow 这一轴（恒 1.0、无滑块、无 preset 来源 = 纯摆设，已删），
//   所以只读不写：老档里的 flow 仍可能被当 opacity 用，但不再往 toolState 写回 flow 字段。
export function serializedToolStatePatch(current: ToolDial, saved: unknown): Partial<ToolDial> | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Record<string, unknown>;
  const op = typeof s.opacity === "number" ? s.opacity
           : typeof s.intensity === "number" ? s.intensity
           : typeof s.flow === "number" ? s.flow
           : current.opacity;
  return {
    size: typeof s.size === "number" ? s.size : current.size,
    opacity: op,
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
//   **永远 Hot、不自动推**；除各字段外只有 Serialize() / Unserialize() / reset() / syncRuntimeForSave()。
//   开新文件必 reset()（钉在 session-state 的 adoptModel + newDoc，结构性无法绕过）。
//   序列化进 ora 的 `.webpaint/editor-state.json`；**存盘时被顺手捞走**（_buildOraMeta），不自己驱动落盘。
//
// ⚠**desk 没有 dirty 标记**（v409 决策，撤销 v407 的 workspaceDirty 设计）：
//   desk 改动**不标脏、不触发保存、不触发退出推云**。只有内容脏（history 的 wp:histchange）或用户显式按
//   save 才落盘；落盘时顺手把当前 desk 捞进快照。**代价（用户 2026-07-14 明示接受）**：只拖面板/只换笔、
//   不画、不按 save 就退出 → desk 改动丢失，下次开 revert 到上次保存的快照。
//   历史：v407 曾有 workspaceDirty + setDirtyFlag() callback，用来让「push 是否 no-op」的判定含 desk 改动。
//   v409 定了①退出只有 contentDirty 才推②按 save 无条件 encode+push（时间戳必须动）→ 该标记零 reader → 删。
//   **别再加回来**，除非先推翻①或②。
//
// setter 纪律（同 collection 浅拷贝）：整枝赋值 position/viewport（`x.position = {...}`），
//   别原地改子对象字段（深层嵌套不隔离）。

export interface PanelPos { left: number; top: number; width?: number; height?: number }
export interface EditorViewport { tx: number; ty: number; scale: number; rot: number }

// 序列化形状 = `.webpaint/editor-state.json` 的内容（freshGroups() 即 defaults SSoT）。
function freshGroups() {
  return {
    export:        { format: "png" as string, target: "file" as string, layerMode: "merged" as string, clipSelection: false },   // layerMode=scope "merged"|"active"；clipSelection=#16 仅导出选区范围
    colorPanel:    { enabled: false, position: null as PanelPos | null },
    layersPanel:   { enabled: false, position: null as PanelPos | null },
    refPanel:      { enabled: false, position: null as PanelPos | null, viewport: { tx: 0, ty: 0, scale: 1, rot: 0 } as EditorViewport },
    blenderPanel:  { show: false, position: null as PanelPos | null },
    brushTool:     { activeBrushId: null as string | null, size: 12, opacity: 1, color: "#1b1b1b" },
    // v0.5（user 拍板）：魔棒/主栅格配置**跟文件走**。expand 是 toggle（开了才用 expandPx，默认 1）。
    //   v0.5.11：threshold 归魔棒（油漆桶独立工具及 editorState.bucket 退役——填色收进套索 fill mode，
    //   flood 只剩魔棒一条路；旧 doc 里 stale 的 bucket 键被 mergeInto 静默忽略）。
    // #31 自动扩张 + v0.5.11 阈值；v0.7.17（user 2026-07-30 授权持久化）：线稿闭合算法的
    //   全部 knob 跟文件走——closeDist=闭合距离(px)/ink=墨线判定(%)/minRegion=碎区下限(px)/
    //   tipSens=端点灵敏度(0..100)/bleed=蔓延距离(-1=自动填到中线,0=像素画不碰真墨水)
    // v0.7.21（user 2026-07-30 拍板）：similarThreshold=同色全图容差（与 classic 分开存）；
    //   metric=颜色度量 "oklab"|"rgb"（classic/similar 共用，统一默认 OKLab；lineart 不吃）
    // v0.7.24：fillGap=容隙 toggle + fillGapPx=可封缺口宽（classic 专属，与 auto-expand 两个独立 knob）
    magicWand:     { threshold: 20, expand: false, expandPx: 1, similarThreshold: 20, metric: "oklab" as string,
                     fillGap: false, fillGapPx: 4,
                     lineartCloseDist: 64, lineartInk: 50, lineartMinRegion: 32, lineartTipSens: 25, lineartBleed: -1 },
    // v0.6.19 蚂蚁线（user 拍板+持久化同意 2026-07-28）：fill 模式下可关（默认开）；
    //   toggle 只存在于 fill，非 fill 恒显示（ADR-0004 修订记录）。
    fill:          { showAnts: false },   // v0.7.17 默认改关（user 2026-07-30；toggle 仍在 fill ⋯ 菜单，per-doc 持久化）
    // v0.6.24 fill/lasso 分家（user 拍板：mental model 两个不互通的工具、实现一条路）：
    //   子工具/布尔/1:1 per-tool 持久化（v0.5.16 共享一份 RAM 记忆 _selMem 作废）。
    //   fill 默认魔棒+并（赛璐璐点色工作流）；selection 默认套索+新建（v0.6.55，user 2026-07-30：原默认矩形）。
    //   v0.7.17：算法 per-tool 持久化（user 拍板：油漆桶默认线稿闭合、选区魔棒默认像素精确 flood）
    lassoTool:     { sub: "freehand" as string, setOp: "new" as string, constrainSquare: false, algo: "classic" as string },
    fillTool:      { sub: "magic" as string, setOp: "union" as string, constrainSquare: false, algo: "lineart" as string },
    // v0.7.25 选区笔（lasso/fill 共用子工具 "pen"）：变体 + per-变体笔径（不进笔架/云同步，per-doc 跟 ora）
    selPen:        { variant: "hard" as string, sizeHard: 30, sizeInk: 8, sizePixel: 1 },
    // ADR-0005/0006 形状笔：子工具 + **per-图形约束**（user：每个图形的 lock 分别持久化，默认全不锁）
    //   + grid 配置（默认 2×6 = 6 头身 + 中线，border 关）
    shapeBrush:    { sub: "line" as string, constrainLine: false, constrainRect: false, constrainCircle: false, gridNu: 2, gridNv: 6, gridBorder: false },
    // ADR-0006 透视 frame（形状笔全局、per-ora）：VP 0-3 + 锁地平线（默认开）+ 参考点 + 当前平面。
    //   坐标 doc 空间、snap 像素中线 +0.5。裁剪/旋转/翻转/偏移画布时必须过 remapShapePersp（doc-ops 挂钩）。
    persp: {
      mode: "off" as string,   // "off"|"p1"|"p2"|"p3"（显式模式组槽）
      lockHorizon: true,
      plane: "ground" as string,   // "ground"|"wall"|"wallL"|"wallR"（按 mode 过滤；关透视在 mode）
      showGizmo: true,             // 绘图时显示 VP+地平线（user：作画时也要看得到，给显隐钮）
      // per-mode VP 槽位（user 拍板：一/二/三点分开存互不污染）。参考点已删（box 取代——
      //   「那个本来就是低配的方块」）。
      // box = 参考 cube 控制面参数（user：随消失点一起持久化；A=锚角 doc 坐标、t=三轴行程）
      p1: { vp1: null as { x: number; y: number } | null, box: null as { A: { x: number; y: number }; t: [number, number, number] } | null },
      p2: { vp1: null as { x: number; y: number } | null, vp2: null as { x: number; y: number } | null, box: null as { A: { x: number; y: number }; t: [number, number, number] } | null },
      p3: { vp1: null as { x: number; y: number } | null, vp2: null as { x: number; y: number } | null, vp3: null as { x: number; y: number } | null, box: null as { A: { x: number; y: number }; t: [number, number, number] } | null },
      // isometric（v0.6.20）：轴固定 2:1 惯例，无 VP——只存参考 box（A=锚点即 user 说的 anchor，
      //   +0.5 格系；t=三轴 px 行程）。持久化同意随 2026-07-28 plan 批准。
      iso: { box: null as { A: { x: number; y: number }; t: [number, number, number] } | null },
    },
    grid:          { on: false, cell: 16 },                              // #10 主栅格（tilemap 对齐，一直显示）
    // v0.6.48 裁剪·模板模式：本文档上次用的模板 id（便利记忆，无 DPI 语义——DPI 活在模板 SSoT，见设计定稿）
    crop:          { templateId: "" as string },
    // sample：液化采样核 "bilinear"|"nearest"|"spline"（v0.6.36 保锐模式；持久化同意随 2026-07-28 批；v0.6.45 默认回 bilinear——真机裁决 spline 无显著优势）
    liquify:       { bleed: "edge" as string, sample: "bicubic" as string },   // v0.6.61 默认双三次（user）
    colorPicker:   { layerMode: "composite" as string },                           // pick-mode: "composite" | "layer"
    viewport:      null as EditorViewport | null,
    checkboard:    false,
    // v0.6.15 禁用笔压（user：「显然跟着 ora 走，是 editor state」）：开 = 忽略压感恒定 0.5
    pressureDisabled: false,
  };
}
export type EditorGroups = ReturnType<typeof freshGroups>;

// ── 私有可变态 ─────────────────────────────────────────────────────────────────────────
const S = { g: freshGroups() };       // mutable holder（reset 时整份换，访问器每次 deref S.g → reset 生效）

// ── 反应式引擎绑定（stage5）：brushTool(size/opacity/activeBrushId/color) + colorPicker.layerMode 是引擎**每笔读**的
//   反应式态。editorState 作 SSoT 接口，底层存储绑到 createEditorState 的 reactive state —— 引擎一行不改、
//   Vue 反应式不断（改 editorState.brushTool.size 直接写 reactive → currentBrush 重算）。
//   未绑定（pre-boot / node 测）→ 回落 S.g 纯值。
interface EngineBind {
  getSize(): number; setSize(v: number): void;
  getOpacity(): number; setOpacity(v: number): void;
  getActiveBrushId(): string | null; setActiveBrushId(v: string | null): void;
  getColor(): string; setColor(v: string): void;
  getPickMode(): string; setPickMode(v: string): void;
  getPressureOff(): boolean; setPressureOff(v: boolean): void;
}
let _bind: EngineBind | null = null;
// 用 _bind 的 raw setter 灌值（不经 editorState setter → 不 mark dirty；load/reset/bind 用）。
function applyBoundFromGroups(g: EditorGroups): void {
  if (!_bind) return;
  _bind.setSize(g.brushTool.size); _bind.setOpacity(g.brushTool.opacity);
  _bind.setActiveBrushId(g.brushTool.activeBrushId); _bind.setColor(g.brushTool.color);
  _bind.setPickMode(g.colorPicker.layerMode);
  _bind.setPressureOff(g.pressureDisabled);
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

// ── struct 门面：显式访问器 + 四方法（**setter 不标脏**——desk 无 dirty 标记，见上方 ⚠）───────────
export const editorState = {
  // export ──（import 组 v0.5.19 退役：导入收进图层 + 菜单，无配置面）
  export: {
    get format(): string { return S.g.export.format; }, set format(v: string) { S.g.export.format = v; },
    get target(): string { return S.g.export.target; }, set target(v: string) { S.g.export.target = v; },
    get layerMode(): string { return S.g.export.layerMode; }, set layerMode(v: string) { S.g.export.layerMode = v; },
    get clipSelection(): boolean { return S.g.export.clipSelection; }, set clipSelection(v: boolean) { S.g.export.clipSelection = v; },
  },
  // panels（enabled/position 全 per-doc，决策1「desk 跟画走」）──
  colorPanel: {
    get enabled(): boolean { return S.g.colorPanel.enabled; }, set enabled(v: boolean) { S.g.colorPanel.enabled = v; },
    get position(): PanelPos | null { return S.g.colorPanel.position; }, set position(v: PanelPos | null) { S.g.colorPanel.position = v; },
  },
  layersPanel: {
    get enabled(): boolean { return S.g.layersPanel.enabled; }, set enabled(v: boolean) { S.g.layersPanel.enabled = v; },
    get position(): PanelPos | null { return S.g.layersPanel.position; }, set position(v: PanelPos | null) { S.g.layersPanel.position = v; },
  },
  refPanel: {
    get enabled(): boolean { return S.g.refPanel.enabled; }, set enabled(v: boolean) { S.g.refPanel.enabled = v; },
    get position(): PanelPos | null { return S.g.refPanel.position; }, set position(v: PanelPos | null) { S.g.refPanel.position = v; },
    get viewport(): EditorViewport { return S.g.refPanel.viewport; }, set viewport(v: EditorViewport) { S.g.refPanel.viewport = v; },
  },
  blenderPanel: {
    get show(): boolean { return S.g.blenderPanel.show; }, set show(v: boolean) { S.g.blenderPanel.show = v; },
    get position(): PanelPos | null { return S.g.blenderPanel.position; }, set position(v: PanelPos | null) { S.g.blenderPanel.position = v; },
  },
  // tools（spec 表写了的收；未写的留下一轮）。brushTool + colorPicker 绑反应式引擎（见 EngineBind）──
  brushTool: {
    get activeBrushId(): string | null { return _bind ? _bind.getActiveBrushId() : S.g.brushTool.activeBrushId; },
    set activeBrushId(v: string | null) { if (_bind) _bind.setActiveBrushId(v); else S.g.brushTool.activeBrushId = v; },
    get size(): number { return _bind ? _bind.getSize() : S.g.brushTool.size; },
    set size(v: number) { if (_bind) _bind.setSize(v); else S.g.brushTool.size = v; },
    get opacity(): number { return _bind ? _bind.getOpacity() : S.g.brushTool.opacity; },
    set opacity(v: number) { if (_bind) _bind.setOpacity(v); else S.g.brushTool.opacity = v; },
    get color(): string { return _bind ? _bind.getColor() : S.g.brushTool.color; },
    set color(v: string) { if (_bind) _bind.setColor(v); else S.g.brushTool.color = v; },
  },
  fill: {
    get showAnts(): boolean { return S.g.fill.showAnts; }, set showAnts(v: boolean) { S.g.fill.showAnts = v; },
  },
  lassoTool: {
    get sub(): string { return S.g.lassoTool.sub; }, set sub(v: string) { S.g.lassoTool.sub = v; },
    get setOp(): string { return S.g.lassoTool.setOp; }, set setOp(v: string) { S.g.lassoTool.setOp = v; },
    get constrainSquare(): boolean { return S.g.lassoTool.constrainSquare; }, set constrainSquare(v: boolean) { S.g.lassoTool.constrainSquare = v; },
    get algo(): string { return S.g.lassoTool.algo; }, set algo(v: string) { S.g.lassoTool.algo = v; },
  },
  // v0.7.25 选区笔
  selPen: {
    get variant(): string { return S.g.selPen.variant; }, set variant(v: string) { S.g.selPen.variant = v; },
    get sizeHard(): number { return S.g.selPen.sizeHard; }, set sizeHard(v: number) { S.g.selPen.sizeHard = v; },
    get sizeInk(): number { return S.g.selPen.sizeInk; }, set sizeInk(v: number) { S.g.selPen.sizeInk = v; },
    get sizePixel(): number { return S.g.selPen.sizePixel; }, set sizePixel(v: number) { S.g.selPen.sizePixel = v; },
  },
  fillTool: {
    get sub(): string { return S.g.fillTool.sub; }, set sub(v: string) { S.g.fillTool.sub = v; },
    get setOp(): string { return S.g.fillTool.setOp; }, set setOp(v: string) { S.g.fillTool.setOp = v; },
    get constrainSquare(): boolean { return S.g.fillTool.constrainSquare; }, set constrainSquare(v: boolean) { S.g.fillTool.constrainSquare = v; },
    get algo(): string { return S.g.fillTool.algo; }, set algo(v: string) { S.g.fillTool.algo = v; },
  },
  magicWand: {
    get threshold(): number { return S.g.magicWand.threshold; }, set threshold(v: number) { S.g.magicWand.threshold = v; },
    get expand(): boolean { return S.g.magicWand.expand; }, set expand(v: boolean) { S.g.magicWand.expand = v; },
    get expandPx(): number { return S.g.magicWand.expandPx; }, set expandPx(v: number) { S.g.magicWand.expandPx = v; },
    // v0.7.21：同色全图容差 + 颜色度量（"oklab"|"rgb"，classic/similar 共用）
    get similarThreshold(): number { return S.g.magicWand.similarThreshold; }, set similarThreshold(v: number) { S.g.magicWand.similarThreshold = v; },
    get metric(): string { return S.g.magicWand.metric; }, set metric(v: string) { S.g.magicWand.metric = v; },
    // v0.7.24 容隙
    get fillGap(): boolean { return S.g.magicWand.fillGap; }, set fillGap(v: boolean) { S.g.magicWand.fillGap = v; },
    get fillGapPx(): number { return S.g.magicWand.fillGapPx; }, set fillGapPx(v: number) { S.g.magicWand.fillGapPx = v; },
    get lineartCloseDist(): number { return S.g.magicWand.lineartCloseDist; }, set lineartCloseDist(v: number) { S.g.magicWand.lineartCloseDist = v; },
    get lineartInk(): number { return S.g.magicWand.lineartInk; }, set lineartInk(v: number) { S.g.magicWand.lineartInk = v; },
    get lineartMinRegion(): number { return S.g.magicWand.lineartMinRegion; }, set lineartMinRegion(v: number) { S.g.magicWand.lineartMinRegion = v; },
    get lineartTipSens(): number { return S.g.magicWand.lineartTipSens; }, set lineartTipSens(v: number) { S.g.magicWand.lineartTipSens = v; },
    get lineartBleed(): number { return S.g.magicWand.lineartBleed; }, set lineartBleed(v: number) { S.g.magicWand.lineartBleed = v; },
  },
  shapeBrush: {
    get sub(): string { return S.g.shapeBrush.sub; }, set sub(v: string) { S.g.shapeBrush.sub = v; },
    get constrainLine(): boolean { return S.g.shapeBrush.constrainLine; }, set constrainLine(v: boolean) { S.g.shapeBrush.constrainLine = v; },
    get constrainRect(): boolean { return S.g.shapeBrush.constrainRect; }, set constrainRect(v: boolean) { S.g.shapeBrush.constrainRect = v; },
    get constrainCircle(): boolean { return S.g.shapeBrush.constrainCircle; }, set constrainCircle(v: boolean) { S.g.shapeBrush.constrainCircle = v; },
    get gridNu(): number { return S.g.shapeBrush.gridNu; }, set gridNu(v: number) { S.g.shapeBrush.gridNu = v; },
    get gridNv(): number { return S.g.shapeBrush.gridNv; }, set gridNv(v: number) { S.g.shapeBrush.gridNv = v; },
    get gridBorder(): boolean { return S.g.shapeBrush.gridBorder; }, set gridBorder(v: boolean) { S.g.shapeBrush.gridBorder = v; },
  },
  persp: {
    get mode(): string { return S.g.persp.mode; }, set mode(v: string) { S.g.persp.mode = v; },
    get lockHorizon(): boolean { return S.g.persp.lockHorizon; }, set lockHorizon(v: boolean) { S.g.persp.lockHorizon = v; },
    get plane(): string { return S.g.persp.plane; }, set plane(v: string) { S.g.persp.plane = v; },
    get showGizmo(): boolean { return S.g.persp.showGizmo; }, set showGizmo(v: boolean) { S.g.persp.showGizmo = v; },
    get p1() { return S.g.persp.p1; },
    get p2() { return S.g.persp.p2; },
    get p3() { return S.g.persp.p3; },
    get iso() { return S.g.persp.iso; },
  },
  grid: {
    get on(): boolean { return S.g.grid.on; }, set on(v: boolean) { S.g.grid.on = v; },
    get cell(): number { return S.g.grid.cell; }, set cell(v: number) { S.g.grid.cell = v; },
  },
  liquify:     { get bleed(): string { return S.g.liquify.bleed; }, set bleed(v: string) { S.g.liquify.bleed = v; },
                 get sample(): string { return S.g.liquify.sample; }, set sample(v: string) { S.g.liquify.sample = v; } },
  crop:        { get templateId(): string { return S.g.crop.templateId; }, set templateId(v: string) { S.g.crop.templateId = v; } },
  colorPicker: {
    get layerMode(): string { return _bind ? _bind.getPickMode() : S.g.colorPicker.layerMode; },
    set layerMode(v: string) { if (_bind) _bind.setPickMode(v); else S.g.colorPicker.layerMode = v; },
  },
  // viewport / checkboard —— 真 SSoT 在 board.viewport / state.checkerboard，这两个字段是**存盘时的单向镜像**
  //   （由 syncRuntimeForSave 灌入）+ 载入时的回灌源（session-state 读 editorState.viewport → board）。
  //   故 setter 生产代码不调；留着是为了 Unserialize/测试能构造完整 desk。
  get viewport(): EditorViewport | null { return S.g.viewport; }, set viewport(v: EditorViewport | null) { S.g.viewport = v; },
  get checkboard(): boolean { return S.g.checkboard; }, set checkboard(v: boolean) { S.g.checkboard = v; },
  // 禁用笔压（per-doc desk）：绑 dialReactive.pressureOff（UI 反应式 + 引擎 thunk 同源），未绑定回落 S.g
  get pressureDisabled(): boolean { return _bind ? _bind.getPressureOff() : S.g.pressureDisabled; },
  set pressureDisabled(v: boolean) { if (_bind) _bind.setPressureOff(v); else S.g.pressureDisabled = v; },

  // ── 除各字段外仅此四法 ──
  // 深拷贝：与 live 解耦；即 .webpaint/editor-state.json 内容。绑定字段（brushTool/pickMode）从引擎 live 取。
  Serialize(): EditorGroups {
    const out = JSON.parse(JSON.stringify(S.g)) as EditorGroups;
    if (_bind) {
      out.brushTool = { activeBrushId: _bind.getActiveBrushId(), size: _bind.getSize(), opacity: _bind.getOpacity(), color: _bind.getColor() };
      out.colorPicker = { layerMode: _bind.getPickMode() };
      out.pressureDisabled = _bind.getPressureOff();
    }
    return out;
  },
  // 载入：合并进 S.g，再把绑定字段灌进反应式引擎。
  Unserialize(json: unknown): void { const d = freshGroups(); mergeInto(d, json); S.g = d; applyBoundFromGroups(d); },
  // 开新文件必调：回默认 + 灌引擎。
  reset(): void { S.g = freshGroups(); applyBoundFromGroups(S.g); },

  // 存前把运行时 SSoT（board 视口 / checkboard 观感开关）镜像进 S.g —— 存时才捞进（顺手），
  //   改动时什么都不做（desk 无 dirty 标记；且人类 2026-06-10 钉死「切棋盘不让画变未保存」）。
  syncRuntimeForSave(vp: EditorViewport, checkboard: boolean): void { S.g.viewport = vp; S.g.checkboard = checkboard; },
};
export type EditorStateStruct = typeof editorState;

// 画布几何操作（裁剪/旋转/翻转/偏移）时透视配置的重映射（ADR-0006；user：小心裁剪时 VP 坐标）。
//   VP/参考点是 doc 坐标的 desk 态，doc 几何变了不跟着变 = 透视静默错位。调用点在 doc-ops.ts
//   的五个几何 op 旁。rotate90 后若 VP 对存在，地平线变竖直 → 自动解锁 lockHorizon（锁的语义
//   是 doc 水平线，转 90° 后无法表示；下次进 VP 编辑用户可重新锁）。
export function remapShapePersp(f: (p: { x: number; y: number }) => { x: number; y: number }, opts: { unlockHorizon?: boolean } = {}): void {
  const g = S.g.persp;
  if (g.p1.vp1) g.p1.vp1 = f(g.p1.vp1);
  if (g.p2.vp1) g.p2.vp1 = f(g.p2.vp1);
  if (g.p2.vp2) g.p2.vp2 = f(g.p2.vp2);
  if (g.p3.vp1) g.p3.vp1 = f(g.p3.vp1);
  if (g.p3.vp2) g.p3.vp2 = f(g.p3.vp2);
  if (g.p3.vp3) g.p3.vp3 = f(g.p3.vp3);
  // 参考 box 锚角跟着重映射（t 行程是比例/相对量，不动）；iso 只有 box（轴固定无 VP）
  for (const slot of [g.p1, g.p2, g.p3, g.iso]) {
    if (slot.box) slot.box = { A: f(slot.box.A), t: slot.box.t };
  }
  if (opts.unlockHorizon && (g.p2.vp1 || g.p3.vp1)) g.lockHorizon = false;
}

// 透视配置快照/还原（docTransform undo 信封用；深拷贝，desk 无自身 undo 所以只随 doc 变换走）
export function snapshotShapePersp(): unknown {
  return JSON.parse(JSON.stringify(S.g.persp));
}
export function restoreShapePersp(snap: unknown): void {
  if (!snap || typeof snap !== "object") return;
  const d = freshGroups().persp;
  mergeInto(d, snap);
  S.g.persp = d;
}
