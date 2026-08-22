import { type PersistenceState } from "./storage-persist.ts";
/** 桶 id。UI 拿它去查 i18n 文案，深模块自己不认字。 */
export type BucketId = "works" | "trash" | "backup" | "settings" | "storeMisc" | "checkpoints" | "thumbs";
/** 用户能不能自己清掉、从哪清。UI 据此决定要不要给「去清理」的去处。 */
export type Clearable = "gallery" | "gallery-trash" | "no-ui" | "auto";
export interface UsageBucket {
    id: BucketId;
    bytes: number;
    count: number;
    clearable: Clearable;
}
export interface StorageReport {
    buckets: UsageBucket[];
    /** 我们能解释的字节合计。 */
    accountedBytes: number;
    /** navigator.storage.estimate()：**整个 origin**（prod 与 dev 同源 → 两个通道共用这一份）。 */
    originUsage: number | null;
    originQuota: number | null;
    /** originUsage − accounted：SW 预缓存 / localStorage / IDB 结构开销等我们没数的。可能为负（估算误差）→ 归零。 */
    unaccountedBytes: number | null;
    /** 已用比例（0-1）。拿不到 quota → null。 */
    ratio: number | null;
    /** 本地存储是不是持久化的（best-effort = 浏览器有权整源驱逐）。 */
    persistence: PersistenceState;
}
/** 采一份全口径报告。任一来源失败都只让那部分缺席，**绝不让整份报告失败**
 *  —— 这是个诚实汇报模块，半份真相好过一个红叉。 */
export declare function collectStorageReport(): Promise<StorageReport>;
/** 告警档位。阈值沿用 gallery-shell 原有的 80% / 95%（口径不变，只是搬进单一真相处）。 */
export declare function usageLevel(r: StorageReport): "ok" | "warn" | "critical";
/** 取某个桶（没有 → 0）。UI 想单独显示「作品占用」时用。 */
export declare function bucketOf(r: StorageReport, id: BucketId): UsageBucket;
