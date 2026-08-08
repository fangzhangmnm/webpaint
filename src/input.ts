// Pointer / pen / touch + 手势 + undo stack。
// 沿用 ScratchPad 的 pointer 模式（防误触、coalesced、平滑、屏幕双击切工具）。
// 差异：
//   - 画笔不走"矢量 stroke 存数据"路线 —— 直接通过 BrushEngine 把 stamp 落到 layer.ctx
//   - undo = 笔前对 active layer 做 ImageData 快照，撤销时 putImageData
//   - 坐标走 doc 坐标（screenToDoc）
//
// 行为矩阵（沿用 ScratchPad，做了 picker 增项）：
//   tool=brush / eraser / picker:
//     pen                    → 画 / 擦 / 吸
//     touch (无 pen)         → 单指=惰性 hold（防手掌误触，不画不平移）；「单指绘画」开关 ON 时单指作画；双指=pan+pinch
//     touch (本机见过 pen)   → 永远不画；单指=惰性 hold（**不 pan**）；双指=pan+pinch
//     ——防手掌误触：单指永不平移画布，pan 一律两指（见过 pen 的设备手掌≡单指 touch，物理不可分）。见 pointer-route.ts:assignRole
//     mouse 左键             → 画/擦/吸
//     mouse 中/右键          → pan
//     按住 Space             → 临时 pan
//   tool=hand:
//     任意 pointer 拖动      → pan
//
//   wheel:
//     ctrlKey (pinch)        → 以光标为中心缩放
//     else                   → 平移

import { BrushEngine } from "./brush.ts";
import { reportError } from "./error-badge.ts";
import { LassoEngine } from "./lasso.ts";
import { FilterBrushEngine } from "./filter-brush.ts";
import { ShapeBrushEngine } from "./shape-brush.ts";
import { isPixelStroke, pixelStrokeSpec } from "./engine-registry.ts";
import { computePinchViewport, snapRotation, isTap, isDoubleTap, gestureTapAction } from "./pointer-gesture.ts";
import { assignRole, effectiveTool, toolToRole } from "./pointer-route.ts";
import { inputSmooth } from "./stroke-input-smooth.ts";
import { t } from "./i18n/index.ts";
import { SMOOTH } from "./smooth-config.ts";
import type { GestureViewport, TapRef } from "./pointer-gesture.ts";
import type { PaintingView, ViewLeaf } from "./workpiece/painting-view.ts";
import type { Board } from "./board.ts";
import type { EditMode } from "./edit-mode.ts";
import type { History } from "./workpiece/history.ts";
import type { PaintingWorkpiece } from "./workpiece/painting-workpiece.ts";
import type { LayerTiles } from "./workpiece/layer-tiles.ts";
import type { WriteToken } from "./workpiece/workpiece.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import { Selection } from "./selection.ts";
import { selPenSettingsFrom, stampsToBinaryGray8 } from "./sel-pen.ts";

// ---- 引擎真类型已全部 .ts 化，直接 import（见各引擎模块）。本文件仅保留以下接缝别名/最小壳。----
// doc 现取 PaintingView 真类型（board/lasso 都吃它）。
type Doc = PaintingView;
// filterBrush 当前激活态：Filter 是 filter-brush.ts 的 BrushFilter（未 export，对 input 不透明）+ params。
//   beginStroke 调用点再断言到引擎签名；这里 Filter/params 对 input 不透明 → unknown。
interface FilterBrushState { Filter: unknown; params: unknown; }

// 活动笔画（brush / filterBrush 共享 begin/extend/end/cancel 协议；液化 = filterBrush 的
//   LiquifyFilter payload，v132 user：「液化先 migrate 到 filter brush」——S8 删掉了残留的直连双轨）。
type StrokeEngine = BrushEngine | FilterBrushEngine | ShapeBrushEngine;
// inPlace = 描边中原地改 layer 像素（liquify/filterBrush/pixelMode brush），非 overlay 预览。
//   GL 模式下这类笔的 live 预览要靠 board 每帧把活动层重传 GPU（buffered brush 走 GPU stamp overlay，不算）。
// v2（T2）：tx → token+layer。像素写不再拍整层快照——描边期写 layer.pixels 被 LayerTiles collector
//   写时扣押；commit 打包一步 / cancel 倒序回滚。
interface ActiveStroke { engine: StrokeEngine; token: WriteToken; layer: ViewLeaf; finalize: boolean; inPlace: boolean; }

// 选区变化 entry（lasso.endPath/setSelection 产 → _pushSelEntry 走 SelectionComponent 记账）。
//   （LassoEntry 已死 v0.4.7：accept/reject 的 operator 编排收进 FloatingTransform。）
interface SelectionChangeEntry { before?: Selection | null; after?: Selection | null; }

// pointer 记录：down 时建立、move/up 累积手感状态（平滑 / 压感 / 死区 / long-press）。
interface PointerRec {
  pointerType: string;
  role: string | null;
  x: number;
  y: number;
  startX?: number;
  startY?: number;
  smX?: number;
  smY?: number;
  downTime?: number;
  lastUpdateTs?: number;
  longPressTimer?: ReturnType<typeof setTimeout> | null;
  lastRawX?: number;
  lastRawY?: number;
  lastP?: number | null;
  smP?: number;
  lastEventTs?: number;
  rawSX?: number;
  rawSY?: number;
  stabX?: number;
  stabY?: number;
  rawToEngine?: boolean;
  _deferGroupWarn?: boolean;
  _deferHiddenWarn?: boolean;
  _lastX?: number;
  _lastY?: number;
  _lassoMode?: string;
  _lassoStartDocX?: number;
  _lassoStartDocY?: number;
}

interface GestureTap {
  startTime: number;
  firstDownTime: number;   // 参与本次手势的最早触点落下时刻，tap 时长从这里算（抓久搁掌根的"慢 tap"）
  isTap: boolean;
  maxCount: number;
  startPositions: Record<string, { x: number; y: number }>;
}

interface InputOpts {
  getTool?: () => string;
  editMode?: EditMode | null;
  getResolvedBrush?: () => ResolvedBrush | null;
  getFilterBrushState?: () => FilterBrushState | null;
  getLongPressPickEnabled?: () => boolean;
  getSingleFingerDraw?: () => boolean;
  getPickMode?: () => string;
  onColorSampled?: (hex: string) => void;
  status?: (msg: string) => void;
  history?: History | null;
  wp2?: PaintingWorkpiece | null;
  layerTiles?: LayerTiles | null;
  isContentReplacing?: () => boolean;   // N10：云端快进正在换画布内容时为 true → draw-role 起笔降级（同 !canDraw 路径）
}

interface KeyboardShortcut {
  combo: string;
  desc: string;
  category: string;
  when?: (i: InputController) => boolean;
  run: (i: InputController) => void;
}

const TAP_MAX_DURATION = 220;
const TAP_MAX_MOVE = 16;
const DOUBLETAP_WINDOW = 500;
const DOUBLETAP_MAX_GAP = 80;
// 平滑管线魔数已移到 src/smooth-config.js (SMOOTH)，dev 面板可 live 调 + 自测：
//   SMOOTH.rawStaticSq   raw 静止门限（screen px²）
//   SMOOTH.pressureAlpha 压感 smP 一阶 EMA α（input 端去尖刺）
//   SMOOTH.tauMaxMs      streamline=1 时的时间常数 tau（ms）
//   SMOOTH.stabMaxPx     stabilization=1 时死区半径
// Undo 通过 history.UndoStack（v44 起 command pattern + 注册 handler）。
// 这里只注册 "stroke" type 的 handler，layer 操作的 handler 在 app.js 注册。
// 详见 ai-docs/20260527-undo-architecture.md。

// 多指 tap = undo/redo（Procreate 方言）
const GESTURE_TAP_MAX_MS = 250;
const GESTURE_TAP_MAX_MOVE_SQ = 256;     // 16 px²

// 掌触防误撤销：手掌搁屏 = ≥2 个 touch 触点，与真双指物理不可分。写字前后手掌一抖/闪灭
// 就凑成假"双指 tap"→ 误 undo。_purgeAllTouches 只在下次落笔清；最后一笔后、下笔未来的
// 窗口里掌触闪灭仍会误撤销。故多指 *tap* 加笔尖时近性门：笔尖活动（落/移/抬）后这段时间内
// 的多指 tap 一律视作掌触 flicker，吞掉不撤销/重做。只挡 tap，pinch/pan 不受影响。
const PALM_PEN_GUARD_MS = 600;

// 单指长按 → 临时切到 picker；user 设置可开关。延迟阈值参考 iOS 系统 longpress。
const LONG_PRESS_MS = 450;
// v0.5.9 快速捏合复位（Procreate 方言）→ v0.6.57 改纯 release-velocity 判定（user 拍板，grill 2026-07-30）：
//   判据 = **松手瞬间两指仍在快速收拢**（甩尾离屏）。比例/时间窗/行程门全撤——Procreate 官方
//   教学「捏合到最后手指在运动中离屏」，区分「缩一点→停→抬」（松手时速度≈0）与复位甩尾的
//   就是离屏时刻的收拢速度；旧三门（寿命/比例/行程）在这两者上都不可分。
//   速度单位 = CSS px/s（准物理单位，跨屏幕/zoom/视口解耦）；不用 UIKit 的 scale/s——
//   除以起手间距归一会把近距小抖动放大成巨大速度，恰是要防的噪声。
const QUICK_PINCH_FIT_SPEED = 400;      // 收拢速度阈值（px/s；800 真机偏紧，2026-07-30 松一倍）
const QUICK_PINCH_FIT_TAU_MS = 40;      // d(dist)/dt 的 EMA 时间常数（裸差分抖；同笔刷平滑的指数追踪思路）
// v0.6.59（user）：velocity 之外补两道静态门——
//   旋转门：手势累计转角 <30°（正在转画布的捏合不是复位意图）；
//   比例门：末距 < 起手距 × 2/3（放宽版回归，纯方向 sanity 升级成幅度门）。
const QUICK_PINCH_FIT_MAX_ROT = Math.PI / 6;
const QUICK_PINCH_FIT_RATIO = 0.75;     // 2/3 真机偏紧 → 75%（2026-07-30）
const LONG_PRESS_CANCEL_SQ = 64;          // 8 px²；超出就放弃当 draw 处理

// v249: 两参 → 引擎平滑参数（时间常数指数追踪 + 死区，详 ai-docs/20260613-brush-procreate-smoothing.md）。
//   tau = streamline × tauMaxMs（时间，scale 无关）；deadzone = stabilization × stabMaxPx ÷scale（doc px）。
function _resolveSmooth(settings: ResolvedBrush, scale: number) {
  const sc = scale || 1;
  const clamp01 = (v: number | undefined) => Math.max(0, Math.min(1, v || 0));
  return {
    tau:      clamp01(settings.streamline) * SMOOTH.tauMaxMs,
    deadzone: clamp01(settings.stabilization) * SMOOTH.stabMaxPx / sc,
    tailBow:  SMOOTH.tailBow,
  };
}

