// operators —— 12 族文档操作的 DocumentOperator 实现（0.4 纪元，替代 layer-undo/pixel-edit/input 的
// 注册 handler）。全部**同步**（硬规则）：像素/spec/深快照的底座已换 tile 句柄（doc.ts LayerSnap），
// createImageBitmap/PNG-blob 解码舞蹈全数退场。
//
// 两种执行形态：
//   ① 事务型（pre-applied）：引擎先改（描边/选区/整 doc 变换），run 时带 _initialBefore/_initialOld
//      —— 首跑 forward 不再应用，只交出 undo 包。之后 undo/redo 按对称 swap 往复。
//   ② 操作型：forward 自己动手（层增删/移动/合并/属性）——调用方**不得**预先 mutate。
// 复合动作（lasso commit / 选区转图层 / 删组）用 UndoHistory.compound 把多个微步封一个整点。
//
// 句柄纪律：args/data 里出现的 LayerSnap/LayerSpecShape 一律归本 operator 所有——消费（restore）
// 后立即 dispose，驱逐/截断经 disposeData 释放。漏网由池 FR assert 点名。

import { DocumentOperator, Workpiece, type OpResult } from "./workpiece.ts";
import {
  findNodeById, disposeLayerSnap, disposeLayerSpec, disposeDeepSnapNodes,
  Layer, type LayerSpecShape, type LayerSnap, type PaintDoc, type DeepSnapNode,
} from "../doc.ts";
import { LiftFloatOp, FloatTransformOp, DropFloatOp } from "./float-ops.ts";
import type { Selection } from "../selection.ts";
import { t } from "../i18n/index.ts";

// tile 句柄快照的配额估计：压缩前记 0（走共享 raw 池配额），压缩后 = compressedBytes/refCount。
function estimateSnapBytes(snap: LayerSnap | null | undefined): number {
  if (!snap) return 0;
  let sum = 0;
  for (const [, h] of snap.pixels.tiles) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}
function estimateDeepBytes(nodes: DeepSnapNode[]): number {
  let sum = 0;
  for (const n of nodes) sum += n.isGroup ? estimateDeepBytes(n.children || []) : estimateSnapBytes(n.snap);
  return sum;
}

function leafById(doc: PaintDoc, id: number): Layer | null {
  const n = findNodeById(doc.layers, id);
  return n && !n.isGroup ? (n as Layer) : null;
}

// ---- ① 像素 swap（stroke / liquify / filter / 填充 / 清除 / lasso 单层）----
export interface SwapPixelsArgs { layerId: number; _initialBefore?: LayerSnap | null }
export class SwapPixelsOp extends DocumentOperator<SwapPixelsArgs, LayerSnap> {
  readonly kind = "pixels";
  forward(w: Workpiece, args: SwapPixelsArgs, data: LayerSnap | undefined): OpResult<LayerSnap> {
    const doc = this.mut(w).doc;
    const L = leafById(doc, args.layerId);
    if (!L) { this.disposeData(args, data); return { ok: false, msg: "layer gone" }; }
    if (data === undefined) {                      // 首跑：引擎已应用 after，交出 before
      const before = args._initialBefore;
      args._initialBefore = null;
      if (!before) return { ok: false, msg: "missing _initialBefore" };
      return { ok: true, replaced: before };
    }
    return { ok: true, replaced: this._install(L, data) };
  }
  backward(w: Workpiece, args: SwapPixelsArgs, data: LayerSnap): OpResult<LayerSnap> {
    const doc = this.mut(w).doc;
    const L = leafById(doc, args.layerId);
    if (!L) return { ok: false, msg: "layer gone" };
    return { ok: true, replaced: this._install(L, data) };
  }
  private _install(L: Layer, snap: LayerSnap): LayerSnap {
    const cur = L.snapshot();
    L.restoreFromSnapshot(snap);
    disposeLayerSnap(snap);                        // 已消费（restore 装的是 acquire 副本）
    return cur;
  }
  override estimateQuotaBytes(args: SwapPixelsArgs, data: LayerSnap | undefined): number {
    return 512 + estimateSnapBytes(data) + estimateSnapBytes(args._initialBefore);
  }
  override disposeData(args: SwapPixelsArgs, data: LayerSnap | undefined): void {
    if (args._initialBefore) { disposeLayerSnap(args._initialBefore); args._initialBefore = null; }
    disposeLayerSnap(data);
  }
}

