// storage-usage —— 「本机到底被占了多少」的**唯一口径**（深模块，2026-08-21）。
//
// 为什么要有这个模块（user 2026-08-21：「存储占用估算要算上这些别的地方，用一个专门的深模块放在一起」）：
//   在此之前只有 gallery-shell 里散着的两段代码，各读一半真相 ——
//     · 页脚「作品占用」只统计 store 的 `files` 分区；
//     · 配额告警读 navigator.storage.estimate()，那是**整个 origin**。
//   两个数口径不同却并排显示，而**用户看不见的那几处才是大头**：
//     · `checkpoints`：每幅打开过的画一份**完整 .ora**（revert 快照）——和作品本体等大；
//     · `trash/`：删除=移进回收站（§A 红线不硬删），删了不清空就一直在；
//     · `backup/`：覆盖前留底，**目前 app 侧没有任何 UI**，只进不出。
//   于是「卸载本地副本腾空间」之后页脚数字降了、磁盘其实没降 —— 那就是谎报。
//   本模块把所有吃 origin 配额的地方汇到一处，谁清得掉、怎么清，一并说清楚。
//
// 纪律：
//   · **只读**。不删不迁不清理 —— 清理是用户显式动作，归各自的 UI。
//   · 不做 i18n、不碰 DOM：只返 id + 数字，文案/渲染归调用方（gallery-shell）。
//   · store 侧的字节**只经 store 的 usageBreakdown 拿**（家规：用了库就禁止直接碰 IndexedDB）。
//     app 私有库（weebpaint：checkpoints/缩略图）是 app 自己的，走 storage.ts 的 appDbUsage。
//   · 数字是**估算**：IDB 不报记录大小；Blob.size/byteLength 准，字符串按 UTF-16 估，
//     结构开销/索引不计。展示必须带「约」。

import { store as _store } from "./app-store.ts";
import { appDbUsage } from "./storage.ts";
import { getStoragePersistence, type PersistenceState } from "./storage-persist.ts";
import { reportError } from "./error-badge.ts";

/** 桶 id。UI 拿它去查 i18n 文案，深模块自己不认字。 */
export type BucketId =
  | "works"          // store files/：作品本体
  | "trash"          // store trash/：回收站（删除=移进来，不硬删）
  | "backup"         // store backup/：覆盖前留底
  | "settings"       // store collections/：设置/笔架等
  | "storeMisc"      // store 其它分区（dir-index-cache / staging）：可再生缓存
  | "checkpoints"    // app 库：revert 快照，每幅打开过的画一份完整 .ora
  | "thumbs";        // app 库：图库 + 云盘图片缩略图缓存

/** 用户能不能自己清掉、从哪清。UI 据此决定要不要给「去清理」的去处。 */
export type Clearable =
  | "gallery"        // 图库里删除/卸载
  | "gallery-trash"  // 图库的回收站视图可清空
  | "no-ui"          // **目前没有任何 UI 能清** —— 这是要如实说出来的
  | "auto";          // 可再生缓存，自己会被覆盖/重建，不值得让用户操心

export interface UsageBucket { id: BucketId; bytes: number; count: number; clearable: Clearable }

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

// store 分区名 → 桶 id。usageBreakdown 返回的是分区前缀（见库里 blob-partition.Partition）。
const PARTITION_TO_BUCKET: Record<string, BucketId> = {
  files: "works",
  trash: "trash",
  backup: "backup",
  collections: "settings",
  "dir-index-cache": "storeMisc",
  staging: "storeMisc",
  "sw-bridge": "storeMisc",
};
const CLEARABLE: Record<BucketId, Clearable> = {
  works: "gallery",
  trash: "gallery-trash",
  backup: "no-ui",        // ⚠ 只进不出：备份箱 UI 还没做（2026-08-21 记账中）
  settings: "auto",
  storeMisc: "auto",
  checkpoints: "gallery", // 随作品删除/改名/卸载而清（2026-08-21 起 offload 也清）
  thumbs: "auto",
};

function add(map: Map<BucketId, UsageBucket>, id: BucketId, bytes: number, count: number): void {
  const b = map.get(id) ?? { id, bytes: 0, count: 0, clearable: CLEARABLE[id] };
  b.bytes += bytes; b.count += count;
  map.set(id, b);
}

/** 采一份全口径报告。任一来源失败都只让那部分缺席，**绝不让整份报告失败**
 *  —— 这是个诚实汇报模块，半份真相好过一个红叉。 */
export async function collectStorageReport(): Promise<StorageReport> {
  const map = new Map<BucketId, UsageBucket>();

  // ① store 侧（经库的口径，不自己开 IDB）
  try {
    const bd = await _store.files.usageBreakdown();
    for (const [part, v] of Object.entries(bd)) {
      const id = PARTITION_TO_BUCKET[part];
      if (id) add(map, id, v.bytes, v.count);
      else add(map, "storeMisc", v.bytes, v.count);   // 库将来加了新分区 → 归杂项，不静默丢
    }
  } catch (e) { reportError(new Error("[storage-usage] store breakdown failed: " + String(e)), "log"); }

  // ② app 私有库（checkpoints / 两份缩略图缓存）
  try {
    const app = await appDbUsage();
    for (const [name, v] of Object.entries(app)) {
      if (name === "checkpoints") add(map, "checkpoints", v.bytes, v.count);
      else add(map, "thumbs", v.bytes, v.count);      // gallery-thumbs / image-thumbs 合并成一桶（用户视角就是「缩略图」）
    }
  } catch (e) { reportError(new Error("[storage-usage] app db usage failed: " + String(e)), "log"); }

  // ③ 整个 origin（浏览器视角；含 SW 预缓存 / localStorage 等我们没数的）
  let originUsage: number | null = null, originQuota: number | null = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      originUsage = est.usage ?? null;
      originQuota = est.quota ?? null;
    }
  } catch (e) { reportError(new Error("[storage-usage] estimate failed: " + String(e)), "log"); }

  const buckets = [...map.values()].sort((a, b) => b.bytes - a.bytes);
  const accountedBytes = buckets.reduce((n, b) => n + b.bytes, 0);
  return {
    buckets,
    accountedBytes,
    originUsage,
    originQuota,
    unaccountedBytes: originUsage == null ? null : Math.max(0, originUsage - accountedBytes),
    ratio: originQuota ? (originUsage ?? 0) / originQuota : null,
    persistence: getStoragePersistence(),
  };
}

/** 告警档位。阈值沿用 gallery-shell 原有的 80% / 95%（口径不变，只是搬进单一真相处）。 */
export function usageLevel(r: StorageReport): "ok" | "warn" | "critical" {
  if (r.ratio == null) return "ok";
  if (r.ratio > 0.95) return "critical";
  if (r.ratio > 0.8) return "warn";
  return "ok";
}

/** 取某个桶（没有 → 0）。UI 想单独显示「作品占用」时用。 */
export function bucketOf(r: StorageReport, id: BucketId): UsageBucket {
  return r.buckets.find((b) => b.id === id) ?? { id, bytes: 0, count: 0, clearable: CLEARABLE[id] };
}
