// 拖动取值核（UI 深模块，v0.7.8）——pointer 事件 → 归一化值 [0,1]²，1D/2D 滑块共用。
//
// 为什么收拢：全仓滑块拖动逻辑各写各的（色轮 SV pad 自绘、hue/adjust 是原生 range），
// 原生 range 做不了「shift 细调」（指针动、值慢动），自绘的 capture 坑各踩各的。这里一次做对：
//   · pointer capture + buttons===0 兜底（色轮教训：reactive 回灌 re-render 可能丢 capture，
//     抬键落在元素外 pointerup 不回来，拖动卡住「一直跟着」）+ pointercancel。
//   · tap/普通拖 = 绝对映射（点哪到哪）；按住 shift = 细调——值按指针位移 × fineGain 相对累积，
//     指示器从此独立于光标（行业惯例同款：PS/Figma 的 shift 精调）。
//   · shift 中途按下 = 无缝切相对模式（从当前值起步，不跳变）；中途松开 = 本次拖动**保持**
//     相对模式、恢复常速（若跳回绝对映射，值会瞬跳到光标位置——正是要避免的）。
//   · 触摸无 shift，自然全程绝对映射，行为不变。
//
// 渲染零知识：thumb/track/pad 的画法归宿主（Vue 组件 / DOM 工厂都能用）；本模块只回调归一化值。
// 值域映射（线性/量化/百分比）也归宿主——ramp-slider.ts 是 1D 的 DOM 工厂皮。

export interface DragValueOpts {
  /** 当前归一化值（相对模式起步锚；1D 宿主只用 x）。 */
  getValue(): { x: number; y: number };
  /** 每次取值变化回调（fine = 当拍处于 shift 细调）。 */
  onDrag(x: number, y: number, fine: boolean): void;
  /** 拖动结束（up/cancel/buttons 兜底），coalescing-history 类消费者在这里落 undo。 */
  onCommit?(): void;
  /** shift 细调增益，默认 0.15。 */
  fineGain?: number;
}

// ---- 纯状态机（node 可测；attach 只是 DOM 皮）----

export interface DragMoveEv {
  clientX: number; clientY: number; shiftKey: boolean;
}
export interface DragRect { left: number; top: number; width: number; height: number }
export interface DragState {
  mode: "abs" | "rel";
  x: number; y: number;           // 当前归一化值
  lastPx: number; lastPy: number; // 上一拍指针位置（相对模式增量用）
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function dragBegin(ev: DragMoveEv, rect: DragRect, cur: { x: number; y: number }): DragState {
  if (ev.shiftKey) {
    // shift 起手：相对模式，从当前值起步（不跳到点击处）
    return { mode: "rel", x: clamp01(cur.x), y: clamp01(cur.y), lastPx: ev.clientX, lastPy: ev.clientY };
  }
  return {
    mode: "abs",
    x: clamp01((ev.clientX - rect.left) / (rect.width || 1)),
    y: clamp01((ev.clientY - rect.top) / (rect.height || 1)),
    lastPx: ev.clientX, lastPy: ev.clientY,
  };
}

export function dragMove(st: DragState, ev: DragMoveEv, rect: DragRect, fineGain: number): DragState {
  // 中途按下 shift：切相对模式（值不动，重锚增量起点——已由 lastPx 每拍更新保证）
  const mode = ev.shiftKey ? "rel" : st.mode;
  let x: number, y: number;
  if (mode === "abs") {
    x = clamp01((ev.clientX - rect.left) / (rect.width || 1));
    y = clamp01((ev.clientY - rect.top) / (rect.height || 1));
  } else {
    const gain = ev.shiftKey ? fineGain : 1;
    x = clamp01(st.x + ((ev.clientX - st.lastPx) / (rect.width || 1)) * gain);
    y = clamp01(st.y + ((ev.clientY - st.lastPy) / (rect.height || 1)) * gain);
  }
  return { mode, x, y, lastPx: ev.clientX, lastPy: ev.clientY };
}

// ---- DOM 皮 ----

export interface DragValueHandle {
  dispose(): void;
  dragging(): boolean;
}

export function attachDragValue(el: HTMLElement, opts: DragValueOpts): DragValueHandle {
  const fineGain = opts.fineGain ?? 0.15;
  let st: DragState | null = null;

  const emit = () => { if (st) opts.onDrag(st.x, st.y, st.mode === "rel"); };
  const end = (e?: PointerEvent) => {
    if (!st) return;
    st = null;
    if (e) { try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ } }
    opts.onCommit?.();
  };

  const down = (e: PointerEvent) => {
    try { el.setPointerCapture(e.pointerId); } catch { /* 捕获失败可容忍，靠 buttons 兜底 */ }
    st = dragBegin(e, el.getBoundingClientRect(), opts.getValue());
    emit();
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (!st) return;
    // 漏掉的 pointerup 兜底：拖动中按键已松（鼠标 buttons=0）→ 结束，别再跟手
    if (e.pointerType !== "touch" && e.buttons === 0) { end(e); return; }
    st = dragMove(st, e, el.getBoundingClientRect(), fineGain);
    emit();
  };
  const up = (e: PointerEvent) => end(e);

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  return {
    dispose() {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      st = null;
    },
    dragging: () => st !== null,
  };
}