// ---- ① 选区 swap（selectionChange：圈选/清选/反选/全选）。Selection 不可变 → 纯引用交换 ----
// v0.4.6：Selection 底座换 gray8 tile 句柄 → 配额与 LayerSnap 同规（压缩前 0、压缩后按压缩字节/refCount），
// 驱逐/截断经 disposeData 释放句柄（Selection.dispose）。
function estimateSelectionBytes(sel: Selection | null | undefined): number {
  if (!sel || sel.disposed) return 0;
  let sum = 0;
  for (const h of sel.tileHandles()) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}
export interface SwapSelectionArgs { _initialBefore?: { v: Selection | null } | null }
type SelBox = { v: Selection | null };
export class SwapSelectionOp extends DocumentOperator<SwapSelectionArgs, SelBox> {
  readonly kind = "selection";
  forward(w: Workpiece, args: SwapSelectionArgs, data: SelBox | undefined): OpResult<SelBox> {
    const doc = this.mut(w).doc;
    if (data === undefined) {
      const before = args._initialBefore;
      args._initialBefore = null;
      if (!before) return { ok: false, msg: "missing _initialBefore" };
      return { ok: true, replaced: before };
    }
    const cur = { v: doc.selection };
    doc.selection = data.v;
    return { ok: true, replaced: cur };
  }
  backward(w: Workpiece, _args: SwapSelectionArgs, data: SelBox): OpResult<SelBox> {
    const doc = this.mut(w).doc;
    const cur = { v: doc.selection };
    doc.selection = data.v;
    return { ok: true, replaced: cur };
  }
  override estimateQuotaBytes(args: SwapSelectionArgs, data: SelBox | undefined): number {
    return 512 + estimateSelectionBytes(data?.v) + estimateSelectionBytes(args._initialBefore?.v);
  }
  override disposeData(args: SwapSelectionArgs, data: SelBox | undefined): void {
    if (args._initialBefore) {
      if (args._initialBefore.v && !args._initialBefore.v.disposed) args._initialBefore.v.dispose();
      args._initialBefore = null;
    }
    if (data?.v && !data.v.disposed) data.v.dispose();
  }
}

// ---- ② 层属性 swap（rename/visible/opacity/mode/clippingMask/lockAlpha；组节点也适用）----
// 事务型调用（已 pre-apply）传 _initialOld；操作型调用（未 apply）不传，forward 自己读旧值再写。
export interface LayerPropArgs { layerId: number; prop: string; value: unknown; _initialOld?: { v: unknown } | null }
export class LayerPropOp extends DocumentOperator<LayerPropArgs, { v: unknown }> {
  readonly kind = "layerProp";
  forward(w: Workpiece, args: LayerPropArgs, data: { v: unknown } | undefined): OpResult<{ v: unknown }> {
    const doc = this.mut(w).doc;
    const n = findNodeById(doc.layers, args.layerId) as unknown as Record<string, unknown> | null;
    if (!n) return { ok: false, msg: "node gone" };
    if (data === undefined && args._initialOld) {   // 事务型首跑
      const old = args._initialOld;
      args._initialOld = null;
      n[args.prop] = args.value;                    // 幂等重写（通常已是该值）
      return { ok: true, replaced: old };
    }
    const old = { v: n[args.prop] };
    n[args.prop] = data === undefined ? args.value : data.v;
    return { ok: true, replaced: old };
  }
  backward(w: Workpiece, args: LayerPropArgs, data: { v: unknown }): OpResult<{ v: unknown }> {
    const doc = this.mut(w).doc;
    const n = findNodeById(doc.layers, args.layerId) as unknown as Record<string, unknown> | null;
    if (!n) return { ok: false, msg: "node gone" };
    const old = { v: n[args.prop] };
    n[args.prop] = data.v;
    return { ok: true, replaced: old };
  }
}