// v124 (user：「统一快捷键注册收集，不会改了这里忘了那里」+「Gallery 等 transient 要小心不要误触」)
// SSoT：_keydown 按这个表 dispatch；app.js 菜单"快捷键"面板从这里读 desc 渲染。
// 加新快捷键 = 新增一条 entry。
//
// when(i) 守卫：返回 false 时跳过。常用：
//   - _editMode：默认 gate，gallery / 任何全屏 modal 时不响应
//   - _floating：只在套索浮层时
//   - _hasSelection：只在有选区时（无 floating）
function _editMode(i: InputController) {
  // gallery 全屏时不响应工具切换 / 选区类快捷键
  if (document.body.dataset.mode === "gallery") return false;
  return true;
}
function _floating(i: InputController) { return i.lasso?.state() === "floating"; }
function _hasSelectionIdle(i: InputController) {
  return i.lasso?.hasSelection() && i.lasso?.state() === "idle";
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  // 编辑（任何时候都该 work，除了 gallery 单 modal）
  { combo: "Ctrl+Z",           desc: "sc.undo",     category: "sc.cat.edit",
    when: _editMode, run: (i) => i.ctrlZ() },
  { combo: "Ctrl+Shift+Z",     desc: "sc.redo",     category: "sc.cat.edit",
    when: _editMode, run: (i) => i.redo() },
  { combo: "Ctrl+Y",           desc: "sc.redo",     category: "sc.cat.edit",
    when: _editMode, run: (i) => i.redo() },
  // v156 剪贴板：逻辑在 app.js（doc/import/clipboard）→ run 派发 window 事件。
  //   when=_editMode（不查选区）→ 始终匹配以 preventDefault，挡掉浏览器原生 copy/paste；run 内部再决定。
  { combo: "Ctrl+C",           desc: "sc.copyClip", category: "sc.cat.edit",
    when: _editMode, run: () => window.dispatchEvent(new CustomEvent("wp:copy")) },
  { combo: "Ctrl+V",           desc: "sc.pasteLayer",   category: "sc.cat.edit",
    when: _editMode, run: () => window.dispatchEvent(new CustomEvent("wp:paste")) },

  // 套索 / 选区（在浮层时只 Enter/Esc，其它跳过）
  { combo: "Enter",            desc: "sc.applyTransform", category: "sc.cat.lasso",
    when: _floating, run: (i) => i._commitLasso() },
  { combo: "Escape",           desc: "sc.cancelTransform", category: "sc.cat.lasso",
    when: _floating, run: (i) => i._abortLasso() },
  { combo: "Escape",           desc: "sc.polygonCancel", category: "sc.cat.lasso",
    when: (i) => i.lasso.polygonSessionActive() && !_floating(i),
    run: (i) => { i.lasso.polygonCancelSession(); i.board.requestRender(); } },
  { combo: "Enter",            desc: "sc.polygonClose", category: "sc.cat.lasso",
    when: (i) => i.lasso.polygonSessionActive() && !_floating(i),
    run: (i) => i._polygonClose() },
  { combo: "Escape",           desc: "sc.deselect", category: "sc.cat.lasso",
    when: _hasSelectionIdle,
    run: (i) => {
      i._pushSelEntry(i.lasso.setSelection(null));
      i.board.invalidateAll();
    },
  },
  { combo: "Ctrl+A",           desc: "sc.selectAll",     category: "sc.cat.lasso",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoRow1SelectAllBtn")?.click() },   // v0.7.39 全选提出 ⋯ 成 Row1 钮
  { combo: "Ctrl+D",           desc: "sc.deselect", category: "sc.cat.lasso",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoDeselectBtn")?.click() },
  { combo: "Ctrl+Shift+I",     desc: "sc.invert",     category: "sc.cat.lasso",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoRow1InvertBtn")?.click() },   // v0.7.39 反选提出 ⋯ 成 Row1 钮
  // v156 变换 / 复制为浮层（都需选区 + 非浮层；run 内部再查选区）
  // 裸 T 任何环境可用；Ctrl+T 是浏览器保留键 → 仅装成 PWA(standalone) 时可用，标签页里被浏览器开新标签吞掉。
  { combo: "T",                desc: "sc.transformSel",     category: "sc.cat.lasso",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoTransformBtn")?.click() },
  { combo: "Ctrl+T",           desc: "sc.transformSelPwa", category: "sc.cat.lasso",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoTransformBtn")?.click() },
  { combo: "Ctrl+J",           desc: "sc.floatCopy", category: "sc.cat.lasso",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => window.dispatchEvent(new CustomEvent("wp:duplicateFloat")) },

  // 工具切换（gallery / floating 时跳过）
  { combo: "B",                desc: "sc.brush",     category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("brush") },
  { combo: "S",                desc: "sc.shapeBrush", category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("shapeBrush") },
  { combo: "E",                desc: "sc.eraser",     category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("eraser") },
  { combo: "I",                desc: "sc.picker",     category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("picker") },
  // v0.6.24：fill/lasso 分家 per-tool 持久化——G = 填色（默认魔棒+并）；L = 套索（默认矩形+新建）。
  //   从 fill 切走 = commit（fill-mode.ts 的 modechange 钩子），键位本身零填色知识。
  { combo: "G",                desc: "sc.fillMode",  category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("fill") },
  { combo: "L",                desc: "sc.lasso",     category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("lasso") },
  { combo: "H",                desc: "sc.pan",     category: "sc.cat.tools",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("hand") },

  // 窗格（裸字母；逻辑在 app.js，run 派发 window 事件）。不用 F 键（笔记本要 Fn / iPad 没有）。
  { combo: "C",                desc: "sc.colorPanel", category: "sc.cat.panels",
    when: (i) => _editMode(i) && !_floating(i), run: () => window.dispatchEvent(new CustomEvent("wp:toggleColor")) },
  { combo: "N",                desc: "sc.layerPanel", category: "sc.cat.panels",
    when: (i) => _editMode(i) && !_floating(i), run: () => window.dispatchEvent(new CustomEvent("wp:toggleLayers")) },
  { combo: "R",                desc: "menu.reference", category: "sc.cat.panels",
    when: (i) => _editMode(i) && !_floating(i), run: () => window.dispatchEvent(new CustomEvent("wp:toggleReference")) },

  // 视图
  { combo: "0",                desc: "sc.centerCanvas", category: "sc.cat.view",
    when: _editMode, run: (i) => i.board.fitToScreen() },
  { combo: "+",                desc: "sc.zoomIn",     category: "sc.cat.view",
    when: _editMode, run: (i) => i.board.zoomAt(innerWidth/2, innerHeight/2, 1.2) },
  { combo: "-",                desc: "sc.zoomOut",     category: "sc.cat.view",
    when: _editMode, run: (i) => i.board.zoomAt(innerWidth/2, innerHeight/2, 1/1.2) },

  // 笔粗
  { combo: "[",                desc: "sc.sizeDown",   category: "sc.cat.size",
    when: _editMode, run: (i) => i._adjustSize(-2) },
  { combo: "]",                desc: "sc.sizeUp",   category: "sc.cat.size",
    when: _editMode, run: (i) => i._adjustSize(+2) },

  // **特殊**：Space hold = 临时 pan，需要 keyup 解除（_keydown 顶部硬编码，不走 registry）
  // **特殊**：Ctrl+S = 保存（绑在 app.js 拦截，不走 registry）
];

function _matchCombo(e: KeyboardEvent, combo: string) {
  const parts = combo.split("+").map((s: string) => s.trim());
  const wantCtrl  = parts.includes("Ctrl");
  const wantShift = parts.includes("Shift");
  const wantAlt   = parts.includes("Alt");
  const key = parts[parts.length - 1];
  const ctrl = e.ctrlKey || e.metaKey;
  if (!!ctrl !== wantCtrl) return false;
  if (!!e.shiftKey !== wantShift) return false;
  if (!!e.altKey   !== wantAlt)   return false;
  if (key === "Enter")  return e.key === "Enter";
  if (key === "Escape") return e.key === "Escape";
  if (key === "+")      return e.key === "+" || e.key === "=";
  if (key === "-")      return e.key === "-" || e.key === "_";
  if (key === "[" || key === "]") return e.key === key;
  if (key === "0")      return e.key === "0";
  if (key.length === 1) {
    return e.code === "Key" + key.toUpperCase() || e.key.toUpperCase() === key.toUpperCase();
  }
  return e.key === key;
}

export class InputController {
  board: Board;
  doc: Doc;
  canvas: HTMLCanvasElement;
  brush: BrushEngine;
  lasso: LassoEngine;
  filterBrush: FilterBrushEngine;
  shapeBrush: ShapeBrushEngine;
  getTool: () => string;
  editMode: EditMode | null;
  getResolvedBrush: () => ResolvedBrush | null;
  getFilterBrushState: () => FilterBrushState | null;
  getLongPressPickEnabled: () => boolean;
  getSingleFingerDraw: () => boolean;
  getPickMode: () => string;
  isContentReplacing: () => boolean;   // N10：见 InputOpts
  onColorSampled: (hex: string) => void;
  status: (msg: string) => void;
  pointers: Map<number, PointerRec>;
  penEverSeen: boolean;
  spaceDown: boolean;
  altDown: boolean;
  gestureStart: { dist: number; midX: number; midY: number; angle: number; vp: GestureViewport; lastDist: number; lastAngle: number; velEma: number; lastMoveT: number } | null;
  _gestureTap: GestureTap | null;
  _lastTap: TapRef | null;
  _lastPenActivity: number = -Infinity;   // 最近笔尖落/移/抬时刻 (ms)。掌触 tap 门用
  history: History | null;
  wp2: PaintingWorkpiece | null;
  layerTiles: LayerTiles | null;
  _activeStroke: ActiveStroke | null = null;

  constructor(board: Board, doc: Doc, opts: InputOpts = {}) {
    this.board = board;
    this.doc = doc;
    this.canvas = board.canvas;
    this.brush = new BrushEngine();
    this.lasso = new LassoEngine();
    // v132 filter brush（user：「blur/sharpen/液化 走 filter brush engine」）
    //   引擎本身是薄 delegate；filter 自己提供 begin/extend/end brush 方法
    this.filterBrush = new FilterBrushEngine();
    // 形状笔（ADR-0005）：几何重合成引擎，与 brush 共享 ResolvedBrush + stroke 事务
    this.shapeBrush = new ShapeBrushEngine();
    this.lasso.onChange = () => {
      this.board.requestRender();
      window.dispatchEvent(new CustomEvent("wp:lassochange"));
    };
    this.getTool = opts.getTool || (() => "brush");
    this.editMode = opts.editMode || null;   // EditMode 独占状态机（路由/gate/ctrl-z 用，见 edit-mode.js）
    this.getResolvedBrush = opts.getResolvedBrush || (() => null);   // 必须传
    // v132 filter brush 当前激活的 { Filter, params } 或 null
    this.getFilterBrushState = opts.getFilterBrushState || (() => null);
    this.getLongPressPickEnabled = opts.getLongPressPickEnabled || (() => false);
    this.getSingleFingerDraw = opts.getSingleFingerDraw || (() => false);
    this.getPickMode = opts.getPickMode || (() => "composite");   // 吸色取样：composite | layer
    this.isContentReplacing = opts.isContentReplacing || (() => false);   // N10：云端快进换内容中 → 起笔降级
    this.onColorSampled = opts.onColorSampled || (() => {});
    this.status = opts.status || (() => {});

    this.pointers = new Map();
    this.penEverSeen = false;
    this.spaceDown = false;
    this.altDown = false;
    this.gestureStart = null;
    // 多指 tap snapshot（gesture 阶段累的状态，松手时判定 undo/redo）
    this._gestureTap = null;

    // Undo: snapshot 链 + pointer。chain[i] = 那一刻 layer 的 ImageData。
    // - 起手第一颗 stamp 前 lazily 拍一张当前状态（初始空白）
    // - endStroke 后 truncate（去掉 redo 段）+ push 新状态 → index++
    // - undo: index--, putImageData(chain[index])
    // - redo: index++, putImageData(chain[index])
    this._lastTap = null;
    // history: 共享 History 编排器（app.ts 创建注入；T5 起纯 v2 令牌流）。
    this.history = opts.history || null;
    this.wp2 = opts.wp2 || null;
    this.layerTiles = opts.layerTiles || null;
    // 把 doc 引用给 lasso，便于直接操作 doc.selection
    this.lasso.setDoc(this.doc);
    // T4b：float 状态在 FloatLayerComponent——lasso 的 lift/变换/stamp/accept/reject 走令牌编排。
    if (this.wp2 && this.history) {
      this.lasso.attachWorkpiece(this.doc, this.history, this.wp2.floatLayer, this.wp2.selection);
    }
    this._bind();
  }

  _bind() {
    // 切离 lasso（真切换，transient 括号不算）= 多边形会话 abort（fill _onModeChange 同款判法）
    window.addEventListener("wp:modechange", () => {
      if (!this.editMode || this.editMode.isTransient()) return;
      const m = this.editMode.current();
      // v0.6.24：fill 里多边形是合法选区生产者（fill/lasso 共用 lasso 管线）——两者之外才清会话
      if (m !== "lasso" && m !== "fill") this.lasso.polygonCancelSession();
    });
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e, true));
    c.addEventListener("pointerleave", (e) => this._up(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    // iOS：长按 callout / 放大镜 / "存储图像" 在 touchstart 长按计时器上 arm，contextmenu(iOS 基本不发)
    //   + pointerdown.preventDefault(错事件类型) 都拦不住。唯一可靠拦法 = 非 passive touchstart
    //   preventDefault。只绑在画布上（不碰可滚动 UI 面板）、只单指拦（多指缩放/平移走 pointer 路径，
    //   preventDefault touchstart 不影响 pointer 事件）。canvas 已 touch-action:none，本就不滚。
    c.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) e.preventDefault();
    }, { passive: false });
    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this._keydown(e));
    window.addEventListener("keyup", (e) => this._keyup(e));
  }

  // -- pen tip hover preview（iPad Pro M2+ 有 pen hover；mouse 模式也利用）
  _updateCursorPreview(e: PointerEvent) {
    // #6 stage 4b：圆的显隐从 EditMode.cursor() 派生（取代硬编码 tool 列表）。
    //   "none"/"grab"（picker/lasso/hand + transform/crop/adjust）→ 不显（修"transient 时圆没隐藏"）
    //   "brush"（笔/橡皮/filterBrush 含液化）→ 显，用画笔大小
    const cur = this.editMode ? this.editMode.cursor() : "brush";
    if (cur === "none" || cur === "grab") {
      this.board.setCursor(null);
      return;
    }
    let size, square = false, aspect = 1, rotation = 0;
    {
      const settings = this.getResolvedBrush();
      size = settings ? settings.size : 12;
      // v232：像素笔 stamp 是方的 → preview 方。#28（v0.5）改像素化圆盘 stamp：
      //   ≥3px 圆盘 → 圆 preview；1-2px 圆=方 → 维持方（跟 stamp 形状一致，不误导）。
      square = !!(settings && settings.pixelMode) && size <= 2;
      // 椭圆度/斜度也照 resolved-brush（shapeRotation 是弧度）——footprint 预览
      aspect = settings ? settings.shapeAspect : 1;
      rotation = settings ? settings.shapeRotation : 0;
    }
    this.board.setCursor({ x: e.clientX, y: e.clientY, size, square, aspect, rotation });
  }

  _down(e: PointerEvent) {
    // ① 清掉 stale ghost pointers（iOS 偶尔丢 pointerup → ghost 卡在 map 里
    // 让单指手势误判成双指、画布失控旋转。user 2026-05-28）
    this._purgeStalePointers();
    // ② 笔尖落下 = 权威信号。之前所有触摸都视作掌触提前结束（即使没收到 up）。
    // 这条比 stale purge 更激进：不管时间多久，pen down 就清。
    if (e.pointerType === "pen") {
      this._purgeAllTouches();
      this.penEverSeen = true;
      this._lastPenActivity = performance.now();
      this._lastTap = null;
    }
    this.canvas.setPointerCapture?.(e.pointerId);

    const tool = this.getTool();   // = editMode.current()；transient 时是 "transform"/"crop"/"adjust"
    // effectiveTool（transform→lasso / alt+brush→picker）与 role 决策一起抽到 pointer-route.js
    const x = e.clientX, y = e.clientY;

    // pen 正在画 → touch 当掌触
    const penDrawing = [...this.pointers.values()].some(
      (p) => p.pointerType === "pen" && (p.role === "draw" || p.role === "erase"),
    );
    if (e.pointerType === "touch" && penDrawing) {
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "ignore", x, y, lastUpdateTs: performance.now() });
      e.preventDefault();
      return;
    }

    // 第二个 touch → gesture
    const activeTouches = [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
    if (e.pointerType === "touch" && activeTouches.length >= 1) {
      // 清掉所有挂在 touch 上的 long-press timer（gesture 之后不再是单指长按）
      for (const [, p] of this.pointers) {
        if (p.longPressTimer) { clearTimeout(p.longPressTimer); p.longPressTimer = null; }
      }
      for (const p of this.pointers.values()) {
        if (isPixelStroke(p.role as string)) {
          this._abortStroke();
        } else if (p.role === "lasso") {
          this._abortLasso();
        }
        // 任何 active touch 都转 gesture，让 pinch/pan math 接管，不再跑 per-pointer 逻辑
        if (p.pointerType === "touch" && p.role !== "ignore") {
          p.role = "gesture";
        }
      }
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "gesture", x, y, startX: x, startY: y, downTime: performance.now(), lastUpdateTs: performance.now() });
      this._beginGesture();
      this._updateGestureTapSnapshot();
      e.preventDefault();
      return;
    }

    // 决定角色（纯决策抽到 pointer-route.js·可单测；含 hand/space=pan、设备分支、pen 副键=erase、
    //   touch+penEverSeen=pan、transform→lasso、alt+brush→picker）
    const role = assignRole({
      tool, pointerType: e.pointerType, button: e.button, buttons: e.buttons,
      spaceDown: this.spaceDown, altDown: this.altDown, penEverSeen: this.penEverSeen,
      singleFingerDraw: this.getSingleFingerDraw(),
    });

    const now = performance.now();
    const rec: PointerRec = {
      pointerType: e.pointerType, role,
      x, y, startX: x, startY: y,
      smX: x, smY: y,
      downTime: now,
      lastUpdateTs: now,
    };
    this.pointers.set(e.pointerId, rec);

    // #6 EditMode gate（fail-safe）：transient/非绘画 mode 下，draw 类 role 一律拒绝。
    // 防 role 决策对未知 mode（crop/adjust）fall-through 到 "draw" 而误触 stroke 污染 undo。
    // N10：云端快进（_safePull 换本地字节 + adopt 换画布）进行中，draw-role 走同一降级路径——
    //   防起笔落在「旧内容/半换态」上随后被 adopt 覆盖（FF-wins 已定，故是挡笔而非中止 FF）。
    const _isDrawRole = isPixelStroke(role as string);
    if (_isDrawRole && ((this.editMode && !this.editMode.canDraw()) || this.isContentReplacing())) {
      // touch：保留 pointer 降级成 hold（不画），让后续手指仍能凑成双指/三指手势（undo/redo）。
      //   删 pointer 会让第二指的 activeTouches 计 0 → 手势永远凑不起来。mouse/pen 无多指手势，直接拒。
      if (e.pointerType === "touch") { rec.role = "hold"; return; }
      rec.role = null;
      this.pointers.delete(e.pointerId);
      return;
    }

    // 像素描边前的「可写叶」判定：单谓词 doc.activeEditableLeaf（CONTEXT「requireEditableLeaf」）。
    //   组 = 硬拒（组无像素 canvas）；隐藏叶 = 软拒（v125）。touch 降级 hold + defer 警告（不拦多指
    //   undo/redo 手势——第一指被删则手势凑不起来），单指真作画时（_move hold 分支）才弹；mouse/pen 即拒。
    // **绘画意图**判定用工具而非 role：touch 单指作画关时 brush/橡皮 down 的 role 被降级成 "hold"
    //   （非 _isDrawRole），若只看 role 会漏判 → 落到下方长按吸色，组上画笔"跳成 eyedropper"（无反馈）。
    //   故 hold 也按当前工具的本意（toolToRole）判：是绘画工具就一并拦，给和隐藏层一致的提示。
    const _paintIntent = _isDrawRole
      || (role === "hold" && isPixelStroke(toolToRole(effectiveTool(tool, this.altDown))));
    if (_paintIntent) {
      const { reason } = this.doc.activeEditableLeaf();
      if (reason === "group" || reason === "hidden") {
        const msg = reason === "group" ? "当前选中的是图层组，请选择一个图层再绘制" : "当前图层已隐藏，无法绘制";
        if (e.pointerType === "touch") {
          rec.role = "hold";
          if (reason === "group") rec._deferGroupWarn = true; else rec._deferHiddenWarn = true;
          return;
        }
        this.status(msg);
        rec.role = null;
        this.pointers.delete(e.pointerId);
        return;
      }
    }

    if (isPixelStroke(role as string)) {
      // 画 / 液化 / filter brush 的时候不画 cursor（板子 dirty-rect 用，避免 cursor 撑全屏 dirty）
      this.board.setCursor(null);
      // 锚 smoothing / raw / 压感 状态到 down 点。
      // 防 dx 坑（timeStamp 单调），见 ai-docs/20260527-ipad-coalesced-events.md
      rec.lastRawX = x;
      rec.lastRawY = y;
      rec.lastP = null;
      rec.smP = -1;
      rec.lastEventTs = -Infinity;
      // 即时笔（pixel）二参平滑状态：累积 raw / 死区锚 / EMA 输出(smX/Y 已在 rec 字面量锚为起点)
      rec.rawSX = x; rec.rawSY = y;
      rec.stabX = x; rec.stabY = y;
      if (role === "filterBrush") this._beginFilterBrush(rec);
      else {
        // mode 推断：erase / brush
        const mode = role === "erase" ? "erase" : "brush";
        this._beginStroke(e, rec, mode);
      }
    } else if (role === "lasso") {
      this.board.setCursor(null);
      this._beginLasso(rec, e);
    } else if (role === "pick") {
      this._doPick(x, y);
    } else if (role === "pan") {
      document.body.dataset.panning = "1";
    }

    // 单指长按 → picker（如开启）。pen 不参与；hand 工具下也不触发；
    // 第二根手指进来时 gesture 路径会清掉 timer
    // v0.7.8：fill 工具（role=lasso）也参与——tentative 期（<8px 未成手势）长按吸色，吸到预览色（WYSIWYG）。
    //   仅 tentative：floating 变换拖动（_lassoMode="transform"）不 arm；触发时二次核验防手势已展开。
    const lassoTentative = role === "lasso" && tool === "fill" && rec._lassoMode === "tentative";
    const wantLongPress = e.pointerType === "touch" && tool !== "hand" &&
      (role === "draw" || role === "erase" || role === "pan" || role === "hold" || lassoTentative) &&
      this.getLongPressPickEnabled();
    if (wantLongPress) {
      rec.longPressTimer = setTimeout(() => {
        rec.longPressTimer = null;
        // 把当前的 draw / pan 取消，转入 picker mode
        if (rec.role === "draw" || rec.role === "erase") {
          this._abortStroke();
        } else if (rec.role === "pan") {
          if (![...this.pointers.values()].some((p) => p !== rec && p.role === "pan")) {
            delete document.body.dataset.panning;
          }
        } else if (rec.role === "lasso") {
          if (rec._lassoMode !== "tentative") return;   // 已成拖拽手势（magic-drag 等）→ 不抢
          rec._lassoMode = undefined;                   // tentative 无引擎态，直接放掉
        }
        rec.role = "pick";
        this._doPick(rec.x, rec.y);
        this.status("吸色（长按）");
      }, LONG_PRESS_MS);
    }

    e.preventDefault();
  }

  _move(e: PointerEvent) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) {
      // 没按下时也更新 cursor preview（pen hover / mouse hover）
      if (e.pointerType !== "touch") this._updateCursorPreview(e);
      // v0.6.25 多边形 hover 跟随：会话活着时段预览跟光标（触摸无 hover 自然退化为拖拽预览）
      if (e.pointerType !== "touch" && this.lasso.polygonSessionActive() && this.editMode && !this.editMode.isTransient()) {
        const m = this.editMode.current();
        if (m === "lasso" || m === "fill") {
          const { x, y } = this.board.screenToDoc(e.clientX, e.clientY);
          this.lasso.polygonHover(x, y);
        }
      }
      return;
    }
    rec.x = e.clientX;
    rec.y = e.clientY;
    rec.lastUpdateTs = performance.now();
    if (rec.pointerType === "pen") this._lastPenActivity = rec.lastUpdateTs;  // 掌触 tap 门

    // 单指长按 timer 还在 → 检查是否移动超阈值，超了就取消（当 draw 处理）
    if (rec.longPressTimer) {
      const dx = e.clientX - rec.startX!;
      const dy = e.clientY - rec.startY!;
      if (dx * dx + dy * dy > LONG_PRESS_CANCEL_SQ) {
        clearTimeout(rec.longPressTimer);
        rec.longPressTimer = null;
      }
    }

    if (this.gestureStart) {
      this._updateGesture();
      // gesture tap movement 检查
      if (this._gestureTap && this._gestureTap.isTap) {
        for (const [pid, p] of this.pointers) {
          if (p.role !== "gesture") continue;
          const start = this._gestureTap.startPositions[pid];
          if (!start) continue;
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          if (dx * dx + dy * dy > GESTURE_TAP_MAX_MOVE_SQ) {
            this._gestureTap.isTap = false;
            break;
          }
        }
      }
      e.preventDefault();
      return;
    }

    if (isPixelStroke(rec.role as string)) {
      const spec = pixelStrokeSpec(rec.role as string)!;
      // 画 / 液化 / filter brush 的时候不刷 cursor preview，省一次全屏 dirty
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      let list = (events && events.length) ? events : [e];
      // **液化 / filter brush 丢帧**（spec.coalesceLatest）：每个 event 跑 ~31K typed-array ops，大笔
      // 半径下 coalesced 整批连续跑 → 帧延迟堆积 → 越拖越卡。只跑最新一个（保 timeStamp 滤后的）。
      // 画笔不能丢帧，会断笔/疏密；液化 / filter brush 每帧独立重采样，丢帧 = 跳过细分但形状仍连续。
      if (spec.coalesceLatest && list.length > 1) list = [list[list.length - 1]];
      const settings = spec.usesResolvedBrush ? this.getResolvedBrush() : null;
      for (const ev of list) {
        // **Safari iOS getCoalescedEvents() 边界回放过滤**：每次 pointermove
        // 的 coalesced 列表会把上一批的样本一起带回来 (eg 一批末尾 t=21，下
        // 一批开头又给 t=4..25)。这些"反向小段"被 brush 当真实位移累计进
        // path 长度 → 几十 doc-px 周期的疏密波（鼠标无此问题）。详见
        // ai-docs/20260527-ipad-coalesced-events.md。只接受 timeStamp 严格递增的 event。
        if (ev.timeStamp <= rec.lastEventTs!) continue;
        rec.lastEventTs = ev.timeStamp;
        // raw 几乎没动 → 跳整个 event
        const drx = ev.clientX - rec.lastRawX!;
        const dry = ev.clientY - rec.lastRawY!;
        rec.lastRawX = ev.clientX;
        rec.lastRawY = ev.clientY;
        if (drx * drx + dry * dry < SMOOTH.rawStaticSq) continue;
        // v148/v243: buffered 笔触（brush/erase 非 pixel）位置平滑由引擎做（EMA + 贴笔尖 catch-up）
        //   → input 直传 raw。pixel/liquify/filterBrush 走即时 inputSmooth（死区 + EMA）。
        let psx, psy;
        if (rec.rawToEngine) {
          psx = ev.clientX; psy = ev.clientY;
        } else {
          const sp = inputSmooth(rec as unknown as Parameters<typeof inputSmooth>[0], settings, drx, dry);
          psx = sp.x; psy = sp.y;
        }
        const { x: dx, y: dy } = this.board.screenToDoc(psx, psy);
        // 活动 engine 统一接口：liquify/filterBrush/像素 忽略多余的 pressure/时间戳参数
        //   ev.timeStamp 给主笔刷时间常数平滑用（dt 取真实事件间隔，含 coalesced）
        const pressure = effectivePressureFor(rec, ev);
        this._activeStroke?.engine.extendStroke(dx, dy, pressure, ev.timeStamp);
      }
      // 把活动 engine 累的 dirty bbox 送进 board
      const bbox = this._activeStroke?.engine.flushDirty();
      if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
      this.board.requestRender();
    } else if (rec.role === "lasso") {
      const { x: dx, y: dy } = this.board.screenToDoc(e.clientX, e.clientY);
      if (rec._lassoMode === "tentative") {
        // v134 (user：「用 screen px，不然像素画时 lasso 用不了」)
        //   tap vs drag 阈值 = 8 screen-px 距离（防 pen jitter / mouse 抖）
        //   原本 4 doc-px² 在 32×32 pixel art zoom in 时巨大，永远不升级
        const sdx = e.clientX - rec.startX!;
        const sdy = e.clientY - rec.startY!;
        if (this.lasso.getSubTool() === "magic") {
          // v0.7：魔棒不再 tap-only——超阈值升级 magic-drag（沿路径连续选，一笔=一条 undo）；
          //   tap 语义不变（_endLasso 的 tentative 分支）。红线：所有魔棒路径 try/catch + status。
          if (sdx * sdx + sdy * sdy > 64) {
            rec._lassoMode = "magic-drag";
            try {
              const src = this.doc.getFloodSourceLayer();
              this.lasso.beginMagicDrag();
              this.lasso.magicDragStep(rec._lassoStartDocX!, rec._lassoStartDocY!, src);
              this.lasso.magicDragStep(dx, dy, src);
              this.board.invalidateAll();
            } catch (err) {
              reportError(new Error("[magic-drag] " + String(err)), "log");
              this.status("魔术棒出错：" + ((err as { message?: unknown })?.message || err));
              this.lasso.magicDragCancel();
              rec._lassoMode = "tentative";
            }
          }
          return;
        }
        if (sdx * sdx + sdy * sdy > 64) {
          rec._lassoMode = "drawing";
          this.lasso.beginPath(rec._lassoStartDocX!, rec._lassoStartDocY!);
          this.lasso.extendPath(dx, dy);
        }
      } else if (rec._lassoMode === "selpen") {
        // v0.7.25 选区笔：吃 coalesced（引擎平滑要密点）；预览=stamp overlay 色带（provider 拉取）
        const evs = (e.getCoalescedEvents?.() ?? [e]);
        for (const ev of evs) {
          const { x: mx, y: my } = this.board.screenToDoc(ev.clientX, ev.clientY);
          this.brush.extendStroke(mx, my, effectivePressureFor(rec, ev), ev.timeStamp);
        }
        const bbox = this.brush.flushDirty();
        if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
        this.board.requestRender();
      } else if (rec._lassoMode === "magic-drag") {
        try {
          if (this.lasso.magicDragStep(dx, dy, this.doc.getFloodSourceLayer())) this.board.invalidateAll();
        } catch (err) {
          reportError(new Error("[magic-drag] " + String(err)), "log");
          this.status("魔术棒出错：" + ((err as { message?: unknown })?.message || err));
        }
      } else if (rec._lassoMode === "drawing") {
        this.lasso.extendPath(dx, dy);
      } else if (rec._lassoMode === "transform") {
        this.lasso.extendDrag(dx, dy);
        const bb = this.lasso.getFloatingScreenBbox();
        if (bb) this.board.markDocDirty(bb[0], bb[1], bb[2], bb[3]);
        this.board.requestRender();
      }
    } else if (rec.role === "pick") {
      this._doPick(e.clientX, e.clientY);
    } else if (rec.role === "pan") {
      const dx = e.movementX || (e.clientX - (rec._lastX ?? e.clientX));
      const dy = e.movementY || (e.clientY - (rec._lastY ?? e.clientY));
      rec._lastX = e.clientX;
      rec._lastY = e.clientY;
      this.board.pan(dx, dy);
    } else if (rec.role === "hold") {
      // 隐藏图层 + 单指移动 = 确实想画 → 此刻才弹"图层已隐藏"（down 时推迟到这，避免双指 undo
      //   的第一指在 down 误弹/拦手势）。移动超 tap 阈值才算作画，纯 tap 不弹。
      if (rec._deferHiddenWarn || rec._deferGroupWarn) {
        const dx = e.clientX - rec.startX!, dy = e.clientY - rec.startY!;
        if (dx * dx + dy * dy > GESTURE_TAP_MAX_MOVE_SQ) {
          if (rec._deferGroupWarn) { rec._deferGroupWarn = false; this.status("当前选中的是图层组，请选择一个图层再绘制"); }
          else { rec._deferHiddenWarn = false; this.status("当前图层已隐藏，无法绘制"); }
        }
      }
    }
    e.preventDefault();
  }

  _up(e: PointerEvent, cancelled = false) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    rec.x = e.clientX;
    rec.y = e.clientY;
    if (rec.pointerType === "pen") this._lastPenActivity = performance.now();  // 掌触 tap 门：从抬笔起算
    if (rec.longPressTimer) { clearTimeout(rec.longPressTimer); rec.longPressTimer = null; }

    if (rec.role === "gesture") {
      const remaining = this._gestureTouches().length;
      if (remaining < 2) {
        this._endGesture();
        // 所有 gesture touch 都松手了 → 判定双指 / 三指 tap
        if (remaining === 0 && this._gestureTap) {
          const tap = this._gestureTap;
          this._gestureTap = null;
          const now = performance.now();
          // 从最早触点落下算 tap 时长：掌根久搁 = 慢 tap = 超限剔除（旧口径从第二指到来算漏掉）。
          const elapsed = now - tap.firstDownTime;
          // 笔尖时近性门：写字缝里手掌抖出的"快闪双指"（时长没超但紧邻落笔）也吞掉，绝不误撤销。
          // 真想撤销时笔尖已离屏 > PALM_PEN_GUARD_MS，双指/三指 tap 照常。只挡 tap，pinch/pan 不动。
          const palmGuard = (now - this._lastPenActivity) < PALM_PEN_GUARD_MS;
          if (tap.isTap && elapsed < GESTURE_TAP_MAX_MS && !palmGuard) {
            const act = gestureTapAction(tap.maxCount);   // 2→undo / 3+→redo
            if (act === "undo") { this.ctrlZ(); this.status("双指 · 撤销"); }
            else if (act === "redo") { this.redo(); this.status("三指 · 重做"); }
          }
        }
      } else {
        this._beginGesture();
      }
      return;
    }

    // 屏幕双击切工具：只在 pencil-mode 的手指上生效（同 ScratchPad）
    const tapEligible = !cancelled && rec.downTime &&
      e.pointerType === "touch" && this.penEverSeen &&
      rec.role !== "gesture" && rec.role !== "ignore";
    if (tapEligible) {
      const now = performance.now();
      const dur = now - rec.downTime!;
      const dist = Math.hypot(rec.x - rec.startX!, rec.y - rec.startY!);
      if (isTap(dur, dist, TAP_MAX_DURATION, TAP_MAX_MOVE)) {
        if (isDoubleTap(now, this._lastTap, rec.startX!, rec.startY!, DOUBLETAP_WINDOW, DOUBLETAP_MAX_GAP)) {
          this._lastTap = null;
          window.dispatchEvent(new CustomEvent("wp:doubletap"));
          return;
        }
        this._lastTap = { time: now, x: rec.startX!, y: rec.startY! };
      } else {
        this._lastTap = null;
      }
    }

    if (isPixelStroke(rec.role as string)) {
      if (cancelled) this._abortStroke();
      else this._endStroke();
    } else if (rec.role === "lasso") {
      if (cancelled) this._abortLasso();
      else this._endLasso(rec);
    } else if (rec.role === "pan") {
      if (![...this.pointers.values()].some((p) => p.role === "pan")) {
        delete document.body.dataset.panning;
      }
    }
    // role === "pick"：长按从 brush/eraser 转来的保持原工具不动；
    // 但若是「显式吸管工具」吸完色，弹回 brush（user：吸好色就回笔）。
    else if (rec.role === "pick" && !cancelled &&
             this.editMode && this.editMode.current() === "picker") {
      this._emitTool("brush");
    }
  }

  // ---- 笔画 ----
  // 笔触 = 一个 "stroke" type 的 history entry。endStroke 时 push。
  // entry shape：{ type: "stroke", layerId, before, after, beforeBlob, afterBlob }
  // - before/after = ViewLeaf.snapshot()（bboxX/Y/W/H + imageData）
  // - blob 字段 push 后异步 toBlob 填，填好后释放 imageData
  // 详见 ai-docs/20260527-undo-architecture.md。
  // 即时笔位置平滑在 stroke-input-smooth.js（inputSmooth，死区+EMA，pure·可测）；主笔刷走引擎 stroke-smoother.js。

  _beginStroke(e: PointerEvent, rec: PointerRec, mode: string) {
    const settings = this.getResolvedBrush();
    if (!settings || !this.doc.activeLayer) return;
    // activeLayer 是 Node（叶|组）；上游 activeEditableLeaf 已硬拒组 → 此处确为可写叶。
    const layer = this.doc.activeLayer as ViewLeaf;
    const spec = pixelStrokeSpec(rec.role as string)!;   // draw / erase / shapeBrush → 同 stroke 事务 + finalize
    // engineKey 查表（registry 注释的本意）：draw/erase → brush；shapeBrush → 形状笔。签名一致。
    const eng = this[spec.engineKey as "brush" | "shapeBrush"];
    const token = this.wp2!.begin(spec.historyType);
    this._activeStroke = { engine: eng, token, layer, finalize: spec.finalize, inPlace: !!settings.pixelMode };

    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX!, rec.smY!);
    const pressure = effectivePressureFor(rec, e);
    // v148: buffered（brush/erase 非 pixel）位置平滑由引擎做（lookahead/frozen/tail），
    //   input 直传 raw（见 pointermove 的 rec.rawToEngine 分支）。pixel 仍走四件套。
    //   形状笔恒吃 raw（几何/拟合要原始点；input 平滑会跟吸附打架），pixelMode 也不例外。
    const buffered = !settings.pixelMode;
    rec.rawToEngine = buffered || rec.role === "shapeBrush";
    const scale = this.board.viewport.scale || 1;
    // v249：时间常数指数追踪 + 死区。{tau, deadzone}。
    const smooth = buffered ? _resolveSmooth(settings, scale) : {};
    eng.beginStroke(layer, settings, dx, dy, pressure, mode, smooth, e.timeStamp);
    const bbox = eng.flushDirty();
    if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
    this.board.requestRender();
  }
  // brush / liquify / filterBrush 共享 begin/extend/end/cancel 协议；活动笔画存进 _activeStroke，
  // end / abort / extend / flushDirty 不再按 role 重新分支挑 engine。
  // finalize=true → 有选区时 stroke 只在选区内生效（finalize 里 per-pixel revert outside mask 到 pre）。
  // filterBrush 在 begin 时已吃 selection，finalize=false。
  _endStroke() {
    const as = this._activeStroke;
    if (!as) return;
    this._activeStroke = null;
    // S8：buffered brush 的落层 = board.commitBrushStroke（GPU merge，live 同一 shader → 选区/锁α/
    //   blendMode/opacity 全在 shader，live 即 commit 所见）。其它引擎（liquify/filterBrush/pixel）
    //   在描边中已 in-place 落层，endStroke 只清状态。
    let gpuCommitted = false;
    // endStroke 返 StampCollect（brush/形状笔的 buffered 路径）→ GPU commit；
    //   liquify/filterBrush/pixelMode 返 null/undefined（描边中已 in-place 落层）→ 只清状态。
    const cs = as.engine.endStroke() ?? null;
    if (cs && cs.stamps.length) gpuCommitted = this.board.commitBrushStroke(cs);
    // finalize（applyMaskPostStroke CPU 兜选区）只兜没走 GPU commit 的路径（pixel 笔/液化）：
    //   GPU commit 的选区已由 shader 裁（与 live 一致），再兜是重复劳动 + 一次整层物化。
    //   v2：pre 图从 collector 现算（tokenBeforeImage）——只有真动过层且带选区才付物化钱；
    //   兜出来的回写仍在令牌内（首捕获已在，undo 包不变）。no-op 笔画 = collector 空 = commit 不占步。
    const sel = (as.finalize && !gpuCommitted && this.layerTiles!.tokenChanged(as.layer.id)) ? this.doc.selection : null;
    if (sel) {
      sel.applyMaskPostStroke(
        as.layer as unknown as Parameters<Selection["applyMaskPostStroke"]>[0],
        this.layerTiles!.tokenBeforeImage(as.layer.id));
    }
    as.token.commit();
    // 抬笔 commit：像素已落 layer → invalidateAll 触发重渲 + GL markContentDirty。
    this.board.invalidateAll();
  }
  _abortStroke() {
    const as = this._activeStroke;
    if (!as) return;
    this._activeStroke = null;
    as.engine.cancelStroke();
    as.token.cancel();   // collector 倒序回滚（取代旧整层快照 restore）
    this.board.invalidateAll();
  }
  // 任一像素笔画进行中（brush / 像素笔 / liquify / filterBrush / 形状笔 都设 _activeStroke）。
  // board._strokeActiveHint 用它判 livePreview（描边中走直接合成 / GL 门控），含像素笔/liquify/filterBrush。
  isStrokeActive() { return !!this._activeStroke; }
  // GPU stamp overlay 拉取口（app 接给 board.setStampProvider）：当前活动引擎的 stamps。
  //   brush 与形状笔都有 collectStamps；liquify/filterBrush 无（in-place，走 live-sync）。
  collectActiveStamps(): ReturnType<BrushEngine["collectStamps"]> {
    // v0.7.25 选区笔：同一 overlay 拉取口出色带预览（selPenBand 旗 → board 跳过 selMask/lockAlpha 裁剪）
    if (this._selPenLive) {
      const cs = this.brush.collectStamps();
      return cs ? (Object.assign(cs, { selPenBand: true }) as typeof cs) : null;
    }
    const eng = this._activeStroke?.engine as { collectStamps?: () => ReturnType<BrushEngine["collectStamps"]> } | undefined;
    return eng?.collectStamps?.() ?? null;
  }
  // 公开取消口（toolbar 描边中切形状笔子工具 = cancel 不进 undo，同画一半被手势接管）
  abortActiveStroke() { this._abortStroke(); }

  // GL live-sync 接缝：描边中原地改像素的笔（liquify/filterBrush/pixelMode brush）→ 返回活动叶，
  //   board 每帧把它重传 GPU 才能显 live 预览（buffered brush 走 GPU stamp overlay，返 null）。非描边 / overlay 笔 → null。
  liveMutatedLeaf(): ViewLeaf | null {
    const as = this._activeStroke;
    if (!as || !as.inPlace) return null;
    const layer = this.doc.activeLayer;
    return (layer && !(layer as ViewLeaf).isGroup) ? (layer as ViewLeaf) : null;
  }

  // ---- Filter brush (v132) ----
  // 一笔 = 1 个 "stroke" history entry（schema 同笔触）
  // brushSettings 从 getResolvedBrush() 拿（沿用当前画笔 size / hardness / spacing / opacity）
  // filter + params 从 getFilterBrushState() 拿（app.js 在进入 filter brush 模式时 set）
  _beginFilterBrush(rec: PointerRec) {
    const fbState = this.getFilterBrushState();
    const brushSettings = this.getResolvedBrush();
    if (!fbState || !fbState.Filter || !brushSettings || !this.doc.activeLayer) {
      rec.role = null; return;
    }
    const layer = this.doc.activeLayer as ViewLeaf;   // 组已被上游硬拒，此处确为叶
    const spec = pixelStrokeSpec(rec.role as string)!;   // filterBrush → "stroke" 事务，finalize:false
    const token = this.wp2!.begin(spec.historyType);
    // filterBrush 在 beginStroke 时已吃了 selection，stamp 内 mask 外保留 pre → 无需 post-stroke finalize（spec.finalize=false）
    this._activeStroke = { engine: this.filterBrush, token, layer, finalize: spec.finalize, inPlace: true };
    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX!, rec.smY!);
    const pressure = effectivePressureFor(rec, { pressure: rec.lastP ?? 1 });
    try {
      // fbState.Filter 对 input 不透明（BrushFilter 未 export）→ 在引擎接缝处断言到 beginStroke 入参类型。
      this.filterBrush.beginStroke(layer, fbState.Filter as Parameters<FilterBrushEngine["beginStroke"]>[1], fbState.params, brushSettings, this.doc.selection, dx, dy, pressure);
    } catch (e) {
      reportError(new Error("[filter brush] begin failed: " + String(e)), "log");
      token.cancel();   // 令牌必须收口，否则后续 begin 全被单令牌门挡死
      this._activeStroke = null;
      rec.role = null;
      this.status?.(`filter brush 出错：${(e as { message?: unknown })?.message || e}`);
      return;
    }
    const bbox = this.filterBrush.flushDirty();
    if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
    this.board.requestRender();
  }

  // ---- 套索 ----（v65 重构：lasso 只编辑选区 doc.selection；变换是显式按钮）
  //   floating 状态（transform 中）：hit-test handle / 内部拖；空白无操作（必须走应用/取消）
  //   非 floating：pointerdown 进 tentative；超阈值后按 subTool 分支：
  //     freehand → drawing-freehand
  //     rect     → drawing-rect
  //     magic    → magic-tentative（pointerup 时立即 flood fill）
  _beginLasso(rec: PointerRec, e?: PointerEvent) {
    if (!this.doc.activeLayer) { rec.role = null; return; }
    const { x: dx, y: dy } = this.board.screenToDoc(rec.x, rec.y);
    if (this.lasso.state() === "floating") {
      const hit = this.lasso.hitTest(dx, dy, this.board.viewport.scale);
      if (hit) {
        rec._lassoMode = "transform";
        this.lasso.beginDrag(hit, dx, dy);
        return;
      }
      // floating 外按下：no-op（防误触自动 commit；走应用 / 取消按钮）
      rec.role = null;
      return;
    }
    // v0.7.25 选区笔（子工具 "pen"）：down 即起笔——走笔刷引擎 buffered 生命周期（spacing/压感/
    //   taper/平滑动力学零重写，user：「不接 ResolvedBrush 才会屎山」），lasso 状态机不介入。
    //   全程不写任何 layer 像素（buffered 笔画活在 smoother buffer，抬笔才阈值化成选区）。
    // v0.7.26 笔架化（user：「加一个选区笔就行了」）：吃 getResolvedBrush()——lasso/fill 的 rack key
    //   已映射 "selPen"（第四类别，出厂三支：硬圆/勾线/像素），色带覆写在 selPenSettingsFrom。
    if (this.lasso.getSubTool() === "pen") {
      const { leaf } = this.doc.activeEditableLeaf();
      if (!leaf) { this.status("请先选中一个图层（选区笔预览需要锚点）"); rec.role = null; return; }
      const base = this.getResolvedBrush();
      if (!base) { rec.role = null; return; }
      const settings = selPenSettingsFrom(base);
      this._selPenPixel = !!base.pixelMode;   // 抬笔走 Bresenham disc 精确落纸（像素笔手感）
      rec._lassoMode = "selpen";
      rec.rawToEngine = true;
      // 压感/平滑状态锚定（v0.7.26 卡死修复：漏了 smP 初始化 → NaN 压感 → 引擎 spacing 死循环）
      rec.lastRawX = rec.x; rec.lastRawY = rec.y;
      rec.lastP = null; rec.smP = -1; rec.lastEventTs = -Infinity;
      const scale = this.board.viewport.scale || 1;
      const pressure = e ? effectivePressureFor(rec, e) : 0.5;
      this.brush.beginStroke(leaf as ViewLeaf, settings, dx, dy, pressure, "brush", _resolveSmooth(settings, scale), e?.timeStamp ?? performance.now());
      this._selPenLive = true;
      const bbox = this.brush.flushDirty();
      if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
      this.board.requestRender();
      return;
    }
    rec._lassoMode = "tentative";
    rec._lassoStartDocX = dx;
    rec._lassoStartDocY = dy;
  }
  _endLasso(rec: PointerRec) {
    if (rec._lassoMode === "selpen") { this._endSelPen(); return; }
    if (this.lasso.getSubTool() === "polygon" && (rec._lassoMode === "drawing" || rec._lassoMode === "tentative")) {
      this._polygonUp(rec);   // 多边形：一笔=落一个顶点（首笔 p1→p2 连落两个）；点回起点=闭合
      return;
    }
    if (rec._lassoMode === "magic-drag") {
      // v0.7 魔棒 drag 收笔：会话期间预览已直写 doc.selection，这里一次性入 undo（一笔一整点）
      try {
        const entry = this.lasso.magicDragEnd();
        if (entry) { this._pushSelEntry(entry); this.board.invalidateAll(); }
      } catch (e) {
        reportError(new Error("[magic-drag end] " + String(e)), "log");
        this.status("魔术棒出错：" + ((e as { message?: unknown })?.message || e));
        this.lasso.magicDragCancel();
      }
      return;
    }
    if (rec._lassoMode === "drawing") {
      try {
        const entry = this.lasso.endPath(this.doc.getFloodSourceLayer());
        if (entry) {
          this._pushSelEntry(entry);
          this.board.invalidateAll();
        } else {
          // v125: rasterize 后全在 doc 外 → status 提示，不静默
          this.lasso.cancelDrawing();
          this.status("选区全在画布外，已取消");
        }
      } catch (e) {
        reportError(new Error("[lasso end] " + String(e)), "log");
        this.status("选区操作出错：" + ((e as { message?: unknown })?.message || e));
        this.lasso.cancelDrawing();
      }
    } else if (rec._lassoMode === "transform") {
      this.lasso.endDrag();
    } else if (rec._lassoMode === "tentative") {
      // 没拖到阈值
      const sub = this.lasso.getSubTool();
      if (sub === "magic") {
        // 魔术棒就是 tap-only
        try {
          const { x: dx, y: dy } = this.board.screenToDoc(rec.x, rec.y);
          this.lasso.beginPath(dx, dy);
          const entry = this.lasso.endPath(this.doc.getFloodSourceLayer());
          if (entry) {
            this._pushSelEntry(entry);
            this.board.invalidateAll();
          } else {
            this.status("魔术棒：tap 在线 / 边界上，没选到");
          }
        } catch (e) {
          reportError(new Error("[magic-wand] " + String(e)), "log");
          this.status("魔术棒出错：" + ((e as { message?: unknown })?.message || e));
        }
      } else {
        // v134 (user：「自由/矩形/圆 单击在新建选区模式下 = 取消当前选区」)
        //   add / subtract / intersect 模式 = 防误触静默（user 还想加，但 tap 不应改）
        if (this.lasso.getSetOpMode() === "new" && this.lasso.hasSelection()) {
          this._pushSelEntry(this.lasso.setSelection(null));
          this.board.invalidateAll();
          this.status("已取消选区");
        }
      }
    }
  }
  // 多边形套索（v0.6.19）：up = 落顶点；≥3 顶点后收笔点距起点 ≤14 screen px = 闭合。
  //   tap 在 polygon 下不再是「清选区」（落点语义优先；清选区走 Esc/Ctrl+D/去选钮）。
  _polygonUp(rec: PointerRec) {
    const { x: dx, y: dy } = this.board.screenToDoc(rec.x, rec.y);
    const first = this.lasso.polygonFirstVertex();
    if (first && this.lasso.polygonVertexCount() >= 3) {
      const s0 = this.board.docToScreen(first.x, first.y);
      if (Math.hypot(s0.x - rec.x, s0.y - rec.y) <= 14) { this._polygonClose(); return; }
    }
    if (rec._lassoMode === "drawing" && this.lasso.polygonVertexCount() === 0) {
      this.lasso.polygonAddVertex(rec._lassoStartDocX!, rec._lassoStartDocY!);   // 首笔起点也是顶点
    }
    this.lasso.polygonAddVertex(dx, dy);
    this.board.requestRender();
  }
  _polygonClose() {
    try {
      const entry = this.lasso.polygonClose();
      if (entry) { this._pushSelEntry(entry); this.board.invalidateAll(); }
      else this.status("多边形选区无效（不足三点 / 全在画布外），已取消");
    } catch (e) {
      reportError(new Error("[polygon close] " + String(e)), "log");
      this.status("选区操作出错：" + ((e as { message?: unknown })?.message || e));
      this.lasso.polygonCancelSession();
    }
    this.board.requestRender();
  }
  _commitLasso() {
    // T4b：accept 的令牌编排（烤层像素写时扣押 + FloatLayerComponent.drop，一个整点）
    // 全在 FloatingTransform；旧「commit 返回手拼 entry → 这里再 push」链死。
    if (!this.lasso.commit()) return;
    this.board.invalidateAll();
  }
  // ---- v0.7.25 选区笔（lasso 子工具 "pen"）状态 + 出入口；v0.7.26 配置全归笔架（无自有 knob）----
  _selPenPixel = false;   // 起笔时记住笔架笔的 pixelMode（抬笔选 CPU disc 路径）
  _selPenLive = false;
  selPenStrokeActive() { return this._selPenLive; }
  /** 抬笔：stamps → alpha → ≥128 二值 → setOp 合成（一笔一条 selectionChange；蚂蚁线此刻才更新=A 档拍板） */
  _endSelPen() {
    if (!this._selPenLive) return;
    this._selPenLive = false;
    const cs = this.brush.endStroke() ?? null;
    if (!cs || !cs.stamps.length) { this.board.requestRender(); return; }
    // 软边笔 → GPU 光栅（阈值化）；pixelMode 笔/GL 不可用 → 引擎 Bresenham disc 同核 CPU 光栅
    let mask = this._selPenPixel ? null : this.board.rasterizeStampsToMask(cs);
    if (!mask) {
      const g = stampsToBinaryGray8(cs.stamps, cs.bx, cs.by, cs.bw, cs.bh,
        (buf, rw, rh, ox, oy, ix, iy, n) => this.brush.pixelDiscInto(buf, rw, rh, ox, oy, ix, iy, n, { r: 0, g: 0, b: 0 }, 1, "over"));
      mask = { x: cs.bx, y: cs.by, w: cs.bw, h: cs.bh, g };
    }
    let any = false;
    for (let i = 0; i < mask.g.length; i++) if (mask.g[i]) { any = true; break; }
    if (!any) { this.board.requestRender(); return; }
    const sel = Selection.fromGray8Region(mask.x, mask.y, mask.w, mask.h, mask.g);
    if (!sel) { this.board.requestRender(); return; }
    const entry = this.lasso._applySelectionUpdate(sel);
    if (entry) this._pushSelEntry(entry);
    this.board.invalidateAll();
  }
  _abortSelPen() {
    if (!this._selPenLive) return;
    this._selPenLive = false;
    this.brush.cancelStroke();
    this.board.requestRender();
  }
  _abortLasso() {
    this._abortSelPen();   // v0.7.25：双指手势/pointercancel 里选区笔无痕丢弃（同 cancelDrawing 语义）
    // floating（变换中）→ 还原 pre-snapshot
    if (this.lasso.state() === "floating") {
      this.lasso.cancel();
      this.board.invalidateAll();
    } else {
      // drawing-freehand / drawing-rect / magic-tentative → 丢弃，不进 history
      this.lasso.cancelDrawing();
    }
  }
  // 给外部（tool 切换、Esc）用：commit 当前 floating（如果有）。
  commitLassoIfFloating() {
    if (this.lasso.state() === "floating") this._commitLasso();
  }

  // ---- 吸色 ----
  _doPick(sx: number, sy: number) {
    const { x: dx, y: dy } = this.board.screenToDoc(sx, sy);
    const ix = Math.floor(dx), iy = Math.floor(dy);
    if (ix < 0 || iy < 0 || ix >= this.doc.width || iy >= this.doc.height) {
      window.dispatchEvent(new CustomEvent("wp:pickerHide"));
      return;
    }
    // 两种取样模式（吸色 context toolbar 的下拉，state.pickMode）：
    //   "layer"     = 当前编辑图层的 **raw 像素**（无视该层叠加模式 / clip / 图层 opacity）；
    //                 active 是组 / 无可取叶 → 退回 composite。
    //   "composite" = **最终合成可见颜色**（S8：render-tree 一次性 GPU 合成 + 1px readback，
    //                 respect mode+clip+组隔离；合成组没有 CPU tile，必须 GPU 读，spec:243-244）。
    // 两路都 over doc 背景得不透明色。
    let px;
    const active = this.doc.activeLayer;
    if (this.getPickMode() === "layer" && active && !active.isGroup && active.sampleAt) {
      px = active.sampleAt(ix, iy);
    } else {
      px = this.board.pickCompositeColor(ix, iy) ?? [0, 0, 0, 0];
    }
    const bg = parseHex(this.doc.backgroundColor || "#ffffff");
    const la = px[3] / 255;
    const inv = 1 - la;
    const r = px[0] * la + bg.r * inv;
    const g = px[1] * la + bg.g * inv;
    const b = px[2] * la + bg.b * inv;
    const hex = "#" +
      [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    this.onColorSampled(hex);
    this.status(`吸色 ${hex}`);
    // v124 吸色 pin (user：「Google Maps pin 风格，pin 头颜色 / pin 尖中选 pixel」)
    window.dispatchEvent(new CustomEvent("wp:pickerShow", { detail: { sx, sy, hex } }));
  }

  // ---- gesture ----
  _gestureTouches() {
    return [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
  }
  // 进 / 升级 gesture 时刷一遍 tap 快照
  _updateGestureTapSnapshot() {
    const touches = this._gestureTouches();
    if (!this._gestureTap) {
      this._gestureTap = {
        startTime: performance.now(),
        firstDownTime: Infinity,
        isTap: true,
        maxCount: 0,
        startPositions: {},
      };
    }
    for (const [pid, p] of this.pointers) {
      if (p.role === "gesture" && !(pid in this._gestureTap.startPositions)) {
        this._gestureTap.startPositions[pid] = { x: p.x, y: p.y };
        // 掌根久搁再抬：downTime 很早 → firstDownTime 很早 → 抬手 elapsed 超限，不算 tap。
        // 旧口径从第二指到来算，抓不到"掌 blob 早压着、第二个 blob 才刚冒"的慢 tap。
        if (p.downTime != null && p.downTime < this._gestureTap.firstDownTime) {
          this._gestureTap.firstDownTime = p.downTime;
        }
      }
    }
    if (touches.length > this._gestureTap.maxCount) {
      this._gestureTap.maxCount = touches.length;
    }
  }
  _beginGesture() {
    const t = this._gestureTouches();
    if (t.length < 2) return;
    const [a, b] = t;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    this.gestureStart = {
      dist,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      angle: Math.atan2(dy, dx),          // 起手两指连线角度
      vp: { ...this.board.viewport },
      lastDist: dist,                     // 追踪末距（松手时触点已 <2，现场取不到）
      lastAngle: Math.atan2(dy, dx),      // v0.6.59：追踪末角（旋转门用）
      velEma: 0,                          // v0.6.57：滤波后的间距变化率（px/s，负=收拢）
      lastMoveT: performance.now(),
    };
    document.body.dataset.panning = "1";
  }
  _updateGesture() {
    const t = this._gestureTouches();
    if (t.length < 2 || !this.gestureStart) return;
    const [a, b] = t;
    // v0.6.57：EMA 追踪间距变化率（复位判定用）。dt 用 wall clock（_updateGesture 每
    //   pointermove 调一次，事件 timeStamp 不在手边；EMA 对 dt 抖动不敏感）。
    const g = this.gestureStart;
    const newDist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const now = performance.now();
    const dt = now - g.lastMoveT;
    if (dt > 0) {
      const alpha = 1 - Math.exp(-dt / QUICK_PINCH_FIT_TAU_MS);
      g.velEma += alpha * ((newDist - g.lastDist) / (dt / 1000) - g.velEma);
      g.lastMoveT = now;
    }
    g.lastDist = newDist;
    g.lastAngle = Math.atan2(b.y - a.y, b.x - a.x);   // v0.6.59：旋转门
    // anchor-preserving 双指变换数学已抽到 pointer-gesture.js（纯函数·可单测）。
    // 旋转**不**在此 snap（进行中吸附粘手）；松手由 _endGesture/snapRotation 吸。
    const vp = computePinchViewport(this.gestureStart, a, b, {
      minScale: this.board.minScale, maxScale: this.board.maxScale,
      docW: this.board.doc.width, docH: this.board.doc.height,
    });
    this.board.setViewport(vp.tx, vp.ty, vp.scale, vp.rot);
  }
  _endGesture() {
    const g = this.gestureStart;
    this.gestureStart = null;
    delete document.body.dataset.panning;
    // v0.6.57 快速捏合复位 = release-velocity 判定（Procreate 方言，grill 定案 2026-07-30）：
    //   松手瞬间仍在快速收拢（滤波速度 ≤ -SPEED）且净收拢（末距 < 起手距）→ fitToScreen
    //   （含旋转复位，user 拍板「旋转也一起复位」）。「缩→停→抬」松手时速度衰减≈0 不触发；
    //   两指 tap（undo）间距几乎不变不触发。
    //   **停顿衰减**：手指停住时 pointermove 不再来、EMA 会冻结在最后的运动值——按
    //   「距最后一次移动的时长」把速度指数衰减，停 ≥100ms 再抬就读≈0，不吃陈旧速度。
    const velAtLift = g ? g.velEma * Math.exp(-(performance.now() - g.lastMoveT) / QUICK_PINCH_FIT_TAU_MS) : 0;
    // v0.6.59：旋转门（累计转角 <30°，wrap 到 [-π,π]）+ 比例门（末距 < 起手 × 2/3）
    const rotDelta = g ? Math.abs(Math.atan2(Math.sin(g.lastAngle - g.angle), Math.cos(g.lastAngle - g.angle))) : 0;
    if (g && velAtLift <= -QUICK_PINCH_FIT_SPEED &&
        rotDelta < QUICK_PINCH_FIT_MAX_ROT &&
        g.lastDist < g.dist * QUICK_PINCH_FIT_RATIO) {
      this.board.fitToScreen();
      this.status(t("tm.viewportReset"));
      return;   // 已复位，不再跑旋转吸附
    }
    // 松手时旋转吸附（±5° 内吸到 0/90/180/270°；进行中不吸=不粘手）。判定见 pointer-gesture.js。
    const cur = this.board.viewport.rot;
    const snapped = snapRotation(cur, 5);
    if (snapped !== null) {
      // pivot 用**屏幕中心**而非 doc 原点：旧实现 tx/ty 不变只改 rot = 绕 doc 原点转，
      // 放大很多时 5° 吸附会把可见内容平移一大段（"弹一下"）。rotateAt 绕 screen anchor 转、
      // 自动补 tx/ty，屏幕中心点保持不动，吸附只是把画面摆正、不平移。
      const w = this.board.canvas.clientWidth || window.innerWidth;
      const h = this.board.canvas.clientHeight || window.innerHeight;
      this.board.rotateAt(w / 2, h / 2, snapped - cur);
    }
  }

  // ---- wheel ----
  _wheel(e: WheelEvent) {
    e.preventDefault();
    // 鼠标滚轮 vs 触摸板（启发式，不完美）：
    //   滚轮 = 离散大步：deltaMode≠PIXEL（Firefox LINE 模式），或 deltaX=0 且 |deltaY|≥50（Chrome 一格 ±100/120）
    //   触摸板 = 连续小 delta（常带 deltaX 分量、deltaMode=PIXEL）
    // (user：「windows 下鼠标滚轮缩放而不是上下滚动」) → 滚轮直接缩放；触摸板双指滚动 = 平移。
    const likelyMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
    if (e.ctrlKey || e.metaKey || likelyMouseWheel) {
      // ctrl+滚轮 = pinch；鼠标滚轮 = 直接缩放。一格 deltaY=±100/120 → 系数 0.01 太狠，按格走 1.1x。
      const dy = e.deltaY;
      const factor = Math.abs(dy) >= 50
        ? Math.exp(-Math.sign(dy) * 0.1)     // 离散一格 ≈ 1.105x
        : Math.exp(-dy * 0.005);             // 连续（trackpad pinch）
      this.board.zoomAt(e.clientX, e.clientY, factor);
    } else {
      // 触摸板双指滚动 = 平移
      let dx = -e.deltaX, dy = -e.deltaY;
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
      this.board.pan(dx, dy);
    }
  }

  // ---- 键盘 ----
  // v124 (user：「统一快捷键注册收集，不会改了这里忘了那里」)
  // KEYBOARD_SHORTCUTS 一个数组 = 唯一真理源：
  //   - _keydown 按这个表 dispatch
  //   - app.js 菜单的"快捷键"面板从这里读 desc 渲染
  // 加新快捷键：只改这一个数组。
  _keydown(e: KeyboardEvent) {
    // 只对**真文本输入**吞快捷键（它们需要打字 + 自己的 Ctrl+Z）。range/checkbox/radio/button
    // 也是 INPUT，但不吃文本——不能整体 return：画布 pointerdown 是 preventDefault 的，点画布
    // **夺不回焦点**，一旦点过工具条滑条/勾选框，焦点就永久困在控件里 → 全部快捷键假死
    // （v0.5.5 油漆桶工具条真机撞上：Ctrl+Z 多次无反应，摆弄别的 UI 才恢复）。
    const tgt = e.target as HTMLElement | null;
    if (tgt) {
      const tag = tgt.tagName;
      const type = (tgt as HTMLInputElement).type;
      const isTextEntry = tag === "TEXTAREA" ||
        (tag === "INPUT" && type !== "range" && type !== "checkbox" && type !== "radio" && type !== "button") ||
        tgt.isContentEditable;
      if (isTextEntry) return;
    }
    // Space hold = 临时 pan（特殊：需 keyup 解除，独立 state）
    if (e.code === "Space" && !this.spaceDown) {
      this.spaceDown = true;
      document.body.dataset.spacePan = "1";
      e.preventDefault();
      return;
    }
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      this.altDown = true;
    }
    // Shift hold = 形状笔约束临时反转（行业惯例：PS/Figma 画线 Shift 约束、Blender Ctrl 反转 snap）
    if (e.key === "Shift") this.shapeBrush.setConstrainInvert(true);
    for (const sc of KEYBOARD_SHORTCUTS) {
      if (sc.when && !sc.when(this)) continue;
      if (!_matchCombo(e, sc.combo)) continue;
      try { sc.run(this); } catch (err) { reportError(new Error("[shortcut] " + sc.combo + " " + String(err)), "log"); }
      e.preventDefault();
      return;
    }
  }
  _keyup(e: KeyboardEvent) {
    if (e.code === "Space") {
      this.spaceDown = false;
      delete document.body.dataset.spacePan;
    }
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      this.altDown = false;
    }
    if (e.key === "Shift") this.shapeBrush.setConstrainInvert(false);
  }
  _emitTool(tool: string) { window.dispatchEvent(new CustomEvent("wp:settool", { detail: tool })); }
  _adjustSize(delta: number) { window.dispatchEvent(new CustomEvent("wp:adjsize", { detail: delta })); }

  // undo / redo / canUndo / canRedo 现在都走共享 history（v44 起）。
  // 留这几个 wrapper 给绑了快捷键 / 老 listener 用，**不**自己保存状态。
  // v0.4.7（S6）：transform transient 的 ctrl-z 语义从「取消」改「history」（spec:214——lift/拖动/
  //   stamp 都在栈上，undo 逐整点回退；undo 过 lift 自然退出浮层）。crop/adjust 仍 abort-transient。
  canUndo() {
    if (this.editMode && this.editMode.isTransient() && this.editMode.ctrlZMeans() === "abort-transient") return true;   // crop/adjust：ctrl-z = 取消
    return !!this.history && this.history.canUndo();
  }
  canRedo() {
    if (this.editMode && this.editMode.isTransient() && this.editMode.ctrlZMeans() === "abort-transient") return false;  // crop/adjust 期间无 redo 语义
    return !!this.history && this.history.canRedo();
  }
  // #6 ctrl-z 路由（所有 undo 入口走这：键盘 Ctrl+Z / 双指 tap / undo 按钮）。
  // 语义由 EditMode 决定：transient(abort-transient) = 取消当前 transient（crop/adjust）；
  // 否则 = 正常 history undo（transform 走这条：变换微整点逐个回退）。
  ctrlZ() {
    if (this.editMode && this.editMode.ctrlZMeans() === "abort-transient") {
      this.editMode.abortTransient();
      return;
    }
    this.undo();
  }
  undo() {   // 纯 history undo（crop/adjust 的取消走 ctrlZ → editMode.abortTransient）
    if (this.history) this.history.undo();
  }
  redo() {
    if (this.editMode && this.editMode.isTransient() && this.editMode.ctrlZMeans() === "abort-transient") return;   // crop/adjust 期间禁 redo
    if (this.history) this.history.redo();
  }
  clearHistory() {
    if (this.history) this.history.clear();
    // 换文档：浮层状态直接清（不走 undo——栈都没了）+ lasso 状态对齐。
    this.wp2?.floatLayer.dropForLoad();
    this.lasso.polygonCancelSession();   // 换文档：多边形会话丢弃（interrupt=cancel 家规）
    this.lasso.syncFloating();
  }

  // 选区变化 entry（lasso.setSelection/endPath 产，选区已应用）→ SelectionComponent 记账（T5：直写组件 verb）。
  _pushSelEntry(entry: SelectionChangeEntry | null | undefined) {
    if (!entry || !this.wp2 || !this.history) return;
    this.history.withPoint("selection", {}, () => this.wp2!.selection.commitPreApplied((entry.before ?? null) as Selection | null));
  }

  // ---- 防误触 / ghost pointer 清理 ----
  // iOS 在 PalmRejection / 系统 gesture 抢断 / 应用切换时偶尔不发 pointerup。
  // ghost pointer 留在 map 里会让单指 → 误判为双指 gesture，画布一直转。
  // user 反馈 2026-05-28：长画时容易遇到。
  _purgeStalePointers() {
    const now = performance.now();
    const STALE_MS = 1500;       // 单纯触摸 1.5s 没有事件 = 八九不离十丢了 up
    const stale = [];
    for (const [pid, p] of this.pointers) {
      if (p.lastUpdateTs != null && (now - p.lastUpdateTs) > STALE_MS) {
        stale.push(pid);
      }
    }
    for (const pid of stale) this._discardPointer(pid);
    if (stale.length) this._maybeEndGesture();
  }
  // 笔尖落下时把所有 touch 当掌触清掉（含可能没收 up 的 ghost）
  _purgeAllTouches() {
    const dead = [];
    for (const [pid, p] of this.pointers) {
      if (p.pointerType === "touch") dead.push(pid);
    }
    for (const pid of dead) this._discardPointer(pid);
    if (dead.length) this._maybeEndGesture();
  }
  _discardPointer(pid: number) {
    const p = this.pointers.get(pid);
    if (!p) return;
    if (p.longPressTimer) { clearTimeout(p.longPressTimer); p.longPressTimer = null; }
    // 如果它正在执笔，把笔触状态也收尾掉（保留 history entry）
    if (isPixelStroke(p.role as string)) this._abortStroke();
    else if (p.role === "lasso") this._abortLasso();
    try { this.canvas.releasePointerCapture?.(pid); } catch {}
    this.pointers.delete(pid);
  }
  _maybeEndGesture() {
    if (this.gestureStart && this._gestureTouches().length < 2) {
      this._endGesture();
    }
  }

  // v111: blanket reset 用于 iPad PWA 系统手势抢断 / 双击误触 window drag 后
  //       app.js 全局监听 window pointercancel / visibilitychange / blur 都调它
  cancelAllPointers() {
    const all = [...this.pointers.keys()];
    for (const pid of all) this._discardPointer(pid);
    this._maybeEndGesture();
  }
}

