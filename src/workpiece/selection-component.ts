// selection-component —— workpiece v2 的选区组件（ADR-0008 §3；T4a）。
// substrate = Selection | null（不持久化，跨 session 清——load 后 clearOnLoad）。
// 写纪律双轨（沿 T2 像素组件的分工形态）：
//   - 预览直写 = _rawWrite：lasso 引擎/预览 tx/浮层 lift 的 pre-applied 换手容身处，
//     不收集不记账（Selection 不可变对象、换手=纯引用交换，观察者无处挂——直写口是显式声明态）。
//   - 记账写 = set / commitPreApplied（token 写）：collector 首捕获令牌前原件，
//     同 token 的中间产物就地 dispose（Krita memento 语义，与 LayerTiles 首捕获赢同款）。
// record = { v: Selection | null }（另一侧的选区，所有权归 record）；swap 纯引用交换自反。
// 配额规则沿旧栈：selection tile 压缩前记 0（走共享 raw 池配额）、压缩后 compressedBytes/refCount。

import type { Selection } from "../selection.ts";
import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";

export function estimateSelectionBytes(sel: Selection | null | undefined): number {
  if (!sel || sel.disposed) return 0;
  let sum = 0;
  for (const h of sel.tileHandles()) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}

interface SelRecord { v: Selection | null }

export class SelectionComponent implements CollectorComponent {
  readonly kind = "selection";
  private _wp: Workpiece;
  private _cur: Selection | null = null;
  private _origin: SelRecord | null = null;   // collector：本 token 的令牌前原件（首捕获赢）

  constructor(wp: Workpiece) { this._wp = wp; }

  view(): Selection | null { return this._cur; }

  /** 预览直写（不记账不收集）。dispose 责任在调用方（沿旧 doc.selection setter 契约）。 */
  _rawWrite(v: Selection | null): void { this._cur = v; }

  /** 记账写：组件自己换手（调用方未 pre-applied 时用；替换值所有权交入 collector/即弃）。 */
  set(next: Selection | null): void {
    this._wp._componentWrite(this);
    const prev = this._cur;
    this._cur = next;
    if (!this._origin) { this._origin = { v: prev }; return; }
    if (prev && prev !== this._origin.v && prev !== next && !prev.disposed) prev.dispose();
  }

  /** 记账写（pre-applied）：调用方已把 after 直写上台，before 所有权交入。 */
  commitPreApplied(before: Selection | null): void {
    this._wp._componentWrite(this);
    if (!this._origin) { this._origin = { v: before }; return; }
    if (before && before !== this._origin.v && before !== this._cur && !before.disposed) before.dispose();
  }

  /** 换文档收尾（跨 session 不沿用选区；旧 adoptState 语义）。无 token——load 流，栈随后清。 */
  clearOnLoad(): void {
    if (this._cur && !this._cur.disposed) this._cur.dispose();
    this._cur = null;
  }

  // ── CollectorComponent ──

  sealRecord(): RecordData | null {
    const o = this._origin;
    this._origin = null;
    if (!o) return null;
    if (o.v === this._cur) return null;   // 净变化为零 → 不占 undo 步（同对象引用，无可释放）
    return o;
  }

  swapRecord(data: RecordData): RecordData {
    const r = data as SelRecord;
    const cur = this._cur;
    this._cur = r.v;
    return { v: cur };
  }

  recordBytes(data: RecordData): number { return 256 + estimateSelectionBytes((data as SelRecord).v); }

  disposeRecord(data: RecordData): void {
    const r = data as SelRecord;
    if (r.v && !r.v.disposed) r.v.dispose();
    r.v = null;
  }
}