// ---- ② 参考层指定（doc 级 unique 状态）----
export class ReferenceLayerOp extends DocumentOperator<{ value: number | null }, { v: number | null }> {
  readonly kind = "referenceLayer";
  forward(w: Workpiece, args: { value: number | null }, data: { v: number | null } | undefined): OpResult<{ v: number | null }> {
    const doc = this.mut(w).doc;
    const old = { v: doc.referenceLayerId };
    doc.referenceLayerId = data === undefined ? args.value : data.v;
    return { ok: true, replaced: old };
  }
  backward(w: Workpiece, _args: { value: number | null }, data: { v: number | null }): OpResult<{ v: number | null }> {
    const doc = this.mut(w).doc;
    const old = { v: doc.referenceLayerId };
    doc.referenceLayerId = data.v;
    return { ok: true, replaced: old };
  }
}

// ---- ② 记录一次「新层已创建」（addLayer/duplicate/导入为图层；层由调用方经 doc API 创建）----
// data 循环：null（层在树上）↔ spec（层被 undo 摘下时捕获）。
export interface AddLayerArgs { layerId: number; index: number; parentId: number | null; prevActiveId: number | null; layerName: string }
export class AddLayerRecordOp extends DocumentOperator<AddLayerArgs, LayerSpecShape | null> {
  readonly kind = "addLayer";
  forward(w: Workpiece, args: AddLayerArgs, data: LayerSpecShape | null | undefined): OpResult<LayerSpecShape | null> {
    const doc = this.mut(w).doc;
    if (data === undefined) {                       // 首跑：层已由调用方创建
      if (!findNodeById(doc.layers, args.layerId)) return { ok: false, msg: "layer not created" };
      return { ok: true, replaced: null };
    }
    if (!data) return { ok: false, msg: "redo without spec" };
    if (!doc.insertLayerAt(args.index, data, args.parentId)) return { ok: false, msg: "insert failed" };
    disposeLayerSpec(data);                         // 已消费
    doc.setActiveById(args.layerId);
    return { ok: true, replaced: null };
  }
  backward(w: Workpiece, args: AddLayerArgs, _data: LayerSpecShape | null): OpResult<LayerSpecShape | null> {
    const doc = this.mut(w).doc;
    const L = leafById(doc, args.layerId);
    if (!L) return { ok: false, msg: "layer gone" };
    const spec = doc.layerSpec(L);
    doc.removeLayer(args.layerId, true);
    L.pixels.dispose();                             // spec 已持句柄副本
    if (args.prevActiveId != null) doc.setActiveById(args.prevActiveId);
    return { ok: true, replaced: spec };
  }
  override estimateQuotaBytes(_a: AddLayerArgs, data: LayerSpecShape | null | undefined): number {
    return 512 + estimateSnapBytes(data?.snap);
  }
  override disposeData(_a: AddLayerArgs, data: LayerSpecShape | null | undefined): void { disposeLayerSpec(data ?? null); }
  override statusFor(dir: "do" | "undo" | "redo", args: AddLayerArgs): string | undefined {
    if (dir === "undo") return t("se.undoCreateLayer", { name: args.layerName });
    if (dir === "redo") return t("se.restoredLayer", { name: args.layerName });
    return undefined;
  }
}

