import { UndoStack } from "./undo-stack.ts";
import type { Workpiece } from "./workpiece.ts";
export interface HistoryOpts {
    maxQuotaBytes: number;
    /** 不可恢复失败（栈已被弃）。app 侧接：integrity 自愈 + 全量重绘 + error banner。 */
    onUnrecoverable: (e: unknown) => void;
    /** 栈形状变化（push/undo/redo/clear/evict）。app 侧接 wp:histchange 派发。 */
    onChange?: () => void;
    /** 某步被应用（undo/redo；按 step entries 逐组件报）。app 侧接面板/画面刷新。 */
    onApplied?: (info: {
        kind: string;
        dir: "undo" | "redo";
    }) => void;
}
export declare class History {
    readonly stack: UndoStack;
    private _opts;
    private _wp;
    private _open;
    constructor(opts: HistoryOpts);
    /** 组合根装配（wp 的 ctor 需要 stack 先在 → late-bind）。 */
    attach(wp: Workpiece): void;
    /** 一个 undo 整点：fn 里直写 v2 组件 verb；本方法只管共享令牌的开/续/封。
     *  checkpoint:false = 留开聚合微步（语义同旧 run/withPoint）；hint = step 的非权威附注。 */
    withPoint<T>(label: string | undefined, o: {
        checkpoint?: boolean;
        hint?: (dir: "undo" | "redo") => void;
    } | undefined, fn: () => T): {
        ok: boolean;
        value?: T;
        msg?: string;
    };
    /** 手势结束：把开着的微步令牌封口。 */
    sealCheckpoint(): void;
    undo(): boolean;
    redo(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    get depth(): number;
    quotaUsage(): number;
    /** 弃整栈（换文档/不可恢复）。开着的令牌弃置（不回滚——load 流里层可能已换血）。 */
    clear(): void;
    private _req;
    private _commitOpen;
    private _translateApplied;
    private _unrecoverable;
}
