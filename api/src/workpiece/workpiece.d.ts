import type { PaintDoc } from "../doc.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
import type { LayerTree } from "./layer-tree.ts";
import type { SelectionFace } from "./selection-face.ts";
export interface FloatRect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export type FloatMesh = {
    x: number;
    y: number;
}[][];
export interface WorkpieceFloat {
    id: number;
    sourceLayerId: number;
    /** lift 时像素的 identity 位置（内容紧 bbox）；reject 按此写回，不走 warp 采样器。 */
    rect: FloatRect;
    /** doc 网格对齐的稀疏 tile（池驻留、可压缩；不可变——变换只动 transform metadata）。 */
    pixels: LayerPixels;
}
/** 参考 frame（v0.6.21 有向化，Procreate 方手柄语义）：p(u,v)=origin+u·ux+v·uy，u,v∈[0,1]。
 *  lift 时 = 可见源并集 AABB（ux/uy 轴对齐）；方手柄转轴后为一般平行四边形——只改参数化不动像素。 */
export interface FloatPt {
    x: number;
    y: number;
}
export interface FloatFrame {
    origin: FloatPt;
    ux: FloatPt;
    uy: FloatPt;
}
/** 像素变换用过的最高自由度类（模式切换记账制，v0.6.34）：拖动升级、只升不降、随 undo 整点回退。
 *  记的是**像素变换**的类而非 mesh 形状——basisRotate 转轴不动像素不升级（几何判定会误判它）。 */
export type TransformClass = "similarity" | "affine" | "projective";
/** 共享 gizmo 的变换元数据（组 lift 多 float 共用一份；per-float dest quad 由 rect×单应性派生）。 */
export interface FloatTransformMeta {
    gizmoFrame: FloatFrame;
    mesh: FloatMesh;
    meshN: number;
    mode: "free" | "uniform" | "distort" | null;
    uniformAspect: number;
    usedClass?: TransformClass;
}
export interface FloatState {
    floats: WorkpieceFloat[];
    transform: FloatTransformMeta;
}
export interface WorkpieceInternals {
    doc: PaintDoc;
    floats: FloatState | null;
}
export declare class Workpiece {
    /** 运行时数据是否偏离上次持久化（autosave/保存编排读写；operator 提交自动置 true）。 */
    isDirty: boolean;
    /** 构造期注入的 undo system（ADR-0007：capability 绑构造期；component 写 API 经它记账）。
     *  T2 起类型收成 HistoryFacade：真 UndoHistory（引擎测试）与 LegacyHistory 桥（app，骑 v2 栈）都满足。 */
    readonly history: HistoryFacade;
    private _commitVersion;
    private _lockHolder;
    private _layers;
    private _sel;
    constructor(doc: PaintDoc, history: HistoryFacade);
    /** 结构类写面（S1 第一个 component：层树增删/复制/移动/合并/属性/结构 tx）。
     *  写 doc 结构的唯一合法门——app 层不再直接 doc.addLayer + 手工记账。 */
    get layers(): LayerTree;
    /** LayerTree 构造时自注册（单次；组合根协作面，外部勿调）。
     *  值 import LayerTree 会成环（workpiece→layer-tree→operators→workpiece，operators 的
     *  extends 在模块 eval 期就要 DocumentOperator）→ 组件由组合根构造、注入到此。 */
    _attachLayers(c: LayerTree): void;
    /** 选区写面（S2 第二个 component：唯一记账口 + 预览 tx 窗口）。 */
    get sel(): SelectionFace;
    _attachSel(c: SelectionFace): void;
    /** 每次 operator 提交 +1。render-tree 重建 / 缓存失效的 key。 */
    get commitVersion(): number;
    /** 只读视图。⚠ 迁移期 escape hatch：老代码（board 渲染/导出/吸管）直读；新代码请依赖更窄的读口。 */
    readDoc(): Readonly<PaintDoc>;
    /** 浮层变换状态只读视图（board GPU warp 预览 / gizmo 引擎消费）。null = 无活动浮层。 */
    readFloatState(): Readonly<FloatState> | null;
    /** 换文档 escape hatch：直接清浮层状态并释放句柄（clearHistory/adoptState 同步调；
     *  正常编辑流走 DropFloatOp，别拿这个绕 undo）。 */
    dropFloats(): void;
    _acquireLock(holder: string): void;
    _releaseLock(holder: string): void;
    _isLocked(): boolean;
    _bumpCommit(): void;
}
export type OpStatus = {
    ok: true;
} | {
    ok: false;
    msg?: string;
};
/** undo 编排门面的公共面（T2 桥接期抽出）：真 UndoHistory 与 legacy-bridge 的 LegacyHistory 都结构满足。
 *  调用方（LayerTree/SelectionFace/doc-ops/fill/float/layers-panel/import-image）只准依赖这个形状。 */
export interface HistoryFacade {
    run<A, D>(w: Workpiece, op: DocumentOperator<A, D>, args: A, o?: {
        checkpoint?: boolean;
        label?: string;
    }): OpStatus;
    compound<T>(w: Workpiece, fn: () => T): {
        ok: boolean;
        value?: T;
        msg?: string;
    };
    sealCheckpoint(): void;
    undo(w: Workpiece): boolean;
    redo(w: Workpiece): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    readonly depth: number;
    quotaUsage(): number;
    clear(): void;
}
export interface OpResult<D> {
    ok: boolean;
    msg?: string;
    replaced?: D;
}
export declare abstract class DocumentOperator<A, D> {
    /** 标签（调试/状态栏/统计 key）。 */
    abstract readonly kind: string;
    /** 拿内部可变数据。仅在持锁的 forward/backward 里合法（其余时机 throw）。 */
    protected mut(w: Workpiece): WorkpieceInternals;
    /** 必须同步（硬规则）。见 OpResult 契约。 */
    abstract forward(w: Workpiece, args: A, data: D | undefined): OpResult<D>;
    abstract backward(w: Workpiece, args: A, data: D): OpResult<D>;
    /** 该步 undo 包的内存估计（undo-history 配额驱逐用）。tile 句柄：压缩前记 0（走共享 raw
     *  池配额）、压缩后记 compressedBytes/refCount——每次 push 全量重扫，压缩会让 usage 变。 */
    estimateQuotaBytes(_args: A, _data: D | undefined): number;
    /** 驱逐/清栈/截断 redo 时释放 data 持有的资源（tile 句柄 release 等）。 */
    disposeData(_args: A, _data: D | undefined): void;
    /** UI 提示（可选）：undo/redo 后的状态栏 toast 文案。UI 编排在 app 侧消费，workpiece 不碰 DOM。 */
    statusFor?(dir: "do" | "undo" | "redo", args: A): string | undefined;
}