// ---- ② 删除叶层（操作型：forward 自己捕快照+删；组删除走 TreeStructureOp）----
interface RemovedRecord { spec: LayerSpecShape; index: number; parentId: number | null; prevActiveId: number | null }
export class RemoveLayerRecordOp extends DocumentOperator<{ layerId: number; layerName: string; allowEmpty?: boolean }, RemovedRecord | undefined> {
  readonly kind = "removeLayer";
  forward(w: Workpiece, args: { layerId: number; layerName: string; allowEmpty?: boolean }, _data: RemovedRecord | undefined): OpResult<RemovedRecord | undefined> {
    const doc = this.mut(w).doc;
    const L = leafById(doc, args.layerId);
    const loc = doc.locateNode(args.layerId);
    if (!L || !loc) return { ok: false, msg: "layer gone" };
    const prevActiveId = doc.activeId;
    const spec = doc.layerSpec(L);
    if (!doc.removeLayer(args.layerId, args.allowEmpty ?? false)) {
      disposeLayerSpec(spec);
      return { ok: false, msg: "keep-one guard" };
    }
    L.pixels.dispose();                             // spec 已持句柄副本，本体退场
    return { ok: true, replaced: { spec, index: loc.index, parentId: loc.parentId, prevActiveId } };
  }
  backward(w: Workpiece, args: { layerId: number; layerName: string }, data: RemovedRecord): OpResult<RemovedRecord | undefined> {
    const doc = this.mut(w).doc;
    if (!doc.insertLayerAt(data.index, data.spec, data.parentId)) return { ok: false, msg: "insert failed" };
    disposeLayerSpec(data.spec);
    doc.setActiveById(args.layerId);                // v125：恢复的层设为 active + toast
    return { ok: true, replaced: undefined };
  }
  override estimateQuotaBytes(_a: { layerId: number; layerName: string }, data: RemovedRecord | undefined): number {
    return 512 + estimateSnapBytes(data?.spec.snap);
  }
  override disposeData(_a: { layerId: number; layerName: string }, data: RemovedRecord | undefined): void {
    if (data) disposeLayerSpec(data.spec);
  }
  override statusFor(dir: "do" | "undo" | "redo", args: { layerId: number; layerName: string }): string | undefined {
    if (dir === "undo") return t("se.restoredLayer", { name: args.layerName });
    if (dir === "redo") return t("se.deletedLayer", { name: args.layerName });
    return undefined;
  }
}

// ---- ② 同级移动 ----
export class MoveLayerOp extends DocumentOperator<{ layerId: number; delta: number }, undefined> {
  readonly kind = "moveLayer";
  forward(w: Workpiece, args: { layerId: number; delta: number }, _d: undefined): OpResult<undefined> {
    const doc = this.mut(w).doc;
    return doc.moveLayer(args.layerId, args.delta) ? { ok: true } : { ok: false, msg: "cannot move" };
  }
  backward(w: Workpiece, args: { layerId: number; delta: number }, _d: undefined): OpResult<undefined> {
    const doc = this.mut(w).doc;
    return doc.moveLayer(args.layerId, -args.delta) ? { ok: true } : { ok: false, msg: "cannot move back" };
  }
}

// ---- ① 树结构 swap（编组/解组/移入移出/删组；snapshotTree 保叶活引用，零像素拷贝）----
// 事务型：调用方 snapshotTree → mutate → snapshotTree → run（首跑 restoreTree(after) 幂等）。
// ⚠ 已知取舍：删组后该 entry 被驱逐/截断时，游离叶的句柄不 dispose（多 entry 可能共享同批活引用，
//   贸然释放会把别的 entry 的 undo 恢复成空层）。泄漏 bounded（换文档时 clearHistory+adoptState 清），
//   池 FR assert 可见。层级组件真正收进 workpiece internals（后续切片）时给出所有权解。
type TreeSnap = ReturnType<PaintDoc["snapshotTree"]>;
export interface TreeStructureArgs { before: TreeSnap; after: TreeSnap; undoStatus?: string; redoStatus?: string }
export class TreeStructureOp extends DocumentOperator<TreeStructureArgs, undefined> {
  readonly kind = "treeStructure";
  forward(w: Workpiece, args: TreeStructureArgs, _d: undefined): OpResult<undefined> {
    this.mut(w).doc.restoreTree(args.after);
    return { ok: true };
  }
  backward(w: Workpiece, args: TreeStructureArgs, _d: undefined): OpResult<undefined> {
    this.mut(w).doc.restoreTree(args.before);
    return { ok: true };
  }
  override statusFor(dir: "do" | "undo" | "redo", args: TreeStructureArgs): string | undefined {
    if (dir === "undo") return args.undoStatus;
    if (dir === "redo") return args.redoStatus;
    return undefined;
  }
}

