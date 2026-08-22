import type { CheckpointRecord } from "./checkpoint-policy.ts";
export declare function getThumb(key: string): Promise<unknown>;
export declare function setThumb(key: string, value: unknown): Promise<void>;
export declare function deleteThumb(key: string): Promise<void>;
export declare function clearThumbs(): Promise<number>;
export declare function getImageThumb(key: string): Promise<unknown>;
export declare function setImageThumb(key: string, value: unknown): Promise<void>;
export declare function deleteImageThumb(key: string): Promise<void>;
export declare function clearImageThumbs(): Promise<number>;
export declare function getCheckpoint(key: string): Promise<CheckpointRecord | null>;
export declare function putCheckpoint(key: string, rec: CheckpointRecord): Promise<void>;
export declare function deleteCheckpoint(key: string): Promise<void>;
/** 本 app 库（`weebpaint`）各 object store 的**估算**占用。单事务、逐 store 一遍 cursor。
 *  只返标量（字节 + 件数），不返任何 key —— 与 store 侧 usageBreakdown 同一纪律。 */
export declare function appDbUsage(): Promise<Record<string, {
    bytes: number;
    count: number;
}>>;
