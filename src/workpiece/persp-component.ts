// persp-component —— workpiece v2 的透视配置组件（ADR-0008 §3 升格；T4d）。
// substrate = desk 的 persp 配置（editorState.persp——持久化仍进 desk 文件：**存哪个文件与
// undo 归属正交**，ADR-0008）；组件经注入 host 读写，零 desk 内部知识。
//
// 记账范围（刻意收窄）：**只有 remapForDocTransform**（裁剪/翻转/旋转/偏移/重采样的 VP 重映射，
// ADR-0006）走 token 记账——doc 几何 undo 时透视随同 step 还原（旧 docTransform persp 信封退役）。
// VP 编辑器（persp-edit）仍是 desk 直写不进栈：user 拍板「VP setting 是 editor state 不进
// undo history」（persp-edit.ts _finish 注）在案，ADR-0008 升格解决的是「undo 不同步还原 =
// 透视静默错位」，不改这条。将来要让 VP 编辑可撤，走 set()（已留口，token 写）。
//
// record = { v: 整包深拷贝快照 }；swap = 快照互换自反。undo docTransform 会把 remap 之后的
// desk 直写一并盖回（与旧信封 wholesale restore 行为一致）。

import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece.ts";

export interface PerspPt { x: number; y: number }
export interface PerspHost {
  /** 深拷贝 JSON 快照（workbench-state.snapshotShapePersp）。 */
  snapshot(): unknown;
  /** 整包还原（workbench-state.restoreShapePersp）。 */
  restore(snap: unknown): void;
  /** VP/box 坐标重映射（workbench-state.remapShapePersp）。 */
  remap(f: (p: PerspPt) => PerspPt, opts?: { unlockHorizon?: boolean }): void;
}

interface PerspRecord { v: unknown }

export class PerspComponent implements CollectorComponent {
  readonly kind = "persp";
  private _wp: Workpiece;
  private _host: PerspHost;
  private _origin: PerspRecord | null = null;   // collector：本 token 的令牌前快照（首捕获赢）

  constructor(wp: Workpiece, host: PerspHost) {
    this._wp = wp;
    this._host = host;
  }

  view(): unknown { return this._host.snapshot(); }

  /** doc 几何变换的 VP 重映射（token 写；doc-ops runDocTransform 的 compound 内调）。 */
  remapForDocTransform(f: (p: PerspPt) => PerspPt, opts?: { unlockHorizon?: boolean }): void {
    this._wp._componentWrite(this);
    if (!this._origin) this._origin = { v: this._host.snapshot() };
    this._host.remap(f, opts);
  }

  /** 整包换配置（token 写；VP 编辑可撤化的预留口——现无调用方，persp-edit 仍 desk 直写）。 */
  set(cfg: unknown): void {
    this._wp._componentWrite(this);
    if (!this._origin) this._origin = { v: this._host.snapshot() };
    this._host.restore(cfg);
  }

  // ── CollectorComponent ──

  sealRecord(): RecordData | null {
    const o = this._origin;
    this._origin = null;
    if (!o) return null;
    // 净变化为零（无 VP 时 remap 是 no-op）→ 不占 entry（JSON 比对，包 KB 级低频）
    if (JSON.stringify(o.v) === JSON.stringify(this._host.snapshot())) return null;
    return o;
  }

  swapRecord(data: RecordData): RecordData {
    const r = data as PerspRecord;
    const cur = this._host.snapshot();
    this._host.restore(r.v);
    return { v: cur };
  }

  recordBytes(data: RecordData): number {
    return 128 + JSON.stringify((data as PerspRecord).v ?? null).length * 2;
  }

  disposeRecord(): void { /* 纯 json，无资源 */ }
}
