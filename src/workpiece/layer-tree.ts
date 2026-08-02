// layer-tree —— workpiece 的结构类写面 component（v0.8.1 · S1 写面收权，ADR-0007）。
//
// 「写即记账」契约：每个公共方法 = mutate + 自动 history.run(对应 operator)，一体不可拆——
// 调用点只表达意图（新建层/删组/复制/合并/属性），locateNode/prevActiveId 的 args 组装舞蹈
// 全部下沉到这里。记账失败绝不留下无账 mutation（addLayer 记账失败会把刚建的层摘回去）。
//
// treeTx 是结构变更的 tx 窗口：mutate 回调拿到可变 PaintDoc（受控 escape），前后自动拍
// snapshotTree、成功即入栈（TreeStructureOp 事务型，restoreTree(after) 首跑幂等）。
// DocView（S3）收口后，app 层结构写只剩本组件这一条门。
//
// 本组件不碰 DOM/i18n/store：undo/redo 状态栏文案由调用方传入（TreeStatuses）。
// 微步/整点：所有方法透传 { checkpoint }（v0.7.41 import 单整点、stampAll compound 依赖它）。

import { countLeaves, type Layer, type PaintDoc } from "../doc.ts";
import { docWriteWindow } from "./write-gate.ts";
import type { Workpiece, OpStatus } from "./workpiece.ts";
import type { UndoHistory } from "./undo-history.ts";
import type { OperatorRegistry } from "./operators.ts";

export interface TreeStatuses { undoStatus?: string; redoStatus?: string }
export interface RunOpts { checkpoint?: boolean; label?: string }
export type AddLayerResult = { ok: true; layer: Layer } | { ok: false; msg?: string };

export class LayerTree {
  private _w: Workpiece;
  private _doc: PaintDoc;
  private _history: UndoHistory;
  private _ops: OperatorRegistry;

  constructor(deps: { w: Workpiece; doc: PaintDoc; history: UndoHistory; ops: OperatorRegistry }) {
    this._w = deps.w;
    this._doc = deps.doc;
    this._history = deps.history;
    this._ops = deps.ops;
    deps.w._attachLayers(this);
  }

  /** 新建空层（组内新建也精确复位；prevActiveId 自动拍：undo 摘层时回创建前的活动层）。
   *  创建即记账（AddLayerRecordOp 首跑只验证）；像素初始化可在返回后做——undo 摘层时才捕 spec，
   *  redo 经 insertLayerAt 连像素恢复（v0.7.35 合规形状，undo-stack-integrity 测试钉着）。
   *  失败：msg="maxLayers"（层数到顶）。 */
  addLayer(name?: string, o?: RunOpts): AddLayerResult {
    const doc = this._doc;
    const prevActiveId = doc.activeLayer?.id ?? null;
    const L = docWriteWindow(() => doc.addLayer(name));   // S4：component 创建段 = 声明窗口
    if (!L) return { ok: false, msg: "maxLayers" };
    return this._recordAdd(L, prevActiveId, o);
  }

  /** 复制叶层（插源层之上 + 设 active；像素句柄 copy-on-write 零拷贝）。msg="max"|"missing"。 */
  duplicateLayer(id: number, o?: RunOpts): AddLayerResult {
    const doc = this._doc;
    const prevActiveId = doc.activeLayer?.id ?? null;
    const r = docWriteWindow(() => doc.duplicateLayer(id));
    if (!r.ok) return { ok: false, msg: r.reason };
    return this._recordAdd(r.newLayer!, prevActiveId, o, r.loc!);
  }

  private _recordAdd(L: Layer, prevActiveId: number | null, o?: RunOpts,
    loc?: { parentId: number | null; index: number }): AddLayerResult {
    const at = loc ?? this._doc.locateNode(L.id)!;
    const st = this._history.run(this._w, this._ops.addLayer,
      { layerId: L.id, index: at.index, parentId: at.parentId, prevActiveId, layerName: L.name }, o);
    if (!st.ok) {
      // 记账失败绝不留无账层（那正是 v0.7.35 的越狱病理）：摘回 + 释放像素句柄。
      docWriteWindow(() => this._doc.removeLayer(L.id, true));
      L.pixels.dispose();
      return { ok: false, msg: st.msg };
    }
    return { ok: true, layer: L };
  }

