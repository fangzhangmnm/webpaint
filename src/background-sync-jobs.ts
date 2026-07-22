// background-sync-jobs —— 空闲调度深模块（spec: journal/20260721 Architecture.md §background-sync-jobs）。
//
// 全 app 的「空闲判断」统一走这里：各模块注册 handler（带优先级），本模块按空闲时长查 quota 表
// 决定每个 tick 给多少 ms 预算，按优先级轮询调用。
//   - quota 表：停顿 ≥x ms 后，每 tick 给 y ms 预算（取满足的最大档）。没停够 → 一点不跑。
//   - handler(deadline) 做**小原子**的活，快速返回 "done"（这轮没活了）或 "requeue"（还有活，
//     排到本轮队尾——循环类 handler 的协作式让位）。
//   - noteInput()：输入事件插队——跑完**当前** handler 立即停，且空闲时钟归零。
//   - 不支持 worker 线程的环境里，这个模块是承重墙（tile 压缩、未来 checkpoint save 都靠它切片）。
//
// 纯逻辑零 DOM：now 可注入（测试假时钟）；驱动（setInterval/rAF + input 监听）由 app 接线（tile-jobs.ts）。

export type JobResult = "done" | "requeue";
export interface QuotaRow { afterIdleMs: number; quotaMs: number }

interface Job {
  name: string;
  priority: number;                              // 大 = 先跑
  handler: (deadlineTs: number) => JobResult;    // deadlineTs = 本 tick 预算耗尽的时间戳（now() 系）
  alive: boolean;
}

const DEFAULT_QUOTA_TABLE: QuotaRow[] = [
  { afterIdleMs: 1000, quotaMs: 5 },     // 刚停 1s：小口
  { afterIdleMs: 5000, quotaMs: 15 },    // 停 5s：中口
  { afterIdleMs: 30_000, quotaMs: 50 },  // 长空闲：大口
];

export class BackgroundSyncJobs {
  private _jobs: Job[] = [];
  private _queue: Job[] = [];        // 当前轮（空了下个 tick 按优先级重排一轮）
  private _table: QuotaRow[];
  private _now: () => number;
  private _lastInput: number;
  private _interrupted = false;
  private _onError: ((jobName: string, e: unknown) => void) | null;

  constructor(opts: { quotaTable?: QuotaRow[]; now?: () => number; onError?: (jobName: string, e: unknown) => void } = {}) {
    this._table = (opts.quotaTable ?? DEFAULT_QUOTA_TABLE).slice().sort((a, b) => a.afterIdleMs - b.afterIdleMs);
    this._now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this._onError = opts.onError ?? null;
    this._lastInput = this._now();
  }

  /** 注册 handler。返回注销函数。同一模块可注册多个不同优先级的 handler。 */
  register(name: string, priority: number, handler: (deadlineTs: number) => JobResult): () => void {
    const job: Job = { name, priority, handler, alive: true };
    this._jobs.push(job);
    return () => {
      job.alive = false;
      const i = this._jobs.indexOf(job);
      if (i >= 0) this._jobs.splice(i, 1);
    };
  }

  /** 输入事件插队：当前 handler 跑完立即停 + 空闲时钟归零。驱动侧接 pointer/wheel/key。 */
  noteInput(): void {
    this._lastInput = this._now();
    this._interrupted = true;
  }

  /** 驱动侧周期调用（测试直接调）。按空闲时长查表拿预算，按优先级轮询 handler 直到预算尽/插队。 */
  tick(): void {
    const t0 = this._now();
    const idle = t0 - this._lastInput;
    let quotaMs = 0;
    for (const row of this._table) if (idle >= row.afterIdleMs) quotaMs = row.quotaMs;
    if (quotaMs <= 0) return;
    this._interrupted = false;
    const deadline = t0 + quotaMs;
    if (this._queue.length === 0) {
      // 新一轮：全部存活 handler 按优先级降序入队（稳定排序 → 同优先级按注册序）
      this._queue = this._jobs.filter((j) => j.alive).sort((a, b) => b.priority - a.priority);
    }
    while (this._queue.length > 0) {
      if (this._interrupted || this._now() >= deadline) break;   // 只在 handler 间停（跑完上一个才停）
      const job = this._queue.shift()!;
      if (!job.alive) continue;
      let r: JobResult;
      try {
        r = job.handler(deadline);
      } catch (e) {
        r = "done";   // 失败的 handler 本轮不再排队（防抛错死循环）；上报后下轮照常重试
        this._onError?.(job.name, e);
      }
      if (r === "requeue") this._queue.push(job);   // 循环类：排本轮队尾（让位给别人）
    }
  }
}
