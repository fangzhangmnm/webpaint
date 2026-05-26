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
// 笔停手时 IIR catch-up 会塞一串小 delta → 局部 stamp pile-up（"细笔的结"）。
// 改成按 raw 输入是否真在动来过滤：raw 静止 → 跳整个 event（不更 smX，不发 stamp）。
// 之前的 smX-delta 过滤会把 N 个 sub-threshold 事件批成一次 extendStroke，
// 沿走线就出现"密一段 + 空一段"的 group/skip 周期，被肉眼当 knot。
const RAW_STATIC_SCREEN_SQ = 0.005;     // 0.07 px²；Pencil 噪声 < 0.05 px，正常画 > 0.2 px
// 压感 LPF（stabilizer）：Pencil 自带 ~10Hz 握笔抖动 → 灌进 size = base × p^0.6
// 会让 step 每秒 10 次缩胀 → segPos 偶尔被 clamp 到段首 → 小堆积 → 视觉上速度
// 相关的 alpha 结节。LPF 把 10Hz 抖动压平，结节就没了。同步削尖刺，缓解 mid bulb。
// init = -1 当 sentinel：第一颗 stamp 直接用 raw（保持 tap 满压），之后 LPF。
const PRESSURE_SMOOTH_ALPHA = 0.4;
const MAX_UNDO_ENTRIES = 20;       // 2048² × RGBA = 16 MB × 20 = 320 MB；后期换 PNG / tile-diff 再降

// 多指 tap = undo/redo（Procreate 方言）
const GESTURE_TAP_MAX_MS = 250;
const GESTURE_TAP_MAX_MOVE_SQ = 256;     // 16 px²

// 单指长按 → 临时切到 picker；user 设置可开关。延迟阈值参考 iOS 系统 longpress。
const LONG_PRESS_MS = 450;
const LONG_PRESS_CANCEL_SQ = 64;          // 8 px²；超出就放弃当 draw 处理

