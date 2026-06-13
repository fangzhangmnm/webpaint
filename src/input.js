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
//     touch (无 pen)         → 单指拖 = 画；双指 = pan+pinch
//     touch (本机见过 pen)   → 永远不画；单指=pan，双指=pan+pinch
//     mouse 左键             → 画/擦/吸
//     mouse 中/右键          → pan
//     按住 Space             → 临时 pan
//   tool=hand:
//     任意 pointer 拖动      → pan
//
//   wheel:
//     ctrlKey (pinch)        → 以光标为中心缩放
//     else                   → 平移

import { BrushEngine } from "./brush.js";
import { LiquifyEngine } from "./liquify.js";
import { LassoEngine } from "./lasso.js";
import { ShapesEngine } from "./shapes.js";
import { FilterBrushEngine } from "./filter-brush.js";
import { isPixelStroke, pixelStrokeSpec, isDrawGated } from "./engine-registry.js";
import { computePinchViewport, snapRotation, isTap, isDoubleTap, gestureTapAction } from "./pointer-gesture.js";
import { assignRole } from "./pointer-route.js";
import { inputSmooth } from "./stroke-input-smooth.js";
import { compressPixelSnap, applyPixelSnap } from "./pixel-edit.js";
import { SMOOTH } from "./smooth-config.js";

const ERASER_RADIUS_SCREEN = 0;   // 用 BrushEngine 自己的 size，不再独立
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
// 详见 docs/undo-architecture.md。

// 多指 tap = undo/redo（Procreate 方言）
const GESTURE_TAP_MAX_MS = 250;
const GESTURE_TAP_MAX_MOVE_SQ = 256;     // 16 px²

// 单指长按 → 临时切到 picker；user 设置可开关。延迟阈值参考 iOS 系统 longpress。
const LONG_PRESS_MS = 450;
const LONG_PRESS_CANCEL_SQ = 64;          // 8 px²；超出就放弃当 draw 处理

