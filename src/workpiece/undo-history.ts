// undo-history —— 配额制 undo 栈（0.4 纪元，spec: journal/20260721 Architecture.md §undo-history）。
// 取代 history.ts 的 UndoStack（计数上限 FIFO + 注册 handler）：
//   - 入栈的是 microstep = { operator, args, data }，data 是**当前方向的逆包**（游标以下存 undo 包，
//     以上存 redo 包——forward/backward 对称 swap，见 workpiece.ts OpResult 契约）。
//   - checkpoint：多个 microstep 进一个 undo 整点（手势流 push {checkpoint:false}，抬手 sealCheckpoint）。
//     undo/redo 一次动到整点；驱逐必须到整 checkpoint。undo 时顶端未封口 → warning + 补封（原则上不应发生）。
//   - 配额驱逐：evict by maxQuotaBytes。每次 push 全量重扫 estimateQuotaBytes（为什么会变：tile 压缩前
//     记 0——走共享 raw 池配额；压缩后被本栈 own，usage 反而涨。spec line 87-89）。
//   - 不可恢复协议（spec line 65 + journal/WP feedback arch.md ~1777 人类要求）：backward/rollback 失败
//     或 operator 抛非原子异常 → 弃**整栈** + onUnrecoverable（app 侧：workpiece integrity 自愈 +
//     render tree 重建 + error banner）。宁可丢 undo 历史，不可留半坏状态假装能撤。
//
// 本模块 DOM-free（事件派发/toast/面板刷新由 app 经 onChange/onApplied 接线）→ node 全可测。

import { Workpiece, DocumentOperator, type OpStatus } from "./workpiece.ts";

interface Microstep {
  op: DocumentOperator<unknown, unknown>;
  args: unknown;
  data: unknown;              // 当前方向的逆包（undefined 合法：无数据 op）
  checkpoint: boolean;        // true = 本步是一个 checkpoint 的**封口**（最后一步）
  label?: string;
}

export interface UndoHistoryOpts {
  maxQuotaBytes: number;
  /** 不可恢复失败（栈已被弃）。app 侧接：integrity 自愈 + 全量重绘 + error banner。 */
  onUnrecoverable: (e: unknown) => void;
  /** 栈形状变化（push/undo/redo/clear/evict）。app 侧接 wp:histchange 派发。 */
  onChange?: () => void;
  /** 某步被应用（do/undo/redo）。app 侧接状态栏 toast + 面板刷新。 */
  onApplied?: (info: { kind: string; dir: "do" | "undo" | "redo"; status?: string }) => void;
}

export class UndoHistory {
  private _steps: Microstep[] = [];
  private _cursor = -1;              // 最后一个「已应用」step 的下标；-1 = 无
  private _opts: UndoHistoryOpts;

  constructor(opts: UndoHistoryOpts) { this._opts = opts; }

  /**
   * 执行一个 operator 并入栈。checkpoint 默认 true（独立动作）；手势流传 false + 抬手 sealCheckpoint()。
   * 返回 operator 的状态；ok:false = 已原子回滚，栈未动。
   */
  run<A, D>(w: Workpiece, op: DocumentOperator<A, D>, args: A, o?: { checkpoint?: boolean; label?: string }): OpStatus {
    let res;
    w._acquireLock(op.kind);
    try {
      res = op.forward(w, args, undefined);
    } catch (e) {
      w._releaseLock(op.kind);
      this._unrecoverable(e);          // operator 抛异常 = 无法保证原子性（spec line 67）
      return { ok: false, msg: String(e) };
    }
    w._releaseLock(op.kind);
    if (!res.ok) return { ok: false, msg: res.msg };

    // 截断 redo 段（undo 过又有新动作）
    if (this._cursor < this._steps.length - 1) {
      const dropped = this._steps.splice(this._cursor + 1);
      for (const s of dropped) this._disposeStep(s);
    }
    this._steps.push({
      op: op as DocumentOperator<unknown, unknown>,
      args, data: res.replaced,
      checkpoint: o?.checkpoint ?? true,
      label: o?.label,
    });
    this._cursor++;
    w._bumpCommit();
    this._evictToQuota();
    this._opts.onChange?.();
    this._opts.onApplied?.({ kind: op.kind, dir: "do", status: op.statusFor?.("do", args) });
    return { ok: true };
  }

  /** 手势结束：把游标处最后一步封口成 checkpoint（微步流的整点标记）。 */
  sealCheckpoint(): void {
    if (this._cursor >= 0) this._steps[this._cursor].checkpoint = true;
  }

  /**
   * 复合动作：fn 里跑若干 run(..., {checkpoint:false})，全成 → 自动封口成一个 checkpoint；
   * 中途某步 ok:false 或抛异常 → 把 fn 内已入栈的微步**倒序回滚并弹掉**（回滚到进入前的整点）。
   * 回滚自身失败 → 不可恢复路径。fn 的返回值透传。
   */
  compound<T>(w: Workpiece, fn: () => T): { ok: boolean; value?: T; msg?: string } {
    const startCursor = this._cursor;
    let value: T;
    try {
      value = fn();
    } catch (e) {
      this._rollbackTo(w, startCursor);
      return { ok: false, msg: String(e) };
    }
    this.sealCheckpoint();
    return { ok: true, value };
  }

