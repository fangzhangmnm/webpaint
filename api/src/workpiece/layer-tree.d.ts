import { type Layer, type PaintDoc } from "../doc.ts";
import type { Workpiece, OpStatus } from "./workpiece.ts";
import type { UndoHistory } from "./undo-history.ts";
import type { OperatorRegistry } from "./operators.ts";
export interface TreeStatuses {
    undoStatus?: string;
    redoStatus?: string;
}
export interface RunOpts {
    checkpoint?: boolean;
    label?: string;
}
export type AddLayerResult = {
    ok: true;
    layer: Layer;
} | {
    ok: false;
    msg?: string;
};
export declare class LayerTree {
    private _w;
    private _doc;
    private _history;
    private _ops;
    constructor(deps: {
        w: Workpiece;
        doc: PaintDoc;
        history: UndoHistory;
        ops: OperatorRegistry;
    });
    /** 新建空层（组内新建也精确复位；prevActiveId 自动拍：undo 摘层时回创建前的活动层）。
     *  创建即记账（AddLayerRecordOp 首跑只验证）；像素初始化可在返回后做——undo 摘层时才捕 spec，
     *  redo 经 insertLayerAt 连像素恢复（v0.7.35 合规形状，undo-stack-integrity 测试钉着）。
     *  失败：msg="maxLayers"（层数到顶）。 */
    addLayer(name?: string, o?: RunOpts): AddLayerResult;
    /** 复制叶层（插源层之上 + 设 active；像素句柄 copy-on-write 零拷贝）。msg="max"|"missing"。 */
    duplicateLayer(id: number, o?: RunOpts): AddLayerResult;
    private _recordAdd;
    /** 删除叶层（RemoveLayerRecordOp 自捕快照；默认 keep-one 守卫，msg="keep-one guard"）。 */
    removeLayer(id: number, layerName: string, o?: RunOpts & {
        allowEmpty?: boolean;
    }): OpStatus;
    /** 删组（连带 children；删到 0 叶自动补一张空层，不卡「非空组删不掉」）。 */
    deleteGroup(id: number, statuses: TreeStatuses, o?: RunOpts): OpStatus;
    /** 同级上移/下移（delta=+1 上 / -1 下；撤销 = 反向 delta）。 */
    moveLayer(id: number, delta: number, o?: RunOpts): OpStatus;
    /** 向下合并（合并数学在 doc.mergeDownLayer；msg = 其 reason：bottom/clipping-under/…）。 */
    mergeDown(id: number, o?: RunOpts): OpStatus;
    /** 层/组属性（rename/visible/opacity/mode/clippingMask/lockAlpha）。
     *  initialOld：pre-applied 场景（透明度 slider 拖动期已实时写值，提交只补账）。 */
    setLayerProp(id: number, prop: string, value: unknown, o?: RunOpts & {
        initialOld?: {
            v: unknown;
        } | null;
    }): OpStatus;
    /** 参考层指定（doc 级 unique；null = 取消）。 */
    setReferenceLayer(id: number | null, o?: RunOpts): OpStatus;
    /** 清空叶层像素（保留图层/名字/属性；事务型：先清、before 快照交 SwapPixelsOp）。 */
    clearLayer(id: number, o?: RunOpts): OpStatus;
    /** 焦点写（**显式声明的不入 undo 写**，v0.8 现状保持：点选活动层不占 undo 步；
     *  undo/redo 时的 active 还原由各 operator 自带）。返回是否切成。 */
    setActive(id: number): boolean;
    /** 结构变更 tx 窗口（编组/解组/移入移出/collapse/explode/stampAll…）：
     *  mutate 拿可变 doc；返回 null/false/undefined = 中止（不入栈——mutate 必须未动状态或已自行回滚）；
     *  其余返回值 = 成功，前后 snapshotTree 自动入栈。statuses 从 mutate 返回值算 undo/redo 文案。 */
    treeTx<T>(mutate: (doc: PaintDoc) => T | null | false | undefined, statuses?: (v: T) => TreeStatuses, o?: RunOpts): {
        ok: boolean;
        value?: T;
        msg?: string;
    };
}
