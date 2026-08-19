// history —— v2 undo 编排器（T5 立；legacy-bridge/LegacyHistory 的 v2-native 后继，operator 流已死）。
//
// 职责（刻意窄）：
//   - **共享令牌的开/续/封**（withPoint）：checkpoint:false = 令牌留开聚合微步（层面板连点、
//     import 单整点、fill compound 的时序全靠它）；sealCheckpoint = 手势结束封口。
//     嵌套 withPoint 骑外层令牌（openedHere 才有回滚权——内层失败 throw 给外层统一 cancel）。
//   - undo/redo 门：顶端未封口 → 补封再翻；swap 抛异常 = 状态不可信 → 不可恢复协议。
//   - 不可恢复协议（宁丢历史不留半坏）：cancel 自身失败 / swap 中途失败 → 弃整栈 +
//     onUnrecoverable（app 侧接 integrity 自愈 + 全量重绘 + error banner）。
// 组件 verb 的记账/回滚本体在各 collector（ADR-0008）；本类只管令牌与栈的编排，不碰 DOM/i18n。

import { UndoStack, type UndoStep } from "./undo-stack.ts";
import type { Workpiece, WriteToken } from "./workpiece.ts";

export interface HistoryOpts {
  maxQuotaBytes: number;
  /** 不可恢复失败（栈已被弃）。app 侧接：integrity 自愈 + 全量重绘 + error banner。 */
  onUnrecoverable: (e: unknown) => void;
  /** 栈形状变化（push/undo/redo/clear/evict）。app 侧接 wp:histchange 派发。 */
  onChange?: () => void;
  /** 某步被应用（undo/redo；按 step entries 逐组件报）。app 侧接面板/画面刷新。 */
  onApplied?: (info: { kind: string; dir: "undo" | "redo" }) => void;
}

export class History {
  readonly stack: UndoStack;
  private _opts: HistoryOpts;
  private _wp: Workpiece | null = null;
  private _open: WriteToken | null = null;

  constructor(opts: HistoryOpts) {
    this._opts = opts;
    this.stack = new UndoStack({
      maxQuotaBytes: opts.maxQuotaBytes,
      onChange: opts.onChange,
      onApplied: (step, dir) => this._translateApplied(step, dir),
    });
  }

  /** 组合根装配（wp 的 ctor 需要 stack 先在 → late-bind）。 */
  attach(wp: Workpiece): void {
    if (this._wp) throw new Error("History: attached twice");
    this._wp = wp;
  }

  /** 一个 undo 整点：fn 里直写 v2 组件 verb；本方法只管共享令牌的开/续/封。
   *  checkpoint:false = 留开聚合微步（语义同旧 run/withPoint）；hint = step 的非权威附注。 */
  withPoint<T>(label: string | undefined, o: { checkpoint?: boolean; hint?: (dir: "undo" | "redo") => void } | undefined, fn: () => T): { ok: boolean; value?: T; msg?: string } {
    const wp = this._req();
    const openedHere = !this._open;
    if (!this._open) this._open = wp.begin(label);
    let value: T;
    try {
      value = fn();
    } catch (e) {
      if (openedHere) {
        const tok = this._open;
        this._open = null;
        try { tok?.cancel(); }
        catch (e2) { this._unrecoverable(e2); }   // 回滚自身失败 → 不可恢复
      } else {
        throw e;   // 外层开的令牌：让外层的 catch 统一回滚
      }
      return { ok: false, msg: String(e) };
    }
    if (o?.checkpoint !== false) this._commitOpen(o?.hint);
    return { ok: true, value };
  }

  /** 手势结束：把开着的微步令牌封口。 */
  sealCheckpoint(): void { this._commitOpen(); }

  undo(): boolean {
    this._commitOpen();                  // 顶端未封口 → 补封
    try { return this.stack.undo(); }
    catch (e) { this._unrecoverable(e); return false; }
  }
  redo(): boolean {
    this._commitOpen();
    try { return this.stack.redo(); }
    catch (e) { this._unrecoverable(e); return false; }
  }

  canUndo(): boolean { return this.stack.canUndo(); }
  canRedo(): boolean { return this.stack.canRedo(); }
  get depth(): number { return this.stack.depth(); }
  quotaUsage(): number { return this.stack.quotaUsage(); }

  /** 弃整栈（换文档/不可恢复）。开着的令牌弃置（不回滚——load 流里层可能已换血）。 */
  clear(): void {
    if (this._open) { const t = this._open; this._open = null; t.abandon(); }
    this.stack.clear();
  }

  // ---- 内部 ----

  private _req(): Workpiece {
    if (!this._wp) throw new Error("History: not attached (composition-root assembly-order bug)");
    return this._wp;
  }

  private _commitOpen(hint?: (dir: "undo" | "redo") => void): void {
    if (!this._open) return;
    const t = this._open;
    this._open = null;
    t.commit(hint ? { hint } : undefined);
  }

  private _translateApplied(step: UndoStep, dir: "undo" | "redo"): void {
    if (!this._opts.onApplied) return;
    for (const e of step.entries) this._opts.onApplied({ kind: e.c.kind, dir });
  }

  private _unrecoverable(e: unknown): void {
    if (this._open) { const t = this._open; this._open = null; try { t.abandon(); } catch { /* 已不可信 */ } }
    this.stack.clear();
    this._opts.onUnrecoverable(e);
  }
}
