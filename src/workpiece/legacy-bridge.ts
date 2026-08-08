// legacy-bridge —— 迁移期唯一 undo 栈的桥（T2 立，T5 拆）。
//
// ☠ 拆迁楼，只减不增：**新代码禁止 import 本模块、禁止新增 history.run/compound 调用方**。
// 新功能一律令牌+组件直写（wp2.begin + layerTiles/layerTree2/…）；本桥的现存调用方每迁走一族
// 划掉一族（T3b-2 树/T4 选区·float·persp），T5 清零后连文件一起删。它若还活着 = 重构没交付。
//
// 问题：v2 纪元切像素路径时不能让 undo 分裂成两个栈（fill compound 的原子性、ctrl-z 时序都会碎）。
// 解：v2 UndoStack **立刻成为唯一权威**；旧 DocumentOperator 流（LayerTree/SelectionFace/doc-ops/
// float/layers-panel/import-image）经本桥骑上 v2 栈——旧 forward/backward 的对称 swap 契约
// （workpiece.ts OpResult：apply 吐 replaced，方向往复）正好包成 v2 的自反 record：
//   microstep = { op, args, data, side }；swap = side==="undo" ? 倒序 backward : 正序 forward，翻 side。
// 本桥保持旧 UndoHistory 的公共面（run/compound/sealCheckpoint/undo/redo/…，HistoryFacade），
// 调用方零改动；checkpoint 语义映射成令牌：checkpoint:false = 令牌留开聚合微步，封口 = commit。
//
// 双记账防线：旧 op 应用期间挂起 LayerTiles 收集（suspendCollect）——op 自带快照，观察者再收=双份。
// 不可恢复协议沿旧栈：op 抛非原子异常 / swap 中途失败 → 弃整栈 + onUnrecoverable（宁丢历史不留半坏）。

import { UndoStack, type UndoStep, type RecordData } from "./undo-stack.ts";
import type { Workpiece as WorkpieceV2, WriteToken, CollectorComponent } from "./workpiece2.ts";
import type { Workpiece as WorkpieceV1, DocumentOperator, OpStatus, HistoryFacade } from "./workpiece.ts";

interface Microstep {
  op: DocumentOperator<unknown, unknown>;
  args: unknown;
  data: unknown;               // 当前 side 方向的逆包（undefined 合法：无数据 op）
  side: "undo" | "redo";       // data 是哪侧的包（swap 时翻转——对称契约沿旧栈）
}

/** 旧 operator 的 v2 组件化包装（collector = 本 token 的 microstep 列表）。 */
export class LegacyOpsComponent implements CollectorComponent {
  readonly kind = "legacyOps";
  private _w1: WorkpieceV1;
  private _pending: Microstep[] = [];
  /** 应用窗口挂起 tile 收集（app 组合根接 LayerTiles._suspendCollect；测试可空转）。 */
  _suspendCollect: (on: boolean) => void = () => {};

  constructor(w1: WorkpieceV1) { this._w1 = w1; }

  /** 桥的 run 入口：持锁跑 forward（首跑），成了进 pending。op 抛异常 → 直接传播（桥走不可恢复）。 */
  runForward<A, D>(wp2: WorkpieceV2, op: DocumentOperator<A, D>, args: A): OpStatus {
    wp2._componentWrite(this);
    let res;
    this._suspendCollect(true);
    this._w1._acquireLock(op.kind);
    try {
      res = op.forward(this._w1, args, undefined);
    } finally {
      this._w1._releaseLock(op.kind);
      this._suspendCollect(false);
    }
    if (!res.ok) return { ok: false, msg: res.msg };
    this._pending.push({ op: op as DocumentOperator<unknown, unknown>, args, data: res.replaced, side: "undo" });
    return { ok: true };
  }

  sealRecord(): RecordData | null {
    if (!this._pending.length) return null;
    const r = this._pending;
    this._pending = [];
    return r;
  }

