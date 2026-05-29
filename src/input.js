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
import { LassoEngine, applySelectionMaskPostStroke } from "./lasso.js";
import { ShapesEngine } from "./shapes.js";

const ERASER_RADIUS_SCREEN = 0;   // 用 BrushEngine 自己的 size，不再独立
const TAP_MAX_DURATION = 220;
const TAP_MAX_MOVE = 16;
const DOUBLETAP_WINDOW = 500;
const DOUBLETAP_MAX_GAP = 80;
// 位置不做 smoothing —— raw clientX/Y 直传给 brush。brush 端 accumDist 沿
// path arc-length 等距撒 stamp。input 端只过滤完全没动的 event。
const RAW_STATIC_SCREEN_SQ = 0.005;     // 0.07 px²；raw 没动就跳，避免触发 brush extendStroke
// 压感 LPF（stabilizer）：Pencil 自带 ~10Hz 握笔抖动 → 灌进 size = base × p^0.6
// 会让 step 每秒 10 次缩胀 → segPos 偶尔被 clamp 到段首 → 小堆积 → 视觉上速度
// 相关的 alpha 结节。LPF 把 10Hz 抖动压平。同步削尖刺，缓解 mid bulb。
// init = -1 当 sentinel：第一颗 stamp 直接用 raw（保持 tap 满压），之后 LPF。
const PRESSURE_SMOOTH_ALPHA = 0.4;
// Undo 通过 history.UndoStack（v44 起 command pattern + 注册 handler）。
// 这里只注册 "stroke" type 的 handler，layer 操作的 handler 在 app.js 注册。
// 详见 docs/undo-architecture.md。

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
    this.shapes = new ShapesEngine();
    this.liquify = new LiquifyEngine();
    this.lasso = new LassoEngine();
    this.lasso.onChange = () => {
      this.board.requestRender();
      window.dispatchEvent(new CustomEvent("wp:lassochange"));
    };
    this.getTool = opts.getTool || (() => "brush");
    this.getBrushSettings = opts.getBrushSettings || (() => null);   // 必须传
    this.getLiquifySettings = opts.getLiquifySettings || (() => ({ mode: "push", size: 50, strength: 0.5 }));
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
    // history: 共享 UndoStack 实例（由 app.js 创建并注入）。注册 "stroke" handler。
    this.history = opts.history || null;
    if (this.history) {
      this.history.registerHandler("stroke", {
        undo: (e) => applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board),
        redo: (e) => applyPixelSnap(this.doc, e.layerId, e.after, e.afterBlob, this.board),
        refsLayer: (e, id) => e.layerId === id,
      });
      // 液化和 stroke 同 schema（layerId + before/after pixel snap）。共用 handler 也行，
      // 但分开命名便于以后区分 history UI 标签。
      this.history.registerHandler("liquify", {
        undo: (e) => applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board),
        redo: (e) => applyPixelSnap(this.doc, e.layerId, e.after, e.afterBlob, this.board),
        refsLayer: (e, id) => e.layerId === id,
      });
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
    const tool = this.getTool();
    if (tool === "hand") {
      this.board.setCursor(null);
      return;
    }
    let size;
    if (tool === "liquify") {
      const q = this.getLiquifySettings();
      size = (q && q.size) ? q.size * 2 : 100;     // size 是半径 → 直径 = ×2
    } else {
      const settings = this.getBrushSettings();
      size = settings ? settings.size : 12;
    }
    this.board.setCursor({ x: e.clientX, y: e.clientY, size });
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

    const tool = this.getTool();
    const effectiveTool = this.altDown && tool === "brush" ? "picker" : tool;
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
        if (p.role === "draw" || p.role === "erase") {
          this._abortStroke();
        } else if (p.role === "liquify") {
          this._abortLiquify();
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

    // 决定角色
    let role = null;
    if (tool === "hand" || this.spaceDown) {
      role = "pan";
    } else if (e.pointerType === "mouse") {
      if (e.button === 0) role = effectiveTool === "eraser" ? "erase"
        : effectiveTool === "picker" ? "pick"
        : effectiveTool === "liquify" ? "liquify"
        : effectiveTool === "lasso" ? "lasso"
        : effectiveTool === "smudge" ? "draw"          // v85+ smudge engine 实装前先按 draw 走
        : effectiveTool === "shapes" ? "shapes"
        : "draw";
      else role = "pan";
    } else if (e.pointerType === "pen") {
      // pen 副按钮 → 强制橡皮
      if (e.button === 2 || (e.buttons & 2)) role = "erase";
      else if (effectiveTool === "picker") role = "pick";
      else if (effectiveTool === "eraser") role = "erase";
      else if (effectiveTool === "liquify") role = "liquify";
      else if (effectiveTool === "lasso") role = "lasso";
      else if (effectiveTool === "smudge") role = "draw";       // v85+ smudge engine 后改回 smudge
      else if (effectiveTool === "shapes") role = "draw";       // v85+ shapes engine 后改回 shapes
      else role = "draw";
    } else if (e.pointerType === "touch") {
      if (this.penEverSeen) {
        role = "pan";
      } else {
        if (effectiveTool === "picker") role = "pick";
        else if (effectiveTool === "eraser") role = "erase";
        else if (effectiveTool === "liquify") role = "liquify";
        else if (effectiveTool === "lasso") role = "lasso";
          else if (effectiveTool === "smudge") role = "draw";     // v85+
        else if (effectiveTool === "shapes") role = "shapes";
        else role = "draw";
      }
    }

    const now = performance.now();
    const rec = {
      pointerType: e.pointerType, role,
      x, y, startX: x, startY: y,
      smX: x, smY: y,
      downTime: now,
      lastUpdateTs: now,
    };
    this.pointers.set(e.pointerId, rec);

    if (role === "draw" || role === "erase" || role === "liquify") {
      // 画 / 液化的时候不画 cursor（板子 dirty-rect 用，避免 cursor 撑全屏 dirty）
      this.board.setCursor(null);
      // 锚 smoothing / raw / 压感 状态到 down 点。液化也走同一套 smoothing 拿
      // 防 dx 坑（timeStamp 单调 + 四件套），见 docs/ipad-coalesced-events.md
      rec.lastRawX = x;
      rec.lastRawY = y;
      rec.lastP = null;
      rec.smP = -1;
      rec.lastEventTs = -Infinity;
      rec.stabBuf = [];
      rec.pullX = x; rec.pullY = y;
      rec.lastDirX = 0; rec.lastDirY = 0;
      rec.filtX = x; rec.filtY = y;
      if (role === "liquify") this._beginLiquify(rec);
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

    if (rec.role === "draw" || rec.role === "erase" || rec.role === "liquify") {
      // 画 / 液化的时候不刷 cursor preview，省一次全屏 dirty
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      let list = (events && events.length) ? events : [e];
      // **液化丢帧**：每个 event 跑 ~31K typed-array ops，大笔半径下 coalesced
      // 整批连续跑 → 帧延迟堆积 → 越拖越卡。只跑最新一个（保 timeStamp 滤后的）。
      // 画笔不能丢帧，会断笔/疏密；液化每帧独立重采样，丢帧 = 跳过细分但形状仍连续。
      if (rec.role === "liquify" && list.length > 1) list = [list[list.length - 1]];
      const settings = rec.role === "liquify" ? null : this.getBrushSettings();
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
        if (drx * drx + dry * dry < RAW_STATIC_SCREEN_SQ) continue;
        // 四件套位置平滑（对标 Procreate，链式）：
        //   raw → Motion Filter (角速度) → Stabilization (滑动平均) →
        //       Pull-Stabilizer (速度上限) → StreamLine (IIR LPF) → brush
        // 都 0 时 = 单纯 raw 直传。默认 streamline=0.3 其他 0 = 同 v40 行为。
        const sl = settings?.streamline ?? 0;
        const stab = settings?.stabilization ?? 0;
        const pull = settings?.pullStabilizer ?? 0;
        const mf = settings?.motionFilter ?? 0;

        // 1) Motion Filter：限制 (drx, dry) 相对 (lastDirX, lastDirY) 的角度。
        //    mf=1 → 0° clamp (硬锁方向)；mf=0 → 不限。
        let fdx = drx, fdy = dry;
        if (mf > 0) {
          const nLen = Math.hypot(fdx, fdy);
          const oLen = Math.hypot(rec.lastDirX, rec.lastDirY);
          if (nLen > 0 && oLen > 0) {
            const dot = (fdx * rec.lastDirX + fdy * rec.lastDirY) / (nLen * oLen);
            const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
            const maxAng = (1 - mf) * Math.PI;
            if (ang > maxAng && maxAng > 0.001) {
              // 把 (fdx, fdy) 沿短弧旋向 lastDir，限到 maxAng
              const cross = fdx * rec.lastDirY - fdy * rec.lastDirX;
              const sign = cross < 0 ? 1 : -1;
              const ca = Math.cos(maxAng), sa = sign * Math.sin(maxAng);
              const ux = rec.lastDirX / oLen, uy = rec.lastDirY / oLen;
              fdx = (ux * ca - uy * sa) * nLen;
              fdy = (ux * sa + uy * ca) * nLen;
            }
          }
        }
        rec.lastDirX = fdx;
        rec.lastDirY = fdy;
        rec.filtX += fdx;
        rec.filtY += fdy;
        let rx = rec.filtX, ry = rec.filtY;

        // 2) Stabilization：滑动平均，window = 1 + stab × 16
        let sx = rx, sy = ry;
        if (stab > 0) {
          const cap = 1 + Math.round(stab * 16);
          rec.stabBuf.push([rx, ry]);
          if (rec.stabBuf.length > cap) rec.stabBuf.shift();
          let mx = 0, my = 0;
          for (const p of rec.stabBuf) { mx += p[0]; my += p[1]; }
          sx = mx / rec.stabBuf.length;
          sy = my / rec.stabBuf.length;
        } else if (rec.stabBuf.length) {
          rec.stabBuf.length = 0;
        }

        // 3) Pull-Stabilizer：速度上限 follower。pull=0 → 不限；
        //    pull→1 时 maxStep → 0.5 px / event
        if (pull > 0) {
          const maxStep = Math.max(0.5, (1 - pull) * 64);
          const ddx = sx - rec.pullX, ddy = sy - rec.pullY;
          const d = Math.hypot(ddx, ddy);
          if (d > maxStep) {
            rec.pullX += ddx * maxStep / d;
            rec.pullY += ddy * maxStep / d;
          } else {
            rec.pullX = sx; rec.pullY = sy;
          }
        } else {
          rec.pullX = sx; rec.pullY = sy;
        }

        // 4) StreamLine：一阶 IIR LPF。α 下限 0.05 避免 stuck 死
        const alphaPos = Math.max(0.05, 1 - sl);
        rec.smX = rec.smX + alphaPos * (rec.pullX - rec.smX);
        rec.smY = rec.smY + alphaPos * (rec.pullY - rec.smY);
        const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
        if (rec.role === "liquify") {
          this.liquify.extendStroke(dx, dy);
        } else {
          const pressure = effectivePressureFor(rec, ev);
          this.brush.extendStroke(dx, dy, pressure);
        }
      }
      // 把 brush / liquify 累的 dirty bbox 送进 board，rAF render 时只 blit 这一片
      const bbox = rec.role === "liquify" ? this.liquify.flushDirty() : this.brush.flushDirty();
      if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
      this.board.requestRender();
    } else if (rec.role === "lasso") {
      const { x: dx, y: dy } = this.board.screenToDoc(e.clientX, e.clientY);
      if (rec._lassoMode === "tentative") {
        // magic 子工具是 tap-only：不升级到 drawing；_endLasso 在 pointerup 时触发
        if (this.lasso.getSubTool() === "magic") return;
        // freehand / rect：跨过 4 doc-px² 阈值才升级成 drawing
        const ddx = dx - rec._lassoStartDocX;
        const ddy = dy - rec._lassoStartDocY;
        if (ddx * ddx + ddy * ddy > 4) {
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
    } else if (rec.role === "shapes") {
      const { x: dx, y: dy } = this.board.screenToDoc(e.clientX, e.clientY);
      this.shapes.extend(dx, dy);
      this.board.invalidateAll();      // shapes preview 全屏，懒得 dirty rect
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
    } else if (rec.role === "liquify") {
      if (cancelled) this._abortLiquify();
      else this._endLiquify();
    } else if (rec.role === "lasso") {
      if (cancelled) this._abortLasso();
      else this._endLasso(rec);
    } else if (rec.role === "shapes") {
      if (cancelled) this.shapes.cancel();
      else this._endShapes();
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
  _beginStroke(e, rec, mode) {
    const settings = this.getBrushSettings();
    if (!settings || !this.doc.activeLayer) return;
    const layer = this.doc.activeLayer;
    this._strokeLayerId = layer.id;
    this._strokePreSnap = layer.snapshot();

    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    const pressure = effectivePressureFor(rec, e);
    this.brush.beginStroke(layer, settings, dx, dy, pressure, mode);
    const bbox = this.brush.flushDirty();
    if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
    this.board.requestRender();
  }
  _endStroke() {
    this.brush.endStroke();
    if (this._strokeLayerId == null) return;
    const layer = this.doc.layers.find((l) => l.id === this._strokeLayerId);
    const preSnap = this._strokePreSnap;
    this._strokeLayerId = null;
    this._strokePreSnap = null;
    if (!layer || !preSnap) return;
    // 有选区 → stroke 只在选区内生效（per-pixel revert outside mask 到 pre）
    if (this.doc.selection) {
      applySelectionMaskPostStroke(layer, preSnap, this.doc.selection);
      this.board.invalidateAll();
    }
    const postSnap = layer.snapshot();
    const entry = {
      type: "stroke",
      layerId: layer.id,
      before: preSnap,
      after: postSnap,
      beforeBlob: null,
      afterBlob: null,
    };
    if (this.history) this.history.push(entry);
    this.board.requestRender();
    // 异步压缩：toBlob 完成后释放 imageData。失败保留 imageData（无 blob 仍可走 imageData 路径）
    compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  }
  _abortStroke() {
    this.brush.cancelStroke();
    if (this._strokeLayerId != null && this._strokePreSnap) {
      const layer = this.doc.layers.find((l) => l.id === this._strokeLayerId);
      if (layer) layer.restoreFromSnapshot(this._strokePreSnap);
      this.board.invalidateAll();
    }
    this._strokeLayerId = null;
    this._strokePreSnap = null;
  }

  // ---- 液化 ----
  // 一次"按-拖-抬"= 一个 "liquify" history entry。schema 同 stroke。
  _beginLiquify(rec) {
    const settings = this.getLiquifySettings();
    if (!settings || !this.doc.activeLayer) { rec.role = null; return; }
    const layer = this.doc.activeLayer;
    this._liquifyLayerId = layer.id;
    this._liquifyPreSnap = layer.snapshot();
    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    this.liquify.beginStroke(layer, settings, dx, dy);
    this.board.requestRender();
  }
  _endLiquify() {
    this.liquify.endStroke();
    if (this._liquifyLayerId == null) return;
    const layer = this.doc.layers.find((l) => l.id === this._liquifyLayerId);
    const preSnap = this._liquifyPreSnap;
    this._liquifyLayerId = null;
    this._liquifyPreSnap = null;
    if (!layer || !preSnap) return;
    // 有选区 → 液化只在选区内生效
    if (this.doc.selection) {
      applySelectionMaskPostStroke(layer, preSnap, this.doc.selection);
      this.board.invalidateAll();
    }
    const postSnap = layer.snapshot();
    const entry = {
      type: "liquify",
      layerId: layer.id,
      before: preSnap,
      after: postSnap,
      beforeBlob: null,
      afterBlob: null,
    };
    if (this.history) this.history.push(entry);
    this.board.requestRender();
    compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  }
  _abortLiquify() {
    this.liquify.cancelStroke();
    if (this._liquifyLayerId != null && this._liquifyPreSnap) {
      const layer = this.doc.layers.find((l) => l.id === this._liquifyLayerId);
      if (layer) layer.restoreFromSnapshot(this._liquifyPreSnap);
      this.board.invalidateAll();
    }
    this._liquifyLayerId = null;
    this._liquifyPreSnap = null;
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
    const before = layer.snapshot();
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
      const after = layer.snapshot();
      if (this.history) {
        const entry = {
          type: "stroke", layerId: layer.id,
          before, after, beforeBlob: null, afterBlob: null,
        };
        this.history.push(entry);
        compressPixelSnap(before, (blob) => { entry.beforeBlob = blob; });
        compressPixelSnap(after,  (blob) => { entry.afterBlob  = blob; });
      }
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
          this.lasso.cancelDrawing();
        }
      } catch (e) {
        console.error("[lasso end]", e);
        this.status("选区操作出错：" + (e.message || e));
        this.lasso.cancelDrawing();
      }
    } else if (rec._lassoMode === "transform") {
      this.lasso.endDrag();
    } else if (rec._lassoMode === "tentative") {
      // 没拖到阈值 → magic 子工具仍触发（魔术棒是 tap）；freehand / rect 静默
      if (this.lasso.getSubTool() === "magic") {
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
          // 不要再静默挂 —— v71 容隙 bug 就是因为这条路径默默吞掉错误
          console.error("[magic-wand]", e);
          this.status("魔术棒出错：" + (e.message || e));
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
    if (ix < 0 || iy < 0 || ix >= this.doc.width || iy >= this.doc.height) return;
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
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const angle = Math.atan2(dy, dx);
    const g = this.gestureStart;
    // scale 增量
    const k = dist / g.dist;
    let newScale = g.vp.scale * k;
    newScale = Math.max(this.board.minScale, Math.min(this.board.maxScale, newScale));
    // rotation 增量（两指角度差）
    let dRot = angle - g.angle;
    // 归一化到 [-π, π]
    if (dRot > Math.PI) dRot -= 2 * Math.PI;
    if (dRot < -Math.PI) dRot += 2 * Math.PI;
    let newRot = g.vp.rot + dRot;
    // 旋转 snap 改成松手时才生效（v47）—— gesture 进行中用户拧着角度，
    // 不要让画面被吸到整数，那样手感粘。endGesture 里检查并 snap 一次。
    // 围绕 g.midX, g.midY 旋转 + 缩放 + 平移到当前 midX, midY
    // 用变换的 anchor-preserving 公式（参考 board.rotateAt / zoomAt）：
    // 1. 起始：viewport = g.vp
    // 2. 想要：手指开始时按住的 doc 点（screenToDoc(g.midX, g.midY) under g.vp）
    //    在更新后视口下出现在 (midX, midY)
    // 直接 setViewport：先求新 tx/ty
    //   newTx, newTy 让 docPoint @ (g.midX, g.midY) 落到 (midX, midY)
    // 推导：用临时 viewport (newScale, newRot, ?, ?)，求 ?, ?
    // 见 board.screenToDoc 公式逆运算
    const W = this.board.doc.width, H = this.board.doc.height;
    // 起始时 g.midX, g.midY 对应的 doc 点
    const startDocCenterX = g.vp.tx + W * g.vp.scale / 2;
    const startDocCenterY = g.vp.ty + H * g.vp.scale / 2;
    const sdx = g.midX - startDocCenterX, sdy = g.midY - startDocCenterY;
    const sc = Math.cos(-g.vp.rot), ss = Math.sin(-g.vp.rot);
    const dpX = (sdx * sc - sdy * ss) / g.vp.scale + W / 2;
    const dpY = (sdx * ss + sdy * sc) / g.vp.scale + H / 2;
    // 现在求 newTx, newTy 让 dpX, dpY 在新视口下落到 midX, midY
    //   midX = (dpX - W/2) * newScale * cos(newRot) - (dpY - H/2) * newScale * sin(newRot) + cx
    // 其中 cx = newTx + W * newScale / 2 → 解出 newTx
    const c = Math.cos(newRot), s = Math.sin(newRot);
    const rx = (dpX - W / 2) * newScale;
    const ry = (dpY - H / 2) * newScale;
    const newCx = midX - (rx * c - ry * s);
    const newCy = midY - (rx * s + ry * c);
    const newTx = newCx - W * newScale / 2;
    const newTy = newCy - H * newScale / 2;
    this.board.setViewport(newTx, newTy, newScale, newRot);
  }
  _endGesture() {
    this.gestureStart = null;
    delete document.body.dataset.panning;
    // 松手时检查旋转是否接近 0°/90°/180°/270°，是则吸到整数。
    // 阈值 5°（同 Procreate）。在 update 阶段不 snap 是为了不"粘手"。
    const SNAP_DEG = 5;
    const snapStep = Math.PI / 2;
    const cur = this.board.viewport.rot;
    const n = Math.round(cur / snapStep);
    const snapped = n * snapStep;
    if (cur !== snapped && Math.abs(cur - snapped) < SNAP_DEG * Math.PI / 180) {
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
    else if (e.key === "l" || e.key === "L") this._emitTool("lasso");
    else if (e.key === "Enter" && this.lasso.state() === "floating") { this._commitLasso(); e.preventDefault(); }
    else if (e.key === "Escape" && this.lasso.state() === "floating") { this._abortLasso(); e.preventDefault(); }
    // Esc 在非 floating 状态 = 取消选区（仅有选区时；不进 history 显式 push 会让 toolbar 自动更新）
    else if (e.key === "Escape" && this.lasso.hasSelection() && this.lasso.state() === "idle") {
      const entry = this.lasso.setSelection(null);
      if (entry && this.history) this.history.push(entry);
      this.board.invalidateAll();
      e.preventDefault();
    }
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

  // undo / redo / canUndo / canRedo 现在都走共享 history（v44 起）。
  // 留这几个 wrapper 给绑了快捷键 / 老 listener 用，**不**自己保存状态。
  canUndo() {
    if (this.lasso.hasFloating()) return true;     // floating 时 undo = cancel
    return !!this.history && this.history.canUndo();
  }
  canRedo() {
    if (this.lasso.hasFloating()) return false;    // floating 时无 redo 语义
    return !!this.history && this.history.canRedo();
  }
  // floating 状态下 undo = 取消变换（user 反馈：transform 时撤销应是 cancel 语义）
  // redo 在 floating 下被禁；切回去 history 自然续上
  undo() {
    if (this.lasso.hasFloating()) {
      this._abortLasso();
      this.status?.("已取消变换");
      return;
    }
    if (this.history) this.history.undo();
  }
  redo() {
    if (this.lasso.hasFloating()) return;
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
    if (p.role === "draw" || p.role === "erase") this._abortStroke();
    else if (p.role === "liquify") this._abortLiquify();
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

// ---- Pixel snapshot helpers（exported；handler 里 layer/raster 类 op 都用这套）----
// 取 Layer.snapshot() 出来的 { bboxX/Y/W/H, imageData } 异步压成 PNG Blob。
// 成功时回调拿到 Blob 且 snap.imageData 被置 null 释放 16MB。失败保留 imageData。
export function compressPixelSnap(snap, onBlob) {
  if (!snap || !snap.imageData) { onBlob(null); return; }
  if (snap.bboxW <= 0 || snap.bboxH <= 0) { snap.imageData = null; onBlob(null); return; }
  const c = document.createElement("canvas");
  c.width = snap.bboxW;
  c.height = snap.bboxH;
  c.getContext("2d").putImageData(snap.imageData, 0, 0);
  c.toBlob((blob) => {
    if (!blob) { onBlob(null); return; }
    snap.imageData = null;     // 释放 raw
    onBlob(blob);
  }, "image/png");
}

// 把 { snap, blob } 应用到指定 layer。imageData 优先（同步），否则解 blob（异步）。
// invalidateAll 在像素到位后才调，避免渲染 stale 帧 flash。
export function applyPixelSnap(doc, layerId, snap, blob, board) {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) return Promise.resolve();
  if (snap && snap.imageData) {
    layer.restoreFromSnapshot(snap);
    board?.invalidateAll();
    return Promise.resolve();
  }
  if (!blob) {
    if (snap) layer.restoreFromSnapshot({ ...snap, imageData: null });
    board?.invalidateAll();
    return Promise.resolve();
  }
  return createImageBitmap(blob).then((bitmap) => {
    layer.restoreFromSnapshot({ ...snap, bitmap });
    bitmap.close?.();
    board?.invalidateAll();
  });
}

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
