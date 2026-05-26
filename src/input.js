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

const ERASER_RADIUS_SCREEN = 0;   // 用 BrushEngine 自己的 size，不再独立
const TAP_MAX_DURATION = 220;
const TAP_MAX_MOVE = 16;
const DOUBLETAP_WINDOW = 500;
const DOUBLETAP_MAX_GAP = 80;
const STROKE_SMOOTH_ALPHA = 0.65;
const MAX_UNDO_ENTRIES = 20;       // 2048² × RGBA = 16 MB × 20 = 320 MB 上限；后期换 PNG 压缩

export class InputController {
  constructor(board, doc, opts = {}) {
    this.board = board;
    this.doc = doc;
    this.canvas = board.canvas;
    this.brush = new BrushEngine();
    this.getTool = opts.getTool || (() => "brush");
    this.getBrushSettings = opts.getBrushSettings || (() => null);   // 必须传
    this.getPressureEnabled = opts.getPressureEnabled || (() => true);
    this.onColorSampled = opts.onColorSampled || (() => {});
    this.status = opts.status || (() => {});

    this.pointers = new Map();
    this.penEverSeen = false;
    this.spaceDown = false;
    this.altDown = false;
    this.gestureStart = null;

    this.undoStack = [];      // [{ layerId, before, after }]
    this.redoStack = [];

    this._lastTap = null;
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
    const tool = this.getTool();
    if (tool === "hand") {
      this.board.setCursor(null);
      return;
    }
    const settings = this.getBrushSettings();
    const size = settings ? settings.size : 12;
    this.board.setCursor({ x: e.clientX, y: e.clientY, size });
  }