  /** 删除叶层（RemoveLayerRecordOp 自捕快照；默认 keep-one 守卫，msg="keep-one guard"）。 */
  removeLayer(id: number, layerName: string, o?: RunOpts & { allowEmpty?: boolean }): OpStatus {
    return this._history.run(this._w, this._ops.removeLayer,
      { layerId: id, layerName, allowEmpty: o?.allowEmpty }, o);
  }

  /** 删组（连带 children；删到 0 叶自动补一张空层，不卡「非空组删不掉」）。 */
  deleteGroup(id: number, statuses: TreeStatuses, o?: RunOpts): OpStatus {
    const r = this.treeTx((doc) => {
      if (!doc.removeLayer(id, true)) return null;
      if (countLeaves(doc.layers) === 0) doc.addLayer();
      return true;
    }, () => statuses, o);
    return r.ok ? { ok: true } : { ok: false, msg: r.msg };
  }

  /** 同级上移/下移（delta=+1 上 / -1 下；撤销 = 反向 delta）。 */
  moveLayer(id: number, delta: number, o?: RunOpts): OpStatus {
    return this._history.run(this._w, this._ops.moveLayer, { layerId: id, delta }, o);
  }

  /** 向下合并（合并数学在 doc.mergeDownLayer；msg = 其 reason：bottom/clipping-under/…）。 */
  mergeDown(id: number, o?: RunOpts): OpStatus {
    return this._history.run(this._w, this._ops.mergeDown, { layerId: id }, o);
  }

  /** 层/组属性（rename/visible/opacity/mode/clippingMask/lockAlpha）。
   *  initialOld：pre-applied 场景（透明度 slider 拖动期已实时写值，提交只补账）。 */
  setLayerProp(id: number, prop: string, value: unknown,
    o?: RunOpts & { initialOld?: { v: unknown } | null }): OpStatus {
    return this._history.run(this._w, this._ops.layerProp,
      { layerId: id, prop, value, _initialOld: o?.initialOld ?? null }, o);
  }

  /** 参考层指定（doc 级 unique；null = 取消）。 */
  setReferenceLayer(id: number | null, o?: RunOpts): OpStatus {
    return this._history.run(this._w, this._ops.referenceLayer, { value: id }, o);
  }

  /** 清空叶层像素（保留图层/名字/属性；事务型：先清、before 快照交 SwapPixelsOp）。 */
  clearLayer(id: number, o?: RunOpts): OpStatus {
    const n = this._doc.findLayer(id);
    if (!n || n.isGroup) return { ok: false, msg: "layer gone" };
    const L = n as Layer;
    const before = L.snapshot();
    L.clearAll();
    return this._history.run(this._w, this._ops.pixels, { layerId: id, _initialBefore: before }, o);
  }

  /** 焦点写（**显式声明的不入 undo 写**，v0.8 现状保持：点选活动层不占 undo 步；
   *  undo/redo 时的 active 还原由各 operator 自带）。返回是否切成。 */
  setActive(id: number): boolean {
    return docWriteWindow(() => this._doc.setActiveById(id));
  }

  /** 结构变更 tx 窗口（编组/解组/移入移出/collapse/explode/stampAll…）：
   *  mutate 拿可变 doc；返回 null/false/undefined = 中止（不入栈——mutate 必须未动状态或已自行回滚）；
   *  其余返回值 = 成功，前后 snapshotTree 自动入栈。statuses 从 mutate 返回值算 undo/redo 文案。 */
  treeTx<T>(mutate: (doc: PaintDoc) => T | null | false | undefined,
    statuses?: (v: T) => TreeStatuses, o?: RunOpts): { ok: boolean; value?: T; msg?: string } {
    const doc = this._doc;
    const before = doc.snapshotTree();
    const v = docWriteWindow(() => mutate(doc));   // S4：treeTx mutate 段 = 声明窗口
    if (v === null || v === false || v === undefined) return { ok: false, msg: "aborted" };
    const s = statuses?.(v) ?? {};
    const st = this._history.run(this._w, this._ops.treeStructure,
      { before, after: doc.snapshotTree(), undoStatus: s.undoStatus, redoStatus: s.redoStatus }, o);
    if (!st.ok) return { ok: false, msg: st.msg };
    return { ok: true, value: v };
  }
}