export class InputController {
  constructor(board, doc, opts = {}) {
    this.board = board;
    this.doc = doc;
    this.canvas = board.canvas;
    this.brush = new BrushEngine();
    this.getTool = opts.getTool || (() => "brush");
    this.getBrushSettings = opts.getBrushSettings || (() => null);   // 必须传
    this.getPressureEnabled = opts.getPressureEnabled || (() => true);
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
    // 内存：20 entries × 16 MB = 320 MB（去掉了原本 before+after 的双份）
    this.undoChain = [];
    this.undoIndex = -1;

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
      // 清掉所有挂在 touch 上的 long-press timer（gesture 之后不再是单指长按）
      for (const [, p] of this.pointers) {
        if (p.longPressTimer) { clearTimeout(p.longPressTimer); p.longPressTimer = null; }
      }
      for (const [pid, p] of this.pointers) {
        if (p.role === "draw" || p.role === "erase") {
          this._abortStroke();
        }
        // 任何 active touch 都转 gesture，让 pinch/pan math 接管，不再跑 per-pointer 逻辑
        if (p.pointerType === "touch" && p.role !== "ignore") {
          p.role = "gesture";
        }
      }
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "gesture", x, y, startX: x, startY: y, downTime: performance.now() });
      this._beginGesture();
      this._updateGestureTapSnapshot();
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
      // 画的时候不画 cursor（板子 dirty-rect 用，避免 cursor 撑全屏 dirty）
      this.board.setCursor(null);
      // 锚 smoothing / raw / 压感 状态到 down 点
      rec.lastRawX = x;
      rec.lastRawY = y;
      rec.lastP = null;   // 本笔最近一次有效 pressure，给 sensor 0 fallback
      rec.smP = -1;       // stabilizer LPF 状态；-1 = 还没收到第一帧（首颗 = raw）
      this._beginStroke(e, rec, role === "erase" ? "erase" : "brush");
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

    if (rec.role === "draw" || rec.role === "erase") {
      // 画的时候不刷 cursor preview，省一次全屏 dirty
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      const list = (events && events.length) ? events : [e];
      const enabled = this.getPressureEnabled();
      for (const ev of list) {
        // raw 几乎没动 → 跳整个 event（不更 smX，不发 stamp）。
        // 之前用 smX-delta 阈值会批多个事件成一次 extend → group/skip 周期被当 knot。
        const drx = ev.clientX - rec.lastRawX;
        const dry = ev.clientY - rec.lastRawY;
        rec.lastRawX = ev.clientX;
        rec.lastRawY = ev.clientY;
        if (drx * drx + dry * dry < RAW_STATIC_SCREEN_SQ) continue;
        rec.smX += STROKE_SMOOTH_ALPHA * (ev.clientX - rec.smX);
        rec.smY += STROKE_SMOOTH_ALPHA * (ev.clientY - rec.smY);
        const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
        const pressure = effectivePressureFor(rec, ev, enabled);
        this.brush.extendStroke(dx, dy, pressure);
      }
      // 把 brush 累的 dirty bbox 送进 board，rAF render 时只 blit 这一片
      const bbox = this.brush.flushDirty();
      if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
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
            if (tap.maxCount === 2) {
              this.undo();
              this.status("双指 · 撤销");
            } else if (tap.maxCount >= 3) {
              this.redo();
              this.status("三指 · 重做");
            }
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
    // role === "pick"（包括长按转过来的）不需要额外动作
  }

  // ---- 笔画 ----
  _beginStroke(e, rec, mode) {
    const settings = this.getBrushSettings();
    if (!settings || !this.doc.activeLayer) return;
    const layer = this.doc.activeLayer;
    // 链空 → lazy 拍当前状态作为"起点"（撤销能回到的最远状态）
    if (this.undoChain.length === 0) {
      this.undoChain.push({
        layerId: layer.id,
        imageData: layer.ctx.getImageData(0, 0, layer.width, layer.height),
      });
      this.undoIndex = 0;
    }
    this._strokeLayerId = layer.id;

    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    const pressure = effectivePressureFor(rec, e, this.getPressureEnabled());
    this.brush.beginStroke(layer, settings, dx, dy, pressure, mode);
    // begin 已经落了第一颗 stamp → 也要把它的 dirty 报上去
    const bbox = this.brush.flushDirty();
    if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
    this.board.requestRender();
  }
  _endStroke() {
    this.brush.endStroke();
    if (this._strokeLayerId == null) return;
    const layer = this.doc.layers.find((l) => l.id === this._strokeLayerId);
    this._strokeLayerId = null;
    if (!layer) return;
    const after = layer.ctx.getImageData(0, 0, layer.width, layer.height);
    // 截掉 redo 段，把新状态 push 进去
    if (this.undoIndex < this.undoChain.length - 1) {
      this.undoChain.length = this.undoIndex + 1;
    }
    this.undoChain.push({ layerId: layer.id, imageData: after });
    this.undoIndex++;
    while (this.undoChain.length > MAX_UNDO_ENTRIES) {
      this.undoChain.shift();
      this.undoIndex--;
    }
    this._emitHistChange();
    this.board.requestRender();
  }
  _abortStroke() {
    this.brush.cancelStroke();
    // 退回当前 chain 状态（= 笔触开始前那张）
    if (this._strokeLayerId != null && this.undoIndex >= 0) {
      const entry = this.undoChain[this.undoIndex];
      const layer = this.doc.layers.find((l) => l.id === entry.layerId);
      if (layer) layer.ctx.putImageData(entry.imageData, 0, 0);
      this.board.invalidateAll();
    }
    this._strokeLayerId = null;
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

  // ---- undo / redo（snapshot 链 + pointer）----
  canUndo() { return this.undoIndex > 0; }
  canRedo() { return this.undoIndex >= 0 && this.undoIndex < this.undoChain.length - 1; }
  undo() {
    if (!this.canUndo()) return;
    this.undoIndex--;
    const entry = this.undoChain[this.undoIndex];
    const layer = this.doc.layers.find((l) => l.id === entry.layerId);
    if (layer) layer.ctx.putImageData(entry.imageData, 0, 0);
    this.board.invalidateAll();
    this._emitHistChange();
  }
  redo() {
    if (!this.canRedo()) return;
    this.undoIndex++;
    const entry = this.undoChain[this.undoIndex];
    const layer = this.doc.layers.find((l) => l.id === entry.layerId);
    if (layer) layer.ctx.putImageData(entry.imageData, 0, 0);
    this.board.invalidateAll();
    this._emitHistChange();
  }
  clearHistory() {
    this.undoChain.length = 0;
    this.undoIndex = -1;
    this._emitHistChange();
  }
  _emitHistChange() {
    window.dispatchEvent(new CustomEvent("wp:histchange", {
      detail: { canUndo: this.canUndo(), canRedo: this.canRedo() },
    }));
  }
}

// pressure 关时一律返 1（"满压感"），数据语义而非渲染开关。
//
// 抬笔瞬间 e.pressure === 0 → 沿用 rec.lastP，不退回 0.5（v4）。
// 起手 warmup 也 0 但 lastP 还没 → 退到 **0.2**（v6，原本 0.5 → 起手鼓 bulb）。
// 算完 raw 后过一道 LPF（rec.smP，α=PRESSURE_SMOOTH_ALPHA）做 stabilizer，
// damp 10Hz 抖动 + 削传感器尖刺。sentinel rec.smP < 0 → 首颗用 raw（tap 满压）。
function effectivePressureFor(rec, ev, enabled) {
  if (!enabled) return 1;
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
  else rec.smP += PRESSURE_SMOOTH_ALPHA * (raw - rec.smP);
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