  swapRecord(data: RecordData): RecordData {
    const list = data as Microstep[];
    // undo 包 → 倒序 backward；redo 包 → 正序 forward。中途失败 = 状态与游标失配 → throw（桥收→不可恢复）。
    const side = list[0]?.side ?? "undo";
    const seq = side === "undo" ? [...list].reverse() : list;
    for (const m of seq) {
      let res;
      this._suspendCollect(true);
      this._w1._acquireLock(m.op.kind);
      try {
        res = m.side === "undo"
          ? m.op.backward(this._w1, m.args, m.data as never)
          : m.op.forward(this._w1, m.args, m.data);
      } finally {
        this._w1._releaseLock(m.op.kind);
        this._suspendCollect(false);
      }
      if (!res.ok) throw new Error(`legacy-bridge: ${m.op.kind}.${m.side === "undo" ? "backward" : "forward"} 失败: ${res.msg ?? "?"}`);
      m.data = res.replaced;
      m.side = m.side === "undo" ? "redo" : "undo";
    }
    return list;   // 同一数组，side 已全翻 → 自反
  }

  recordBytes(data: RecordData): number {
    let sum = 0;
    for (const m of data as Microstep[]) sum += m.op.estimateQuotaBytes(m.args, m.data);
    return sum;
  }

  disposeRecord(data: RecordData): void {
    for (const m of data as Microstep[]) {
      try { m.op.disposeData(m.args, m.data); } catch { /* dispose 尽力而为 */ }
    }
  }

  /** 桥 onApplied 翻译用：step entry 里的 microstep 列表（kind/status 逐条报，沿旧 toast 契约）。 */
  microstepsOf(data: RecordData): { kind: string; statusFor?: (dir: "do" | "undo" | "redo") => string | undefined }[] {
    return (data as Microstep[]).map((m) => ({
      kind: m.op.kind,
      statusFor: (dir: "do" | "undo" | "redo") => m.op.statusFor?.(dir, m.args),
    }));
  }
}

export interface LegacyHistoryOpts {
  maxQuotaBytes: number;
  /** 不可恢复失败（栈已被弃）。app 侧接：integrity 自愈 + 全量重绘 + error banner。 */
  onUnrecoverable: (e: unknown) => void;
  /** 栈形状变化（push/undo/redo/clear/evict）。app 侧接 wp:histchange 派发。 */
  onChange?: () => void;
  /** 某步被应用（do/undo/redo）。app 侧接状态栏 toast + 面板刷新。 */
  onApplied?: (info: { kind: string; dir: "do" | "undo" | "redo"; status?: string }) => void;
}

export class LegacyHistory implements HistoryFacade {
  readonly stack: UndoStack;
  private _opts: LegacyHistoryOpts;
  private _wp2: WorkpieceV2 | null = null;
  private _legacy: LegacyOpsComponent | null = null;
  private _open: WriteToken | null = null;

  constructor(opts: LegacyHistoryOpts) {
    this._opts = opts;
    this.stack = new UndoStack({
      maxQuotaBytes: opts.maxQuotaBytes,
      onChange: opts.onChange,
      onApplied: (step, dir) => this._translateApplied(step, dir),
    });
  }

  /** 组合根装配（wp2 的 ctor 需要本桥先建出 stack → 循环用 late-bind 解）。 */
  attach(wp2: WorkpieceV2, legacy: LegacyOpsComponent, suspendCollect: (on: boolean) => void): void {
    if (this._wp2) throw new Error("LegacyHistory: 重复 attach");
    this._wp2 = wp2;
    this._legacy = legacy;
    legacy._suspendCollect = suspendCollect;
  }

  /** 旧 run 契约：执行 operator 并记账。checkpoint 默认 true = 立即封口；false = 令牌留开聚合微步。 */
  run<A, D>(_w: WorkpieceV1, op: DocumentOperator<A, D>, args: A, o?: { checkpoint?: boolean; label?: string }): OpStatus {
    const { wp2, legacy } = this._req();
    if (!this._open) this._open = wp2.begin(o?.label ?? op.kind);
    let st: OpStatus;
    try {
      st = legacy.runForward(wp2, op, args);
    } catch (e) {
      this._unrecoverable(e);            // op 抛异常 = 无法保证原子性（沿旧栈 spec line 67）
      return { ok: false, msg: String(e) };
    }
    if (st.ok) this._opts.onApplied?.({ kind: op.kind, dir: "do", status: op.statusFor?.("do", args) });
    if (o?.checkpoint !== false) this._commitOpen();
    return st;
  }