// （v0.4.5：compressPixelSnap/applyPixelSnap 随 pixel-edit 退场——快照底座换 tile 句柄后无压缩舞蹈。）

// 抬笔瞬间 e.pressure === 0 → 沿用 rec.lastP，不退回 0.5（v4）。
// 起手 warmup 也 0 但 lastP 还没 → 退到 **0.2**（v6，原本 0.5 → 起手鼓 bulb）。
// 算完 raw 后过一道 LPF（rec.smP，α=PRESSURE_SMOOTH_ALPHA）做 stabilizer，
// damp 10Hz 抖动 + 削传感器尖刺。sentinel rec.smP < 0 → 首颗用 raw（tap 满压）。
// 注：这里永远 return 真值。压感**是否**影响 size/opacity/flow 由每笔的 sizeCoeff / opaCoeff / flowCoeff
// 决定（brush.ts 的 signedLerp，0=不响应）。v409 删了 pressureToSize/pressureToOpacity——那对字段
// 从 v30 起就没人读了，这条注释在此之前一直是假的。
// v0.6.15 禁用笔压（左栏 size 栏的 toggle）：开 = 忽略传感器，恒定 0.5（与鼠标路径同值）。
//   SSoT = desk.pressureDisabled（per-doc desk，跟 ora 走；user 2026-07-25「显然是 editor state」），
//   绑在 dialReactive.pressureOff。引擎侧 thunk 惰性读（每 pointer 事件求值），app boot 时接线。
let _pressureOff: () => boolean = () => false;
export function bindPressureDisabled(fn: () => boolean): void { _pressureOff = fn; }

