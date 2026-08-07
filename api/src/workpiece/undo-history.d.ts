import { Workpiece, DocumentOperator, type OpStatus } from "./workpiece.ts";
export interface UndoHistoryOpts {
    maxQuotaBytes: number;
    /** 不可恢复失败（栈已被弃）。app 侧接：integrity 自愈 + 全量重绘 + error banner。 */
    onUnrecoverable: (e: unknown) => void;
    /** 栈形状变化（push/undo/redo/clear/evict）。app 侧接 wp:histchange 派发。 */
    onChange?: () => void;
    /** 某步被应用（do/undo/redo）。app 侧接状态栏 toast + 面板刷新。 */
    onApplied?: (info: {
        kind: string;
        dir: "do" | "undo" | "redo";
        status?: string;
    }) => void;
}
export declare class UndoHistory {
    private _steps;
    private _cursor;
    private _opts;
    constructor(opts: UndoHistoryOpts);
    /**
     * 执行一个 operator 并入栈。checkpoint 默认 true（独立动作）；手势流传 false + 抬手 sealCheckpoint()。
     * 返回 operator 的状态；ok:false = 已原子回滚，栈未动。
     */
    run<A, D>(w: Workpiece, op: DocumentOperator<A, D>, args: A, o?: {
        checkpoint?: boolean;
        label?: string;
    }): OpStatus;
    /** 手势结束：把游标处最后一步封口成 checkpoint（微步流的整点标记）。 */
    sealCheckpoint(): void;
    /**
     * 复合动作：fn 里跑若干 run(..., {checkpoint:false})，全成 → 自动封口成一个 checkpoint；
     * 中途某步 ok:false 或抛异常 → 把 fn 内已入栈的微步**倒序回滚并弹掉**（回滚到进入前的整点）。
     * 回滚自身失败 → 不可恢复路径。fn 的返回值透传。
     */
    compound<T>(w: Workpiece, fn: () => T): {
        ok: boolean;
        value?: T;
        msg?: string;
    };
    /** 撤销一个整 checkpoint。顶端未封口 → warning 语义：先补封再撤（返回值照常）。 */
    undo(w: Workpiece): boolean;
    /** 重做一个整 checkpoint。 */
    redo(w: Workpiece): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    get depth(): number;
    /** 全量重扫各步 estimateQuotaBytes（压缩会让单步 usage 变，不缓存）。 */
    quotaUsage(): number;
    /** 弃整栈（换文档/不可恢复）。逐步 disposeData 释放句柄。 */
    clear(): void;
    private _applyStep;
    private _rollbackTo;
    private _prevCheckpointIndex;
    private _evictToQuota;
    private _disposeStep;
    private _unrecoverable;
}