  /** 手势结束：把开着的微步令牌封口（= 旧 sealCheckpoint）。 */
  sealCheckpoint(): void { this._commitOpen(); }

  /** 复合动作：一个令牌 = 一个整点；fn 中途抛/失败 → token.cancel 倒序回滚（含 tile 收集，优于旧实现）。
   *  o.hint（T3b-2 补）：step.hint 落地（提案 .h；docTransform 的 viewport/persp 还原唯一住户）。 */
  compound<T>(_w: WorkpieceV1, fn: () => T, o?: { label?: string; hint?: (dir: "undo" | "redo") => void }): { ok: boolean; value?: T; msg?: string } {
    const { wp2 } = this._req();
    if (!this._open) this._open = wp2.begin(o?.label ?? "compound");
    let value: T;
    try {
      value = fn();
    } catch (e) {
      const tok = this._open;
      this._open = null;
      try { tok?.cancel(); }
      catch (e2) { this._unrecoverable(e2); }   // 回滚自身失败 → 不可恢复（沿旧栈）
      return { ok: false, msg: String(e) };
    }
    this._commitOpen(o?.hint);
    return { ok: true, value };
  }

  /** v2-verb 迁移载具（T3b-2 立，T5 随桥拆）：fn 里**直写 v2 组件**（layerTree2/layerTiles verbs），
   *  本方法只管共享令牌的开/续/封（checkpoint:false = 留开聚合微步，语义同 run）。
   *  与 run/compound 共用 _open → 微步聚合/fill compound/import 单整点的时序全兼容。
   *  注意这不是「新增 legacy op 调用方」——恰相反，它承接从 operator 流迁出的调用方。 */
  withPoint<T>(label: string | undefined, o: { checkpoint?: boolean; hint?: (dir: "undo" | "redo") => void } | undefined, fn: () => T): { ok: boolean; value?: T; msg?: string } {
    const { wp2 } = this._req();
    const openedHere = !this._open;
    if (!this._open) this._open = wp2.begin(label);
    let value: T;
    try {
      value = fn();
    } catch (e) {
      if (openedHere) {
        const tok = this._open;
        this._open = null;
        try { tok?.cancel(); }
        catch (e2) { this._unrecoverable(e2); }
      } else {
        throw e;   // 外层 compound 开的令牌：让它的 catch 统一回滚
      }
      return { ok: false, msg: String(e) };
    }
    if (o?.checkpoint !== false) this._commitOpen(o?.hint);
    return { ok: true, value };
  }

  undo(_w?: WorkpieceV1): boolean {
    this._commitOpen();                  // 顶端未封口 → 补封（旧栈 warning 语义）
    try { return this.stack.undo(); }
    catch (e) { this._unrecoverable(e); return false; }
  }
  redo(_w?: WorkpieceV1): boolean {
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

  private _req(): { wp2: WorkpieceV2; legacy: LegacyOpsComponent } {
    if (!this._wp2 || !this._legacy) throw new Error("LegacyHistory: 未 attach（组合根装配序 bug）");
    return { wp2: this._wp2, legacy: this._legacy };
  }

  private _commitOpen(hint?: (dir: "undo" | "redo") => void): void {
    if (!this._open) return;
    const t = this._open;
    this._open = null;
    t.commit(hint ? { hint } : undefined);
  }

  private _translateApplied(step: UndoStep, dir: "undo" | "redo"): void {
    if (!this._opts.onApplied) return;
    for (const e of step.entries) {
      if (this._legacy && e.c === this._legacy) {
        for (const m of this._legacy.microstepsOf(e.data)) {
          this._opts.onApplied({ kind: m.kind, dir, status: m.statusFor?.(dir) });
        }
      } else {
        this._opts.onApplied({ kind: e.c.kind, dir });
      }
    }
  }

  private _unrecoverable(e: unknown): void {
    if (this._open) { const t = this._open; this._open = null; try { t.abandon(); } catch { /* 已不可信 */ } }
    this.stack.clear();
    this._opts.onUnrecoverable(e);
  }
}
