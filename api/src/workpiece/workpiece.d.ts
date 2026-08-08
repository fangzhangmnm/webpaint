import type { PaintingView } from "./painting-view.ts";
import type { LayerTree } from "./layer-tree.ts";
import type { SelectionFace } from "./selection-face.ts";
export interface WorkpieceInternals {
    doc: PaintingView;
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
    constructor(doc: PaintingView, history: HistoryFacade);
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
    /** 端口读口（构造期未持 port 的引擎用；T5 随本类拆）。 */
    readView(): PaintingView;
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
    compound<T>(w: Workpiece, fn: () => T, o?: {
        label?: string;
        hint?: (dir: "undo" | "redo") => void;
    }): {
        ok: boolean;
        value?: T;
        msg?: string;
    };
    /** v2-verb 迁移载具（T3b-2；见 legacy-bridge.withPoint）：fn 直写 v2 组件，共享令牌开/续/封。 */
    withPoint<T>(label: string | undefined, o: {
        checkpoint?: boolean;
        hint?: (dir: "undo" | "redo") => void;
    } | undefined, fn: () => T): {
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