function effectivePressureFor(rec: PointerRec, ev: { pointerType?: string; pressure?: number }): number {
  let raw: number;
  if (_pressureOff() || ev.pointerType === "mouse") {
    raw = 0.5;
  } else {
    const r = typeof ev.pressure === "number" ? ev.pressure : null;
    if (r == null || r === 0) {
      raw = rec.lastP != null ? rec.lastP : 0.2;
    } else {
      raw = Math.max(0.05, Math.min(1, r));
      rec.lastP = raw;
    }
  }
  // v0.7.26 硬化：smP 未初始化/NaN 一律重置（v0.7.25 选区笔漏初始化 → NaN 压感 → 引擎 spacing
  //   走步 while(true) 的 break 条件遇 NaN 永假 → 鼠标一点就死循环。负号哨兵语义不变。
  if (!(rec.smP! >= 0)) rec.smP = raw;
  else rec.smP! += SMOOTH.pressureAlpha * (raw - rec.smP!);
  return rec.smP!;
}

function parseHex(hex: string | null | undefined) {
  if (!hex || hex[0] !== "#") return { r: 255, g: 255, b: 255 };
  if (hex.length === 7) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[1] + hex[1], 16),
      g: parseInt(hex[2] + hex[2], 16),
      b: parseInt(hex[3] + hex[3], 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}
