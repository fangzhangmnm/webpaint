import type { Kv } from "./types.ts";
export interface PendingGone {
    /** 该 name 当前是 candidate-gone（grace 期内、显 pendingGone badge）。 */
    isPending(name: string): boolean;
    /** 记一次**权威**「见 gone」。返回是否**该动手**（send trash）：首次只标记返 false；已标记且 `now-first ≥ grace` → true。 */
    seenGone(name: string, now: number): boolean;
    /** 清标记（重现自愈 / 被编辑取消 / 动手后收尾）。 */
    clear(name: string): void;
    /** 当前所有 candidate 名（调试/审计）。 */
    names(): string[];
}
export declare function createPendingGone(kv: Kv, graceMs: number): PendingGone;