// ---- ② 向下合并（forward 自己动手：捕 under 前态 + 调 doc.mergeDownLayer）----
type MergeRecord = {
  underId: number;
  underBefore: LayerSnap; underBeforeOpacity: number; underBeforeMode: string; underBeforeClipping: boolean;
  activeSpec: LayerSpecShape; activeLoc: { parentId: number | null; index: number };
};
export class MergeDownOp extends DocumentOperator<{ layerId: number }, MergeRecord | undefined> {
  readonly kind = "mergeDown";
  forward(w: Workpiece, args: { layerId: number }, data: MergeRecord | undefined): OpResult<MergeRecord | undefined> {
    const doc = this.mut(w).doc;
    if (data) this.disposeData(args, data);        // redo：旧记录作废，重合并重捕
    const L = leafById(doc, args.layerId);
    if (!L) return { ok: false, msg: "layer gone" };
    const r = doc.mergeDownLayer(L) as { ok: boolean; reason?: string } & Partial<MergeRecord> & { underAfter?: LayerSnap };
    if (!r.ok) return { ok: false, msg: r.reason };
    disposeLayerSnap(r.underAfter);                // redo 重算，不留 after 快照
    return {
      ok: true,
      replaced: {
        underId: r.underId!, underBefore: r.underBefore!, underBeforeOpacity: r.underBeforeOpacity!,
        underBeforeMode: r.underBeforeMode!, underBeforeClipping: !!r.underBeforeClipping,
        activeSpec: r.activeSpec!, activeLoc: r.activeLoc!,
      },
    };
  }
  backward(w: Workpiece, args: { layerId: number }, data: MergeRecord): OpResult<MergeRecord | undefined> {
    const doc = this.mut(w).doc;
    const under = leafById(doc, data.underId);
    if (!under) return { ok: false, msg: "under gone" };
    under.restoreFromSnapshot(data.underBefore);
    under.opacity = data.underBeforeOpacity;
    under.mode = data.underBeforeMode;
    under.clippingMask = data.underBeforeClipping;
    if (!doc.insertLayerAt(data.activeLoc.index, data.activeSpec, data.activeLoc.parentId)) return { ok: false, msg: "insert failed" };
    doc.setActiveById(args.layerId);
    this.disposeData(args, data);                  // 快照已消费
    return { ok: true, replaced: undefined };
  }
  override estimateQuotaBytes(_a: { layerId: number }, data: MergeRecord | undefined): number {
    return data ? 512 + estimateSnapBytes(data.underBefore) + estimateSnapBytes(data.activeSpec.snap) : 512;
  }
  override disposeData(_a: { layerId: number }, data: MergeRecord | undefined): void {
    if (!data) return;
    disposeLayerSnap(data.underBefore);
    disposeLayerSpec(data.activeSpec);
  }
  override statusFor(dir: "do" | "undo" | "redo", _args: { layerId: number }): string | undefined {
    return dir === "redo" ? t("se.mergedDown") : undefined;
  }
}

