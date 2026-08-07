export type JobResult = "done" | "requeue";
export interface QuotaRow {
    afterIdleMs: number;
    quotaMs: number;
}
export declare class BackgroundSyncJobs {
    private _jobs;
    private _queue;
    private _table;
    private _now;
    private _lastInput;
    private _interrupted;
    private _onError;
    constructor(opts?: {
        quotaTable?: QuotaRow[];
        now?: () => number;
        onError?: (jobName: string, e: unknown) => void;
    });
    /** 注册 handler。返回注销函数。同一模块可注册多个不同优先级的 handler。
     *  opts.minIdleMs：该 handler 只在空闲 ≥ 此值时才有资格跑（与 quota 表同一套 idle 账；
     *  v0.4.11 给 autosave 用——「停笔 30 秒后才落盘」）。 */
    register(name: string, priority: number, handler: (deadlineTs: number) => JobResult, opts?: {
        minIdleMs?: number;
    }): () => void;
    /** 输入事件插队：当前 handler 跑完立即停 + 空闲时钟归零。驱动侧接 pointer/wheel/key。 */
    noteInput(): void;
    /** 驱动侧周期调用（测试直接调）。按空闲时长查表拿预算，按优先级轮询 handler 直到预算尽/插队。 */
    tick(): void;
}
