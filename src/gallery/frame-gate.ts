// 帧门（gallery 防误触）：手指按住期间（+抬起后短尾）到达的列表帧先扣住、只留最新，门开时再上屏。
// 修「正好在点的时候 store sync 完成 → tile 位移 → 点错/进错文档」（user 2026-08-19）。
//
// 纯逻辑零 DOM（timers 可注入，node 直测）；pointer 事件接线在 gallery.ts。
//
// 语义：
// - push(frame)：门开 → 立即 apply；门关 → 顶掉旧 pending 只留最新（帧是全量快照，中间帧无价值）。
// - pointerDown/pointerUp：多指计数；最后一指抬起后再等 tailMs 才真正开门（盖住 touch→click 派发窗口）。
// - maxHoldMs 保险丝：pointerup 丢失（浏览器 quirk / 页面切走）会让门永闭 → 到点强制开门。
//   宁可小概率位移，不可图库冻结。
// - reset()：卸载/兜底——清计数、立即开门（pending 照常 apply）。

export interface FrameGateTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: FrameGateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface FrameGate<T> {
  push(frame: T): void;
  pointerDown(): void;
  pointerUp(): void;   // pointerup 和 pointercancel 都走这
  reset(): void;
  isHeld(): boolean;
}

export function createFrameGate<T>(
  apply: (frame: T) => void,
  opts?: { tailMs?: number; maxHoldMs?: number; timers?: FrameGateTimers },
): FrameGate<T> {
  const tailMs = opts?.tailMs ?? 300;
  const maxHoldMs = opts?.maxHoldMs ?? 10_000;
  const timers = opts?.timers ?? REAL_TIMERS;

  let pointers = 0;          // 当前按着的指头数（up 无配对 down 时钳在 0，不越界）
  let held = false;
  let pending: T | null = null;
  let hasPending = false;    // 与 pending!=null 分开——T 本身可为 null 形状
  let tailTimer: unknown = null;
  let capTimer: unknown = null;

  function clearTail(): void { if (tailTimer != null) { timers.clear(tailTimer); tailTimer = null; } }
  function clearCap(): void { if (capTimer != null) { timers.clear(capTimer); capTimer = null; } }
  function open(): void {
    held = false; clearTail(); clearCap();
    if (hasPending) { const f = pending as T; pending = null; hasPending = false; apply(f); }
  }

  return {
    push(frame: T): void {
      if (held) { pending = frame; hasPending = true; } else apply(frame);
    },
    pointerDown(): void {
      pointers++;
      clearTail();   // 尾巴期间又按下 → 取消预定的开门，继续持门
      if (!held) { held = true; capTimer = timers.set(open, maxHoldMs); }
    },
    pointerUp(): void {
      if (pointers > 0) pointers--;
      if (pointers === 0 && held) { clearTail(); tailTimer = timers.set(open, tailMs); }
    },
    reset(): void { pointers = 0; open(); },
    isHeld: () => held,
  };
}