// ---- ① 整 doc 变换（crop/resample/flip/rotate/offset；事务型：调用方前后各拍 snapshotAll）----
type DocSnapAll = ReturnType<PaintDoc["snapshotAll"]>;
export interface DocTransformArgs {
  // persp = 形状笔透视配置快照（ADR-0006：VP 是 doc 坐标的 desk 态，裁剪/旋转随 doc 几何重映射，
  //   undo/redo 必须一起还原否则透视静默错位）。对 operator 不透明，还原经注入回调。
  before: { doc: DocSnapAll; viewport?: Record<string, number> | null; persp?: unknown };
  after: { doc: DocSnapAll; viewport?: Record<string, number> | null; persp?: unknown };
}
export class DocTransformOp extends DocumentOperator<DocTransformArgs, boolean> {
  readonly kind = "docTransform";
  // viewport/尺寸标签/透视配置是 board/UI/desk 的事，注入回调（workpiece 不碰 DOM）。
  private _applyUi: (viewport: Record<string, number> | null | undefined, persp?: unknown) => void;
  constructor(applyUi: (viewport: Record<string, number> | null | undefined, persp?: unknown) => void) { super(); this._applyUi = applyUi; }
  forward(w: Workpiece, args: DocTransformArgs, data: boolean | undefined): OpResult<boolean> {
    if (data !== undefined) {                       // redo（首跑 pre-applied）
      this.mut(w).doc.restoreSnapshotAll(args.after.doc);
      this._applyUi(args.after.viewport, args.after.persp);
    }
    return { ok: true, replaced: true };
  }
  backward(w: Workpiece, args: DocTransformArgs, _data: boolean): OpResult<boolean> {
    this.mut(w).doc.restoreSnapshotAll(args.before.doc);
    this._applyUi(args.before.viewport, args.before.persp);
    return { ok: true, replaced: true };
  }
  override estimateQuotaBytes(args: DocTransformArgs): number {
    return 1024 + estimateDeepBytes(args.before.doc.layers) + estimateDeepBytes(args.after.doc.layers)
      + estimateSelectionBytes(args.before.doc.selection) + estimateSelectionBytes(args.after.doc.selection);
  }
  override disposeData(args: DocTransformArgs): void {
    disposeDeepSnapNodes(args.before.doc.layers);
    disposeDeepSnapNodes(args.after.doc.layers);
    // v0.4.6：快照持有的 selection clone（tile 句柄）一并释放。
    if (args.before.doc.selection && !args.before.doc.selection.disposed) args.before.doc.selection.dispose();
    if (args.after.doc.selection && !args.after.doc.selection.disposed) args.after.doc.selection.dispose();
  }
}

// ---- 注册表（app.ts 组装进 ctx；有注入需求的在 app 侧 new）----
export interface OperatorRegistry {
  pixels: SwapPixelsOp;
  selection: SwapSelectionOp;
  layerProp: LayerPropOp;
  referenceLayer: ReferenceLayerOp;
  addLayer: AddLayerRecordOp;
  removeLayer: RemoveLayerRecordOp;
  moveLayer: MoveLayerOp;
  treeStructure: TreeStructureOp;
  mergeDown: MergeDownOp;
  docTransform: DocTransformOp;
  liftFloat: LiftFloatOp;
  floatTransform: FloatTransformOp;
  dropFloat: DropFloatOp;
}
export function makeOperators(deps: { applyDocTransformUi: (viewport: Record<string, number> | null | undefined, persp?: unknown) => void }): OperatorRegistry {
  return {
    pixels: new SwapPixelsOp(),
    selection: new SwapSelectionOp(),
    layerProp: new LayerPropOp(),
    referenceLayer: new ReferenceLayerOp(),
    addLayer: new AddLayerRecordOp(),
    removeLayer: new RemoveLayerRecordOp(),
    moveLayer: new MoveLayerOp(),
    treeStructure: new TreeStructureOp(),
    mergeDown: new MergeDownOp(),
    docTransform: new DocTransformOp(deps.applyDocTransformUi),
    liftFloat: new LiftFloatOp(),
    floatTransform: new FloatTransformOp(),
    dropFloat: new DropFloatOp(),
  };
}