  _down(e) {
    if (e.pointerType === "pen") {
      this.penEverSeen = true;
      this._lastTap = null;
    }
    this.canvas.setPointerCapture?.(e.pointerId);

    const tool = this.getTool();
    const effectiveTool = this.altDown && tool === "brush" ? "picker" : tool;
    const x = e.clientX, y = e.clientY;

    // pen 正在画 → touch 当掌触
    const penDrawing = [...this.pointers.values()].some(
      (p) => p.pointerType === "pen" && (p.role === "draw" || p.role === "erase"),
    );
    if (e.pointerType === "touch" && penDrawing) {
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "ignore", x, y });
      e.preventDefault();
      return;
    }

    // 第二个 touch → gesture
    const activeTouches = [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
    if (e.pointerType === "touch" && activeTouches.length >= 1) {
      for (const [pid, p] of this.pointers) {
        if (p.role === "draw" || p.role === "erase") {
          this._abortStroke();
          p.role = "gesture";
        }
      }
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "gesture", x, y });
      this._beginGesture();
      e.preventDefault();
      return;
    }

    // 决定角色
    let role = null;
    if (tool === "hand" || this.spaceDown) {
      role = "pan";
    } else if (e.pointerType === "mouse") {
      if (e.button === 0) role = effectiveTool === "eraser" ? "erase" : (effectiveTool === "picker" ? "pick" : "draw");
      else role = "pan";
    } else if (e.pointerType === "pen") {
      // pen 副按钮 → 强制橡皮
      if (e.button === 2 || (e.buttons & 2)) role = "erase";
      else if (effectiveTool === "picker") role = "pick";
      else if (effectiveTool === "eraser") role = "erase";
      else role = "draw";
    } else if (e.pointerType === "touch") {
      if (this.penEverSeen) {
        role = "pan";
      } else {
        if (effectiveTool === "picker") role = "pick";
        else if (effectiveTool === "eraser") role = "erase";
        else role = "draw";
      }
    }

    const rec = {
      pointerType: e.pointerType, role,
      x, y, startX: x, startY: y,
      smX: x, smY: y,
      downTime: performance.now(),
    };
    this.pointers.set(e.pointerId, rec);

    if (role === "draw" || role === "erase") {
      this._beginStroke(e, rec, role === "erase" ? "erase" : "brush");
    } else if (role === "pick") {
      this._doPick(x, y);
    } else if (role === "pan") {
      document.body.dataset.panning = "1";
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

    if (this.gestureStart) {
      this._updateGesture();
      e.preventDefault();
      return;
    }

    if (rec.role === "draw" || rec.role === "erase") {
      this._updateCursorPreview(e);
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      const list = (events && events.length) ? events : [e];
      const enabled = this.getPressureEnabled();
      for (const ev of list) {
        rec.smX += STROKE_SMOOTH_ALPHA * (ev.clientX - rec.smX);
        rec.smY += STROKE_SMOOTH_ALPHA * (ev.clientY - rec.smY);
        const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
        const pressure = effectivePressure(ev, enabled);
        this.brush.extendStroke(dx, dy, pressure);
      }
      this.board.requestRender();
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

    if (rec.role === "gesture") {
      if (this.pointers.size < 2) this._endGesture();
      else this._beginGesture();
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
      const isTap = dur < TAP_MAX_DURATION && dist < TAP_MAX_MOVE;
      if (isTap) {
        const lt = this._lastTap;
        const isDouble = lt && (now - lt.time) < DOUBLETAP_WINDOW &&
          Math.hypot(rec.startX - lt.x, rec.startY - lt.y) < DOUBLETAP_MAX_GAP;
        if (isDouble) {
          this._lastTap = null;
          window.dispatchEvent(new CustomEvent("wp:doubletap"));
          return;
        }
        this._lastTap = { time: now, x: rec.startX, y: rec.startY };
      } else {
        this._lastTap = null;
      }
    }

    if (rec.role === "draw" || rec.role === "erase") {
      if (cancelled) this._abortStroke();
      else this._endStroke();
    } else if (rec.role === "pan") {
      if (![...this.pointers.values()].some((p) => p.role === "pan")) {
        delete document.body.dataset.panning;
      }
    }
  }

  // ---- 笔画 ----
  _beginStroke(e, rec, mode) {
    const settings = this.getBrushSettings();
    if (!settings || !this.doc.activeLayer) return;
    const layer = this.doc.activeLayer;
    // 快照（undo）
    const before = layer.ctx.getImageData(0, 0, layer.width, layer.height);
    this._strokeUndoInProgress = { layerId: layer.id, before };

    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    const pressure = effectivePressure(e, this.getPressureEnabled());
    this.brush.beginStroke(layer, settings, dx, dy, pressure, mode);
    this.board.requestRender();
  }
  _endStroke() {
    if (!this._strokeUndoInProgress) {
      this.brush.endStroke();
      return;
    }
    this.brush.endStroke();
    const layer = this.doc.layers.find((l) => l.id === this._strokeUndoInProgress.layerId);
    if (layer) {
      const after = layer.ctx.getImageData(0, 0, layer.width, layer.height);
      this._pushUndo({
        layerId: layer.id,
        before: this._strokeUndoInProgress.before,
        after,
      });
    }
    this._strokeUndoInProgress = null;
    this.board.requestRender();
  }
  _abortStroke() {
    this.brush.cancelStroke();
    if (this._strokeUndoInProgress) {
      // 把笔画"回退"到 before（取消这一笔的像素改动）
      const layer = this.doc.layers.find((l) => l.id === this._strokeUndoInProgress.layerId);
      if (layer) layer.ctx.putImageData(this._strokeUndoInProgress.before, 0, 0);
      this._strokeUndoInProgress = null;
      this.board.requestRender();
    }
  }

  // ---- 吸色 ----
  _doPick(sx, sy) {
    const { x: dx, y: dy } = this.board.screenToDoc(sx, sy);
    const ix = Math.floor(dx), iy = Math.floor(dy);
    if (!this.doc.activeLayer) return;
    if (ix < 0 || iy < 0 || ix >= this.doc.width || iy >= this.doc.height) return;
    // 吸的是"合成后的可见颜色"。从所有可见图层底向上 alpha-blend。
    let r = 0, g = 0, b = 0, a = 0;
    // doc 背景作为底
    const bg = parseHex(this.doc.backgroundColor || "#ffffff");
    r = bg.r; g = bg.g; b = bg.b; a = 1;
    for (const layer of this.doc.layers) {
      if (!layer.visible) continue;
      const px = layer.ctx.getImageData(ix, iy, 1, 1).data;
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
  }

  // ---- gesture ----
  _gestureTouches() {
    return [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
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
      vp: { ...this.board.viewport },
    };
    document.body.dataset.panning = "1";
  }
  _updateGesture() {
    const t = this._gestureTouches();
    if (t.length < 2 || !this.gestureStart) return;
    const [a, b] = t;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const g = this.gestureStart;
    const k = dist / g.dist;
    let newScale = g.vp.scale * k;
    newScale = Math.max(this.board.minScale, Math.min(this.board.maxScale, newScale));
    const actualK = newScale / g.vp.scale;
    const newTx = midX - (g.midX - g.vp.tx) * actualK;
    const newTy = midY - (g.midY - g.vp.ty) * actualK;
    this.board.setViewport(newTx, newTy, newScale);
  }
  _endGesture() {
    this.gestureStart = null;
    delete document.body.dataset.panning;
  }

  // ---- wheel ----
  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      this.board.zoomAt(e.clientX, e.clientY, factor);
    } else {
      let dx = -e.deltaX, dy = -e.deltaY;
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
      this.board.pan(dx, dy);
    }
  }

  // ---- 键盘 ----
  _keydown(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.code === "Space" && !this.spaceDown) {
      this.spaceDown = true;
      document.body.dataset.spacePan = "1";
      e.preventDefault();
      return;
    }
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      this.altDown = true;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ") {
      if (e.shiftKey) this.redo(); else this.undo();
      e.preventDefault();
      return;
    }
    if (ctrl && e.code === "KeyY") {
      this.redo();
      e.preventDefault();
      return;
    }
    if (e.key === "b" || e.key === "B") this._emitTool("brush");
    else if (e.key === "e" || e.key === "E") this._emitTool("eraser");
    else if (e.key === "i" || e.key === "I") this._emitTool("picker");
    else if (e.key === "h" || e.key === "H") this._emitTool("hand");
    else if (e.key === "0") this.board.fitToScreen();
    else if (e.key === "=" || e.key === "+") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2);
    else if (e.key === "-" || e.key === "_") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2);
    else if (e.key === "[") this._adjustSize(-2);
    else if (e.key === "]") this._adjustSize(+2);
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

  // ---- undo / redo ----
  _pushUndo(entry) {
    this.undoStack.push(entry);
    while (this.undoStack.length > MAX_UNDO_ENTRIES) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emitHistChange();
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    const layer = this.doc.layers.find((l) => l.id === e.layerId);
    if (layer) layer.ctx.putImageData(e.before, 0, 0);
    this.redoStack.push(e);
    this._emitHistChange();
    this.board.requestRender();
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    const layer = this.doc.layers.find((l) => l.id === e.layerId);
    if (layer) layer.ctx.putImageData(e.after, 0, 0);
    this.undoStack.push(e);
    this._emitHistChange();
    this.board.requestRender();
  }
  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._emitHistChange();
  }
  _emitHistChange() {
    window.dispatchEvent(new CustomEvent("wp:histchange", {
      detail: { canUndo: this.canUndo(), canRedo: this.canRedo() },
    }));
  }
}

// pressure 关时一律返 1（"满压感"），数据语义而非渲染开关
function effectivePressure(e, enabled) {
  if (!enabled) return 1;
  if (e.pointerType === "mouse") return 0.5;
  const p = typeof e.pressure === "number" ? e.pressure : 0.5;
  if (p === 0) return 0.5;
  return Math.max(0.05, Math.min(1, p));
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
