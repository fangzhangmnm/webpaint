// ⚠ store 内部深模块。app 不直接 import——经 createStore。
//
// blob-partition —— IDB 单 object store `blobs` 之上的**逻辑分区**（唯一知道分区前缀的地方 = IDB 侧的窄腰）。
//   key = `${partition}/${name}`；files / trash / backup / collections 物理同库、逻辑隔离。
//   file/trash/backup 本就同类（不透明 blob），collections 是 JSON envelope，一律当 opaque blob 存。
//   跨分区原子移动（trash / restore / backup）= 同一 object store 内 rename，事务原子（idb-store.rename）。
import { createIdbCache, type CacheRecord } from "./idb-store.ts";

export type Partition = "files" | "trash" | "backup" | "collections";

export interface PartitionView {
  get(name: string): Promise<CacheRecord | undefined>;
  put(name: string, rec: CacheRecord): Promise<void>;
  del(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  keys(): Promise<string[]>;                                            // 本分区内、**去前缀**的 name
  usage(): Promise<{ bytes: number; count: number }>;                   // 本分区占用（字节 + 件数）；只返标量，拿不到清单
  moveTo(name: string, to: Partition, toName: string): Promise<void>;   // 跨分区原子改名（同 object store 内 rename）
}

export interface PartitionedBlobStore {
  partition(p: Partition): PartitionView;
}

export function createPartitionedBlobStore(dbName: string): PartitionedBlobStore {
  const idb = createIdbCache(dbName);
  const key = (p: Partition, name: string): string => `${p}/${name}`;
  function view(p: Partition): PartitionView {
    const prefix = `${p}/`;
    return {
      get: (name) => idb.get(key(p, name)),
      put: (name, rec) => idb.put(key(p, name), rec),
      del: (name) => idb.del(key(p, name)),
      exists: async (name) => (await idb.get(key(p, name))) !== undefined,
      keys: async () => (await idb.keys()).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
      usage: () => idb.usage(prefix),
      moveTo: (name, to, toName) => idb.rename(key(p, name), key(to, toName)),
    };
  }
  return { partition: view };
}