  /** 撤销一个整 checkpoint。顶端未封口 → warning 语义：先补封再撤（返回值照常）。 */
  undo(w: Workpiece): boolean {
    if (!this.canUndo()) return false;
    if (!this._steps[this._cursor].checkpoint) this.sealCheckpoint();   // 原则上不应发生（spec line 91）
    // 本 checkpoint 组 = (上一个封口下标, cursor]。倒序 backward。
    const stop = this._prevCheckpointIndex(this._cursor);
    while (this._cursor > stop) {
      const s = this._steps[this._cursor];
      if (!this._applyStep(w, s, "backward")) return false;   // 失败已走不可恢复
      this._cursor--;
      this._opts.onApplied?.({ kind: s.op.kind, dir: "undo", status: s.op.statusFor?.("undo", s.args) });
    }
    w._bumpCommit();
    this._opts.onChange?.();
    return true;
  }

  /** 重做一个整 checkpoint。 */
  redo(w: Workpiece): boolean {
    if (!this.canRedo()) return false;
    // 目标：应用 cursor+1 起、直到（含）下一个封口步。
    while (this._cursor < this._steps.length - 1) {
      const s = this._steps[this._cursor + 1];
      if (!this._applyStep(w, s, "forward")) return false;
      this._cursor++;
      this._opts.onApplied?.({ kind: s.op.kind, dir: "redo", status: s.op.statusFor?.("redo", s.args) });
      if (s.checkpoint) break;
    }
    w._bumpCommit();
    this._opts.onChange?.();
    return true;
  }

  canUndo(): boolean { return this._cursor >= 0; }
  canRedo(): boolean { return this._cursor < this._steps.length - 1; }
  get depth(): number { return this._steps.length; }

  /** 全量重扫各步 estimateQuotaBytes（压缩会让单步 usage 变，不缓存）。 */
  quotaUsage(): number {
    let sum = 0;
    for (const s of this._steps) sum += s.op.estimateQuotaBytes(s.args, s.data);
    return sum;
  }

  /** 弃整栈（换文档/不可恢复）。逐步 disposeData 释放句柄。 */
  clear(): void {
    for (const s of this._steps) this._disposeStep(s);
    this._steps = [];
    this._cursor = -1;
    this._opts.onChange?.();
  }

  // ---- 内部 ----

  private _applyStep(w: Workpiece, s: Microstep, dir: "forward" | "backward"): boolean {
    let res;
    w._acquireLock(s.op.kind);
    try {
      res = dir === "forward" ? s.op.forward(w, s.args, s.data) : s.op.backward(w, s.args, s.data as never);
    } catch (e) {
      w._releaseLock(s.op.kind);
      this._unrecoverable(e);
      return false;
    }
    w._releaseLock(s.op.kind);
    if (!res.ok) {
      // undo/redo 中途失败：栈已半应用 → 状态与游标失配，唯一诚实的出路是不可恢复协议
      this._unrecoverable(new Error(`undo-history: ${s.op.kind}.${dir} 失败: ${res.msg ?? "?"}`));
      return false;
    }
    s.data = res.replaced;   // 方向翻转：undo 包 ↔ redo 包
    return true;
  }

  private _rollbackTo(w: Workpiece, targetCursor: number): void {
    while (this._cursor > targetCursor) {
      const s = this._steps[this._cursor];
      let ok = false;
      w._acquireLock(s.op.kind);
      try {
        ok = s.op.backward(w, s.args, s.data as never).ok;
      } catch { ok = false; }
      w._releaseLock(s.op.kind);
      if (!ok) { this._unrecoverable(new Error(`undo-history: compound 回滚失败于 ${s.op.kind}`)); return; }
      this._disposeStep(this._steps.pop()!);
      this._cursor--;
    }
    this._opts.onChange?.();
  }

  private _prevCheckpointIndex(from: number): number {
    for (let i = from - 1; i >= 0; i--) if (this._steps[i].checkpoint) return i;
    return -1;
  }

  private _evictToQuota(): void {
    // 从最老端驱逐**整 checkpoint**，直到 quota 之内；至少保住最新一个 checkpoint（刚做的动作必须能撤）。
    while (this.quotaUsage() > this._opts.maxQuotaBytes) {
      let end = 0;
      while (end < this._steps.length && !this._steps[end].checkpoint) end++;
      if (end >= this._cursor) break;   // 只剩最新组/游标组 → 不驱逐（宁超配额不砍正在用的）
      const evicted = this._steps.splice(0, end + 1);
      for (const s of evicted) this._disposeStep(s);
      this._cursor -= evicted.length;
    }
  }

  private _disposeStep(s: Microstep): void {
    try { s.op.disposeData(s.args, s.data); } catch { /* dispose 尽力而为 */ }
  }

  private _unrecoverable(e: unknown): void {
    // 弃整栈：undo 已不可信（spec line 65——无法回滚 = full undo stack corrupted, discard all）
    this.clear();
    this._opts.onUnrecoverable(e);
  }
}