// v249: 两参 → 引擎平滑参数（时间常数指数追踪 + 死区，详 docs/brush-procreate-smoothing.md）。
//   tau = streamline × tauMaxMs（时间，scale 无关）；deadzone = stabilization × stabMaxPx ÷scale（doc px）。
function _resolveSmooth(settings, scale) {
  const sc = scale || 1;
  const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
  return {
    tau:      clamp01(settings.streamline) * SMOOTH.tauMaxMs,
    deadzone: clamp01(settings.stabilization) * SMOOTH.stabMaxPx / sc,
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
function _editMode(i) {
  // gallery 全屏时不响应工具切换 / 选区类快捷键
  if (document.body.dataset.mode === "gallery") return false;
  return true;
}
function _floating(i) { return i.lasso?.state() === "floating"; }
function _hasSelectionIdle(i) {
  return i.lasso?.hasSelection() && i.lasso?.state() === "idle";
}

export const KEYBOARD_SHORTCUTS = [
  // 编辑（任何时候都该 work，除了 gallery 单 modal）
  { combo: "Ctrl+Z",           desc: "撤销",     category: "编辑",
    when: _editMode, run: (i) => i.ctrlZ() },
  { combo: "Ctrl+Shift+Z",     desc: "重做",     category: "编辑",
    when: _editMode, run: (i) => i.redo() },
  { combo: "Ctrl+Y",           desc: "重做",     category: "编辑",
    when: _editMode, run: (i) => i.redo() },
  // v156 剪贴板：逻辑在 app.js（doc/import/clipboard）→ run 派发 window 事件。
  //   when=_editMode（不查选区）→ 始终匹配以 preventDefault，挡掉浏览器原生 copy/paste；run 内部再决定。
  { combo: "Ctrl+C",           desc: "复制到剪贴板", category: "编辑",
    when: _editMode, run: () => window.dispatchEvent(new CustomEvent("wp:copy")) },
  { combo: "Ctrl+V",           desc: "粘贴为新层",   category: "编辑",
    when: _editMode, run: () => window.dispatchEvent(new CustomEvent("wp:paste")) },

  // 套索 / 选区（在浮层时只 Enter/Esc，其它跳过）
  { combo: "Enter",            desc: "应用变换", category: "套索",
    when: _floating, run: (i) => i._commitLasso() },
  { combo: "Escape",           desc: "取消变换", category: "套索",
    when: _floating, run: (i) => i._abortLasso() },
  { combo: "Escape",           desc: "取消选区", category: "套索",
    when: _hasSelectionIdle,
    run: (i) => {
      const entry = i.lasso.setSelection(null);
      if (entry && i.history) i.history.push(entry);
      i.board.invalidateAll();
    },
  },
  { combo: "Ctrl+A",           desc: "全选",     category: "套索",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoSelectAllBtn")?.click() },
  { combo: "Ctrl+D",           desc: "取消选区", category: "套索",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoDeselectBtn")?.click() },
  { combo: "Ctrl+Shift+I",     desc: "反选",     category: "套索",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoInvertBtn")?.click() },
  // v156 变换 / 复制为浮层（都需选区 + 非浮层；run 内部再查选区）
  // 裸 T 任何环境可用；Ctrl+T 是浏览器保留键 → 仅装成 PWA(standalone) 时可用，标签页里被浏览器开新标签吞掉。
  { combo: "T",                desc: "变换选区",     category: "套索",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoTransformBtn")?.click() },
  { combo: "Ctrl+T",           desc: "变换选区（仅 PWA；浏览器标签页内 Ctrl+T 被占用）", category: "套索",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => document.getElementById("lassoTransformBtn")?.click() },
  { combo: "Ctrl+J",           desc: "复制选区为浮层", category: "套索",
    when: (i) => _editMode(i) && !_floating(i),
    run: () => window.dispatchEvent(new CustomEvent("wp:duplicateFloat")) },

  // 工具切换（gallery / floating 时跳过）
  { combo: "B",                desc: "笔刷",     category: "工具",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("brush") },
  { combo: "E",                desc: "橡皮",     category: "工具",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("eraser") },
  { combo: "I",                desc: "吸色",     category: "工具",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("picker") },
  { combo: "L",                desc: "套索",     category: "工具",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("lasso") },
  { combo: "H",                desc: "平移",     category: "工具",
    when: (i) => _editMode(i) && !_floating(i), run: (i) => i._emitTool("hand") },

  // 窗格（裸字母；逻辑在 app.js，run 派发 window 事件）。不用 F 键（笔记本要 Fn / iPad 没有）。
  { combo: "C",                desc: "颜色窗格", category: "窗格",
    when: (i) => _editMode(i) && !_floating(i), run: () => window.dispatchEvent(new CustomEvent("wp:toggleColor")) },
  { combo: "N",                desc: "图层窗格", category: "窗格",
    when: (i) => _editMode(i) && !_floating(i), run: () => window.dispatchEvent(new CustomEvent("wp:toggleLayers")) },
  { combo: "R",                desc: "参考小窗", category: "窗格",
    when: (i) => _editMode(i) && !_floating(i), run: () => window.dispatchEvent(new CustomEvent("wp:toggleReference")) },

  // 视图
  { combo: "0",                desc: "画布居中", category: "视图",
    when: _editMode, run: (i) => i.board.fitToScreen() },
  { combo: "+",                desc: "放大",     category: "视图",
    when: _editMode, run: (i) => i.board.zoomAt(innerWidth/2, innerHeight/2, 1.2) },
  { combo: "-",                desc: "缩小",     category: "视图",
    when: _editMode, run: (i) => i.board.zoomAt(innerWidth/2, innerHeight/2, 1/1.2) },

  // 笔粗
  { combo: "[",                desc: "笔粗 -",   category: "笔粗",
    when: _editMode, run: (i) => i._adjustSize(-2) },
  { combo: "]",                desc: "笔粗 +",   category: "笔粗",
    when: _editMode, run: (i) => i._adjustSize(+2) },

  // **特殊**：Space hold = 临时 pan，需要 keyup 解除（_keydown 顶部硬编码，不走 registry）
  // **特殊**：Ctrl+S = 保存（绑在 app.js 拦截，不走 registry）
];

function _matchCombo(e, combo) {
  const parts = combo.split("+").map(s => s.trim());
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
  constructor(board, doc, opts = {}) {
    this.board = board;
    this.doc = doc;
    this.canvas = board.canvas;
    this.brush = new BrushEngine();
    this.shapes = new ShapesEngine();
    this.liquify = new LiquifyEngine();
    this.lasso = new LassoEngine();
    // v132 filter brush（user：「blur/sharpen/液化 走 filter brush engine」）
    //   引擎本身是薄 delegate；filter 自己提供 begin/extend/end brush 方法
    this.filterBrush = new FilterBrushEngine();
    this.lasso.onChange = () => {
      this.board.requestRender();
      window.dispatchEvent(new CustomEvent("wp:lassochange"));
    };
    this.getTool = opts.getTool || (() => "brush");
    this.editMode = opts.editMode || null;   // EditMode 独占状态机（路由/gate/ctrl-z 用，见 edit-mode.js）
    this.getBrushSettings = opts.getBrushSettings || (() => null);   // 必须传
    this.getLiquifySettings = opts.getLiquifySettings || (() => ({ mode: "push", size: 50, strength: 0.5 }));
    // v132 filter brush 当前激活的 { Filter, params } 或 null
    this.getFilterBrushState = opts.getFilterBrushState || (() => null);
    this.getLongPressPickEnabled = opts.getLongPressPickEnabled || (() => false);
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
    // history: 共享 UndoStack 实例（由 app.js 创建并注入）。
    this.history = opts.history || null;
    // pixelHistory: PixelEdit 实例（app.js 注入）。纯像素三件套的事务 + "stroke"/"liquify"
    // handler 由它注册（见 pixel-edit.js）。input 这里只留 lasso / selectionChange。
    this.pixelHistory = opts.pixelHistory || null;
    if (this.history) {
      // 套索 transform commit 是 raster snap：lift + transform + commit 整体作为单步 undo
      // v119: commit 时清了 selection，undo 时把它恢复回来
      this.history.registerHandler("lasso", {
        undo: (e) => {
          applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board);
          if (e.prevSelection !== undefined) {
            this.doc.selection = e.prevSelection;
            this.board.invalidateAll();
          }
        },
        redo: (e) => {
          applyPixelSnap(this.doc, e.layerId, e.after, e.afterBlob, this.board);
          if (e.prevSelection !== undefined) {
            this.doc.selection = null;       // redo 后再清
            this.board.invalidateAll();
          }
        },
        refsLayer: (e, id) => e.layerId === id,
      });
      // 选区变化（lasso 圈 / 取消选区 / 反选 等）也进 undo，但不动像素
      this.history.registerHandler("selectionChange", {
        undo: (e) => { this.doc.selection = e.before; this.board.invalidateAll(); },
        redo: (e) => { this.doc.selection = e.after;  this.board.invalidateAll(); },
        // 选区不属于某一 layer；refsLayer 永远 false（删图层不影响选区 entry）
        refsLayer: () => false,
      });
    }
    // 把 doc 引用给 lasso，便于直接操作 doc.selection
    this.lasso.setDoc(this.doc);
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e, true));
    c.addEventListener("pointerleave", (e) => this._up(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this._keydown(e));
    window.addEventListener("keyup", (e) => this._keyup(e));
  }

  // -- pen tip hover preview（iPad Pro M2+ 有 pen hover；mouse 模式也利用）
  _updateCursorPreview(e) {
    // #6 stage 4b：圆的显隐从 EditMode.cursor() 派生（取代硬编码 tool 列表）。
    //   "none"/"grab"（picker/lasso/hand + transform/crop/adjust）→ 不显（修"transient 时圆没隐藏"）
    //   "ring"（liquify）→ 显，用液化笔大小；"brush"（笔/橡皮/filterBrush）→ 显，用画笔大小
    const cur = this.editMode ? this.editMode.cursor() : "brush";
    if (cur === "none" || cur === "grab") {
      this.board.setCursor(null);
      return;
    }
    let size, square = false;
    if (cur === "ring") {
      const q = this.getLiquifySettings();
      size = (q && q.size) ? q.size * 2 : 100;     // size 是半径 → 直径 = ×2
    } else {
      const settings = this.getBrushSettings();
      size = settings ? settings.size : 12;
      // v232：像素笔 stamp 是方的（fillRect），preview 跟着方，别用圆误导
      square = !!(settings && settings.pixelMode);
    }
    this.board.setCursor({ x: e.clientX, y: e.clientY, size, square });
  }

  _down(e) {
    // ① 清掉 stale ghost pointers（iOS 偶尔丢 pointerup → ghost 卡在 map 里
    // 让单指手势误判成双指、画布失控旋转。user 2026-05-28）
    this._purgeStalePointers();
    // ② 笔尖落下 = 权威信号。之前所有触摸都视作掌触提前结束（即使没收到 up）。
    // 这条比 stale purge 更激进：不管时间多久，pen down 就清。
    if (e.pointerType === "pen") {
      this._purgeAllTouches();
      this.penEverSeen = true;
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
      for (const [pid, p] of this.pointers) {
        if (isPixelStroke(p.role)) {
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
    });

    const now = performance.now();
    const rec = {
      pointerType: e.pointerType, role,
      x, y, startX: x, startY: y,
      smX: x, smY: y,
      downTime: now,
      lastUpdateTs: now,
    };
    this.pointers.set(e.pointerId, rec);

    // #6 EditMode gate（fail-safe）：transient/非绘画 mode 下，draw 类 role 一律拒绝。
    // 防 role 决策对未知 mode（crop/adjust）fall-through 到 "draw" 而误触 stroke 污染 undo。
    const _isDrawRole = isDrawGated(role);
    if (_isDrawRole && this.editMode && !this.editMode.canDraw()) {
      rec.role = null;
      this.pointers.delete(e.pointerId);
      return;
    }

    // v125 (user：「在隐藏图层上动笔会 reject 并警告」)
    // 画 / 擦 / 液化 / 形状 都改 activeLayer 像素；hidden 时一律拒绝
    if (_isDrawRole
        && this.doc.activeLayer && !this.doc.activeLayer.visible) {
      this.status("当前图层已隐藏，无法绘制");
      rec.role = null;
      this.pointers.delete(e.pointerId);
      return;
    }

    if (isPixelStroke(role)) {
      // 画 / 液化 / filter brush 的时候不画 cursor（板子 dirty-rect 用，避免 cursor 撑全屏 dirty）
      this.board.setCursor(null);
      // 锚 smoothing / raw / 压感 状态到 down 点。
      // 防 dx 坑（timeStamp 单调），见 docs/ipad-coalesced-events.md
      rec.lastRawX = x;
      rec.lastRawY = y;
      rec.lastP = null;
      rec.smP = -1;
      rec.lastEventTs = -Infinity;
      // 即时笔（smudge/pixel）二参平滑状态：累积 raw / 死区锚 / EMA 输出(smX/Y 已在 rec 字面量锚为起点)
      rec.rawSX = x; rec.rawSY = y;
      rec.stabX = x; rec.stabY = y;
      if (role === "liquify") this._beginLiquify(rec);
      else if (role === "filterBrush") this._beginFilterBrush(rec);
      else {
        // mode 推断：tool=smudge → "smudge"；其他按 erase/brush 走
        const tool = this.getTool();
        const mode = role === "erase" ? "erase"
          : tool === "smudge" ? "smudge"
          : "brush";
        this._beginStroke(e, rec, mode);
      }
    } else if (role === "lasso") {
      this.board.setCursor(null);
      this._beginLasso(rec);
    } else if (role === "shapes") {
      this.board.setCursor(null);
      this._beginShapes(rec);
    } else if (role === "pick") {
      this._doPick(x, y);
    } else if (role === "pan") {
      document.body.dataset.panning = "1";
    }

    // 单指长按 → picker（如开启）。pen 不参与；hand 工具下也不触发；
    // 第二根手指进来时 gesture 路径会清掉 timer
    const wantLongPress = e.pointerType === "touch" && tool !== "hand" &&
      (role === "draw" || role === "erase" || role === "pan") &&
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
        }
        rec.role = "pick";
        this._doPick(rec.x, rec.y);
        this.status("吸色（长按）");
      }, LONG_PRESS_MS);
    }

    e.preventDefault();
  }

  _move(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) {
      // 没按下时也更新 cursor preview（pen hover / mouse hover）
      if (e.pointerType !== "touch") this._updateCursorPreview(e);
      return;
    }
    rec.x = e.clientX;
    rec.y = e.clientY;
    rec.lastUpdateTs = performance.now();

    // 单指长按 timer 还在 → 检查是否移动超阈值，超了就取消（当 draw 处理）
    if (rec.longPressTimer) {
      const dx = e.clientX - rec.startX;
      const dy = e.clientY - rec.startY;
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

    if (isPixelStroke(rec.role)) {
      const spec = pixelStrokeSpec(rec.role);
      // 画 / 液化 / filter brush 的时候不刷 cursor preview，省一次全屏 dirty
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      let list = (events && events.length) ? events : [e];
      // **液化 / filter brush 丢帧**（spec.coalesceLatest）：每个 event 跑 ~31K typed-array ops，大笔
      // 半径下 coalesced 整批连续跑 → 帧延迟堆积 → 越拖越卡。只跑最新一个（保 timeStamp 滤后的）。
      // 画笔不能丢帧，会断笔/疏密；液化 / filter brush 每帧独立重采样，丢帧 = 跳过细分但形状仍连续。
      if (spec.coalesceLatest && list.length > 1) list = [list[list.length - 1]];
      const settings = spec.usesBrushSettings ? this.getBrushSettings() : null;
      for (const ev of list) {
        // **Safari iOS getCoalescedEvents() 边界回放过滤**：每次 pointermove
        // 的 coalesced 列表会把上一批的样本一起带回来 (eg 一批末尾 t=21，下
        // 一批开头又给 t=4..25)。这些"反向小段"被 brush 当真实位移累计进
        // path 长度 → 几十 doc-px 周期的疏密波（鼠标无此问题）。详见
        // docs/ipad-coalesced-events.md。只接受 timeStamp 严格递增的 event。
        if (ev.timeStamp <= rec.lastEventTs) continue;
        rec.lastEventTs = ev.timeStamp;
        // raw 几乎没动 → 跳整个 event
        const drx = ev.clientX - rec.lastRawX;
        const dry = ev.clientY - rec.lastRawY;
        rec.lastRawX = ev.clientX;
        rec.lastRawY = ev.clientY;
        if (drx * drx + dry * dry < SMOOTH.rawStaticSq) continue;
        // v148/v243: buffered 笔触（brush/erase 非 pixel）位置平滑由引擎做（EMA + 贴笔尖 catch-up）
        //   → input 直传 raw。smudge/pixel/liquify/filterBrush 走即时 inputSmooth（死区 + EMA）。
        let psx, psy;
        if (rec.rawToEngine) {
          psx = ev.clientX; psy = ev.clientY;
        } else {
          const sp = inputSmooth(rec, settings, drx, dry);
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
        // magic 子工具是 tap-only：不升级到 drawing；_endLasso 在 pointerup 时触发
        if (this.lasso.getSubTool() === "magic") return;
        // v134 (user：「用 screen px，不然像素画时 lasso 用不了」)
        //   tap vs drag 阈值 = 8 screen-px 距离（防 pen jitter / mouse 抖）
        //   原本 4 doc-px² 在 32×32 pixel art zoom in 时巨大，永远不升级
        const sdx = e.clientX - rec.startX;
        const sdy = e.clientY - rec.startY;
        if (sdx * sdx + sdy * sdy > 64) {
          rec._lassoMode = "drawing";
          this.lasso.beginPath(rec._lassoStartDocX, rec._lassoStartDocY);
          this.lasso.extendPath(dx, dy);
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
    }
    e.preventDefault();
  }

  _up(e, cancelled = false) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    rec.x = e.clientX;
    rec.y = e.clientY;
    if (rec.longPressTimer) { clearTimeout(rec.longPressTimer); rec.longPressTimer = null; }

    if (rec.role === "gesture") {
      const remaining = this._gestureTouches().length;
      if (remaining < 2) {
        this._endGesture();
        // 所有 gesture touch 都松手了 → 判定双指 / 三指 tap
        if (remaining === 0 && this._gestureTap) {
          const tap = this._gestureTap;
          this._gestureTap = null;
          const elapsed = performance.now() - tap.startTime;
          if (tap.isTap && elapsed < GESTURE_TAP_MAX_MS) {
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
      const dur = now - rec.downTime;
      const dist = Math.hypot(rec.x - rec.startX, rec.y - rec.startY);
      if (isTap(dur, dist, TAP_MAX_DURATION, TAP_MAX_MOVE)) {
        if (isDoubleTap(now, this._lastTap, rec.startX, rec.startY, DOUBLETAP_WINDOW, DOUBLETAP_MAX_GAP)) {
          this._lastTap = null;
          window.dispatchEvent(new CustomEvent("wp:doubletap"));
          return;
        }
        this._lastTap = { time: now, x: rec.startX, y: rec.startY };
      } else {
        this._lastTap = null;
      }
    }

    if (isPixelStroke(rec.role)) {
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
    // role === "pick"（包括长按转过来的）不需要额外动作
  }

  // ---- 笔画 ----
  // 笔触 = 一个 "stroke" type 的 history entry。endStroke 时 push。
  // entry shape：{ type: "stroke", layerId, before, after, beforeBlob, afterBlob }
  // - before/after = Layer.snapshot()（bboxX/Y/W/H + imageData）
  // - blob 字段 push 后异步 toBlob 填，填好后释放 imageData
  // 详见 docs/undo-architecture.md。
  // 即时笔位置平滑在 stroke-input-smooth.js（inputSmooth，死区+EMA，pure·可测）；主笔刷走引擎 stroke-smoother.js。

  _beginStroke(e, rec, mode) {
    const settings = this.getBrushSettings();
    if (!settings || !this.doc.activeLayer) return;
    const layer = this.doc.activeLayer;
    const spec = pixelStrokeSpec(rec.role);   // draw / erase → 同 stroke 事务 + finalize
    const tx = this.pixelHistory.begin(layer, spec.historyType);
    this._activeStroke = { engine: this.brush, tx, finalize: spec.finalize };

    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    const pressure = effectivePressureFor(rec, e);
    // v148: buffered（brush/erase 非 pixel）位置平滑由引擎做（lookahead/frozen/tail），
    //   input 直传 raw（见 pointermove 的 rec.rawToEngine 分支）。smudge/pixel 仍走四件套。
    const buffered = mode !== "smudge" && !settings.pixelMode;
    rec.rawToEngine = buffered;
    const scale = this.board.viewport.scale || 1;
    // v249：时间常数指数追踪 + 死区。{tau, deadzone}。
    const smooth = buffered ? _resolveSmooth(settings, scale) : {};
    this.brush.beginStroke(layer, settings, dx, dy, pressure, mode, smooth, e.timeStamp);
    const bbox = this.brush.flushDirty();
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
    as.engine.endStroke();
    const sel = as.finalize ? this.doc.selection : null;
    as.tx.commit(sel ? (layer, pre) => sel.applyMaskPostStroke(layer, pre) : null);
    // 抬笔 commit 帧**强制全屏**：endStroke() 已把 buffer 烤进 layer 并清掉 live overlay（_stroke=null），
    // 这一帧再走 partial 会撞 Windows clip-sliver 灰框——_renderPartial 的 overlay 守卫此刻拦不住（overlay 已 null）。
    // 见 docs/lessons-canvas-edge-bugs.md 坑2：buffered（double-buffer）stroke commit 是守卫的盲区，full 兜底。
    this.board.invalidateAll();
  }
  _abortStroke() {
    const as = this._activeStroke;
    if (!as) return;
    this._activeStroke = null;
    as.engine.cancelStroke();
    as.tx.abort();
  }
  // 任一像素笔画进行中（brush / 像素笔 / smudge / liquify / filterBrush 都设 _activeStroke）。
  // board partial-render 守卫用它强走全屏 → 避开 Windows clip-sliver 黑框（docs/lessons-canvas-edge-bugs.md 坑2）。
  // 原来 strokeActiveHint 只兜 filterBrush，**像素笔直接写 layer、无 buffered overlay、又非 filterBrush → 漏出黑框**。
  isStrokeActive() { return !!this._activeStroke; }

  // ---- 液化 ----
  // 一次"按-拖-抬"= 一个 "liquify" history entry。schema 同 stroke。
  _beginLiquify(rec) {
    const settings = this.getLiquifySettings();
    if (!settings || !this.doc.activeLayer) { rec.role = null; return; }
    const layer = this.doc.activeLayer;
    const spec = pixelStrokeSpec(rec.role);   // liquify → 独立 "liquify" 事务 + finalize
    const tx = this.pixelHistory.begin(layer, spec.historyType);
    this._activeStroke = { engine: this.liquify, tx, finalize: spec.finalize };
    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    // v124 (user：「preview 没 apply 选区」) 把 selection 传给 liquify，stamp 内 mask 外保留 startSnap
    this.liquify.beginStroke(layer, settings, dx, dy, this.doc.selection);
    this.board.requestRender();
  }

  // ---- Filter brush (v132) ----
  // 一笔 = 1 个 "stroke" history entry（schema 同笔触）
  // brushSettings 从 getBrushSettings() 拿（沿用当前画笔 size / hardness / spacing / opacity）
  // filter + params 从 getFilterBrushState() 拿（app.js 在进入 filter brush 模式时 set）
  _beginFilterBrush(rec) {
    const fbState = this.getFilterBrushState();
    const brushSettings = this.getBrushSettings();
    if (!fbState || !fbState.Filter || !brushSettings || !this.doc.activeLayer) {
      rec.role = null; return;
    }
    const layer = this.doc.activeLayer;
    const spec = pixelStrokeSpec(rec.role);   // filterBrush → "stroke" 事务，finalize:false
    const tx = this.pixelHistory.begin(layer, spec.historyType);
    // filterBrush 在 beginStroke 时已吃了 selection，stamp 内 mask 外保留 pre → 无需 post-stroke finalize（spec.finalize=false）
    this._activeStroke = { engine: this.filterBrush, tx, finalize: spec.finalize };
    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    const pressure = effectivePressureFor(rec, { pressure: rec.lastP ?? 1 });
    try {
      this.filterBrush.beginStroke(layer, fbState.Filter, fbState.params, brushSettings, this.doc.selection, dx, dy, pressure);
    } catch (e) {
      console.warn("[filter brush] begin failed:", e);
      this._activeStroke = null;
      rec.role = null;
      this.status?.(`filter brush 出错：${e.message || e}`);
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
  // ---- shapes ----
  _beginShapes(rec) {
    if (!this.doc.activeLayer) { rec.role = null; return; }
    const { x, y } = this.board.screenToDoc(rec.x, rec.y);
    this.shapes.begin(this.doc.activeLayer, x, y);
  }
  _endShapes() {
    const layer = this.doc.activeLayer;
    if (!layer) return;
    const settings = this.getBrushSettings();
    const tx = this.pixelHistory.begin(layer, "stroke");
    try {
      const subtool = this.shapes.getSubtool();
      // line：复用 BrushEngine 沿线 stamp，吃 hardness / shape / spacing / 未来纹理
      // （user：「线条预设应该也有硬度...直接走复用笔刷库里面的绘制笔刷」）
      // rect / ellipse：仍走 fill（实心形状），不用 stamp
      if (subtool === "line" && this.shapes.getState()) {
        const st = this.shapes.getState();
        // Pressure = 1.0（直线没压感），taperIn 跟 preset 走；想纯硬线就把 preset taperIn=0
        this.brush.beginStroke(layer, settings, st.x0, st.y0, 1.0, "brush");
        this.brush.extendStroke(st.x1, st.y1, 1.0);
        this.brush.endStroke();
        this.shapes.resetState();
      } else {
        const bbox = this.shapes.end({
          color: (settings && settings.color) || "#000",
          size: (settings && settings.size) || 4,
          selection: this.doc.selection,
        });
        if (!bbox) return;
      }
      tx.commit();
      this.board.invalidateAll();
    } catch (e) {
      console.error("[shapes]", e);
      this.status("形状出错：" + (e.message || e));
    }
  }

  _beginLasso(rec) {
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
    rec._lassoMode = "tentative";
    rec._lassoStartDocX = dx;
    rec._lassoStartDocY = dy;
  }
  _endLasso(rec) {
    if (rec._lassoMode === "drawing") {
      try {
        const entry = this.lasso.endPath(this.doc.getFloodSourceLayer());
        if (entry) {
          if (this.history) this.history.push(entry);
          this.board.invalidateAll();
        } else {
          // v125: rasterize 后全在 doc 外 → status 提示，不静默
          this.lasso.cancelDrawing();
          this.status("选区全在画布外，已取消");
        }
      } catch (e) {
        console.error("[lasso end]", e);
        this.status("选区操作出错：" + (e.message || e));
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
            if (this.history) this.history.push(entry);
            this.board.invalidateAll();
          } else {
            this.status("魔术棒：tap 在线 / 边界上，没选到");
          }
        } catch (e) {
          console.error("[magic-wand]", e);
          this.status("魔术棒出错：" + (e.message || e));
        }
      } else {
        // v134 (user：「自由/矩形/圆 单击在新建选区模式下 = 取消当前选区」)
        //   add / subtract / intersect 模式 = 防误触静默（user 还想加，但 tap 不应改）
        if (this.lasso.getSetOpMode() === "new" && this.lasso.hasSelection()) {
          const entry = this.lasso.setSelection(null);
          if (entry && this.history) this.history.push(entry);
          this.board.invalidateAll();
          this.status("已取消选区");
        }
      }
    }
  }
  _commitLasso() {
    const entry = this.lasso.commit();
    if (!entry) return;
    if (this.history) this.history.push(entry);
    this.board.invalidateAll();
    compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  }
  _abortLasso() {
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
  _doPick(sx, sy) {
    const { x: dx, y: dy } = this.board.screenToDoc(sx, sy);
    const ix = Math.floor(dx), iy = Math.floor(dy);
    if (!this.doc.activeLayer) return;
    if (ix < 0 || iy < 0 || ix >= this.doc.width || iy >= this.doc.height) {
      window.dispatchEvent(new CustomEvent("wp:pickerHide"));
      return;
    }
    // 吸的是"合成后的可见颜色"。从所有可见图层底向上 alpha-blend。
    let r = 0, g = 0, b = 0, a = 0;
    // doc 背景作为底
    const bg = parseHex(this.doc.backgroundColor || "#ffffff");
    r = bg.r; g = bg.g; b = bg.b; a = 1;
    for (const layer of this.doc.layers) {
      if (!layer.visible) continue;
      const px = layer.sampleAt(ix, iy);
      const la = (px[3] / 255) * layer.opacity;
      if (la <= 0) continue;
      // source-over 合成（其他 mode 简化处理，吸色按 over 也是惯例）
      const inv = 1 - la;
      r = px[0] * la + r * inv;
      g = px[1] * la + g * inv;
      b = px[2] * la + b * inv;
      a = la + a * inv;
    }
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
        isTap: true,
        maxCount: 0,
        startPositions: {},
      };
    }
    for (const [pid, p] of this.pointers) {
      if (p.role === "gesture" && !(pid in this._gestureTap.startPositions)) {
        this._gestureTap.startPositions[pid] = { x: p.x, y: p.y };
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
    this.gestureStart = {
      dist: Math.hypot(dx, dy) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      angle: Math.atan2(dy, dx),          // 起手两指连线角度
      vp: { ...this.board.viewport },
    };
    document.body.dataset.panning = "1";
  }
  _updateGesture() {
    const t = this._gestureTouches();
    if (t.length < 2 || !this.gestureStart) return;
    const [a, b] = t;
    // anchor-preserving 双指变换数学已抽到 pointer-gesture.js（纯函数·可单测）。
    // 旋转**不**在此 snap（进行中吸附粘手）；松手由 _endGesture/snapRotation 吸。
    const vp = computePinchViewport(this.gestureStart, a, b, {
      minScale: this.board.minScale, maxScale: this.board.maxScale,
      docW: this.board.doc.width, docH: this.board.doc.height,
    });
    this.board.setViewport(vp.tx, vp.ty, vp.scale, vp.rot);
  }
  _endGesture() {
    this.gestureStart = null;
    delete document.body.dataset.panning;
    // 松手时旋转吸附（±5° 内吸到 0/90/180/270°；进行中不吸=不粘手）。判定见 pointer-gesture.js。
    const snapped = snapRotation(this.board.viewport.rot, 5);
    if (snapped !== null) {
      // 以画布中心为锚，保持画面中心稳定地吸到正角度
      const W = this.board.doc.width, H = this.board.doc.height;
      const vp = this.board.viewport;
      const cxScreen = vp.tx + W * vp.scale / 2;
      const cyScreen = vp.ty + H * vp.scale / 2;
      this.board.setViewport(
        cxScreen - W * vp.scale / 2,
        cyScreen - H * vp.scale / 2,
        vp.scale,
        snapped,
      );
    }
  }

  // ---- wheel ----
  _wheel(e) {
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
  _keydown(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
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
    for (const sc of KEYBOARD_SHORTCUTS) {
      if (sc.when && !sc.when(this)) continue;
      if (!_matchCombo(e, sc.combo)) continue;
      try { sc.run(this); } catch (err) { console.warn("[shortcut]", sc.combo, err); }
      e.preventDefault();
      return;
    }
  }
  _keyup(e) {
    if (e.code === "Space") {
      this.spaceDown = false;
      delete document.body.dataset.spacePan;
    }
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      this.altDown = false;
    }
  }
  _emitTool(tool) { window.dispatchEvent(new CustomEvent("wp:settool", { detail: tool })); }
  _adjustSize(delta) { window.dispatchEvent(new CustomEvent("wp:adjsize", { detail: delta })); }

  // undo / redo / canUndo / canRedo 现在都走共享 history（v44 起）。
  // 留这几个 wrapper 给绑了快捷键 / 老 listener 用，**不**自己保存状态。
  canUndo() {
    if (this.editMode && this.editMode.isTransient()) return true;   // transient：ctrl-z = 取消
    return !!this.history && this.history.canUndo();
  }
  canRedo() {
    if (this.editMode && this.editMode.isTransient()) return false;  // transient 期间无 redo 语义
    return !!this.history && this.history.canRedo();
  }
  // #6 ctrl-z 路由（所有 undo 入口走这：键盘 Ctrl+Z / 双指 tap / undo 按钮）。
  // 语义由 EditMode 决定：transient(abort-transient) = 取消当前 transient（transform/crop/adjust 统一）；
  // 否则 = 正常 history undo。取代旧的"只在 lasso.hasFloating 时 cancel"的 ad-hoc。
  ctrlZ() {
    if (this.editMode && this.editMode.ctrlZMeans() === "abort-transient") {
      this.editMode.abortTransient();
      return;
    }
    this.undo();
  }
  undo() {   // 纯 history undo（transient 取消走 ctrlZ → editMode.abortTransient）
    if (this.history) this.history.undo();
  }
  redo() {
    if (this.editMode && this.editMode.isTransient()) return;        // transient 期间禁 redo
    if (this.history) this.history.redo();
  }
  clearHistory() { if (this.history) this.history.clear(); }

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
  _discardPointer(pid) {
    const p = this.pointers.get(pid);
    if (!p) return;
    if (p.longPressTimer) { clearTimeout(p.longPressTimer); p.longPressTimer = null; }
    // 如果它正在执笔，把笔触状态也收尾掉（保留 history entry）
    if (isPixelStroke(p.role)) this._abortStroke();
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

// compressPixelSnap / applyPixelSnap 已搬到 pixel-edit.js（顶部 import 复用，lasso 复合 entry 也用）。

// 抬笔瞬间 e.pressure === 0 → 沿用 rec.lastP，不退回 0.5（v4）。
// 起手 warmup 也 0 但 lastP 还没 → 退到 **0.2**（v6，原本 0.5 → 起手鼓 bulb）。
// 算完 raw 后过一道 LPF（rec.smP，α=PRESSURE_SMOOTH_ALPHA）做 stabilizer，
// damp 10Hz 抖动 + 削传感器尖刺。sentinel rec.smP < 0 → 首颗用 raw（tap 满压）。
// 注：是否真的把 pressure 用进 size / opacity 由 BrushSettings.pressureToSize /
// pressureToOpacity 决定（v30 起，分别 toggle）。这里永远 return 真值。
function effectivePressureFor(rec, ev) {
  let raw;
  if (ev.pointerType === "mouse") {
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
  if (rec.smP < 0) rec.smP = raw;
  else rec.smP += SMOOTH.pressureAlpha * (raw - rec.smP);
  return rec.smP;
}

function parseHex(hex) {
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
