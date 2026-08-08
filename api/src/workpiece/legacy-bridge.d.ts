import { UndoStack, type RecordData } from "./undo-stack.ts";
import type { Workpiece as WorkpieceV2, CollectorComponent } from "./workpiece2.ts";
import type { Workpiece as WorkpieceV1, DocumentOperator, OpStatus, HistoryFacade } from "./workpiece.ts";
/** 旧 operator 的 v2 组件化包装（collector = 本 token 的 microstep 列表）。 */
export declare class LegacyOpsComponent implements CollectorComponent {
    readonly kind = "legacyOps";
    private _w1;
    private _pending;
    /** 应用窗口挂起 tile 收集（app 组合根接 LayerTiles._suspendCollect；测试可空转）。 */
    _suspendCollect: (on: boolean) => void;
    constructor(w1: WorkpieceV1);
    /** 桥的 run 入口：持锁跑 forward（首跑），成了进 pending。op 抛异常 → 直接传播（桥走不可恢复）。 */
    runForward<A, D>(wp2: WorkpieceV2, op: DocumentOperator<A, D>, args: A): OpStatus;
    sealRecord(): RecordData | null;
    swapRecord(data: RecordData): RecordData;
    recordBytes(data: RecordData): number;
    disposeRecord(data: RecordData): void;
    /** 桥 onApplied 翻译用：step entry 里的 microstep 列表（kind/status 逐条报，沿旧 toast 契约）。 */
    microstepsOf(data: RecordData): {
        kind: string;
        statusFor?: (dir: "do" | "undo" | "redo") => string | undefined;
    }[];
}
export interface LegacyHistoryOpts {
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
export declare class LegacyHistory implements HistoryFacade {
    readonly stack: UndoStack;
    private _opts;
    private _wp2;
    private _legacy;
    private _open;
    constructor(opts: LegacyHistoryOpts);
    /** 组合根装配（wp2 的 ctor 需要本桥先建出 stack → 循环用 late-bind 解）。 */
    attach(wp2: WorkpieceV2, legacy: LegacyOpsComponent, suspendCollect: (on: boolean) => void): void;
    /** 旧 run 契约：执行 operator 并记账。checkpoint 默认 true = 立即封口；false = 令牌留开聚合微步。 */
    run<A, D>(_w: WorkpieceV1, op: DocumentOperator<A, D>, args: A, o?: {
        checkpoint?: boolean;
        label?: string;
    }): OpStatus;
    /** 手势结束：把开着的微步令牌封口（= 旧 sealCheckpoint）。 */
    sealCheckpoint(): void;
    /** 复合动作：一个令牌 = 一个整点；fn 中途抛/失败 → token.cancel 倒序回滚（含 tile 收集，优于旧实现）。 */
    compound<T>(_w: WorkpieceV1, fn: () => T): {
        ok: boolean;
        value?: T;
        msg?: string;
    };
    undo(_w?: WorkpieceV1): boolean;
    redo(_w?: WorkpieceV1): boolean;
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
