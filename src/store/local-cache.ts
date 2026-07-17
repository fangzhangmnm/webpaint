// ⚠ 使用前必读 README.md。store 内部模块,**不要从 app 直接 import**——app 只走 createStore()。
//
// LocalCache —— store 的本地持久层(离线缓存 + 秒开)。**内容无关、零 ORA 知识**:
//   只存/取不透明 binary blob(ora/glb/pdf/txt 一律),peek(不透明 sidecar)由 app 经 hint.peek 供——
//   **store 绝不解码内容、绝不渲缩略图**(那是 app 的事)。IDB 单 object store `blobs`,本 cache 用
//   **files / trash / backup 三个分区**(blob-partition 深模块);collections 是**另一个分区**,由
//   createCollectionCache 提供、collection 模块用(见 create-store 接线)。
// 契约见 types.ts 的 LocalCache。浏览器专用,真机验。

import { createPartitionedBlobStore } from "./blob-partition.ts";
import { createIdbCache } from "./idb-store.ts";
import { asideStamp } from "./move-aside.ts";
import type { Bytes, LocalCache, TrashEntry } from "./types.ts";

// trashKey/backupKey 内层 = "<yyyymmddhhmmss-guid>:<name>" → 还原 name（去一段盖戳前缀）。
const stripStamp = (inner: string): string => inner.replace(/^[^:]*:/, "");
const stamp = (): string => asideStamp(Date.now());
// trashKey/backupKey = "<partition>/<inner>"；拆成分区 + 内层键。
function splitKey(k: string): { part: string; inner: string } {
  const slash = k.indexOf("/");
  return slash < 0 ? { part: "trash", inner: k } : { part: k.slice(0, slash), inner: k.slice(slash + 1) };
}

// dbName 必须已带命名空间(createStore 传 `${appId}.${databaseId}`)——同 origin 兄弟 PWA / 多 store 实例隔离,见 idb-store.ts 头注释。
export function createLocalCache(dbName: string): LocalCache {
  const bs = createPartitionedBlobStore(dbName);
  const files = bs.partition("files");
  const trashP = bs.partition("trash");
  const backupP = bs.partition("backup");
  return {
    // 覆盖写。bytes 归一化成 Blob(契约落 Blob)。peek 只取 hint.peek(store 不解码、不看内容)。
    async save(name: string, bytes: Bytes | Blob, hint?: unknown) {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
      const peek = (hint && (hint as { peek?: unknown }).peek instanceof Blob) ? (hint as { peek: Blob }).peek : null;
      await files.put(name, { blob, peek, updatedAt: Date.now() });
    },
    async get(name: string) { const r = await files.get(name); return r ? r.blob : null; },
    async exists(name: string) { return files.exists(name); },
    // 轻量元信息：blob.size 是 Blob 引用属性（不载字节）、updatedAt 存记录里 → 便宜。listing 给本地项填尺寸/时间。
    async stat(name: string) { const r = await files.get(name); return r ? { size: r.blob.size, updatedAt: r.updatedAt } : null; },
    // 已缓存的应用文件名 = files 分区键（trash/backup/collections 天然隔离在别分区，无需按名过滤）。
    async appKeys() { return files.keys(); },
    // 覆盖前留底:复制到 backup 分区(yyyymmddhhmmss-guid 防撞;原件不动)。
    async backup(name: string) {
      const r = await files.get(name);
      if (!r) throw new Error(`本地无 ${name},无法备份`);
      const inner = `${stamp()}:${name}`;
      await backupP.put(inner, { ...r, updatedAt: Date.now() });
      return `backup/${inner}`;
    },
    async trash(name: string) {
      const inner = `${stamp()}:${name}`;
      await files.moveTo(name, "trash", inner);   // 原子移进 trash 分区（绝不硬删用户字节）
      return `trash/${inner}`;
    },
    async hardDelete(name: string) { await files.del(name); },
    async restore(trashKey: string) {
      const { part, inner } = splitKey(trashKey);
      const orig = stripStamp(inner);
      await (part === "backup" ? backupP : trashP).moveTo(inner, "files", orig);
      return orig;
    },
    async purgeTrash(trashKey: string) {
      const { part, inner } = splitKey(trashKey);
      await (part === "backup" ? backupP : trashP).del(inner);
    },
    async listTrash(): Promise<TrashEntry[]> {
      return (await trashP.keys()).map((inner) => ({ trashKey: `trash/${inner}`, name: stripStamp(inner) }));
    },
    // 备份分区列举（形同 listTrash，但 key 带 `backup/` 前缀 → restore/purgeTrash 经 splitKey 认得走 backupP）。
    async listBackup(): Promise<TrashEntry[]> {
      return (await backupP.keys()).map((inner) => ({ trashKey: `backup/${inner}`, name: stripStamp(inner) }));
    },
  };
}

// collections 分区的极简 cache（collection 模块用；collection 经 collectionLocalKey 自带 `collections/` 前缀 → 直接落 blobs 裸键）。
//   与 files 分区键前缀不同、天然隔离，同一 `blobs` object store 共存。只需 collection 用到的三面。
export function createCollectionCache(dbName: string): Pick<LocalCache, "save" | "get" | "exists"> {
  const idb = createIdbCache(dbName);
  return {
    async save(name: string, bytes: Bytes | Blob) {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
      await idb.put(name, { blob, peek: null, updatedAt: Date.now() });
    },
    async get(name: string) { const r = await idb.get(name); return r ? r.blob : null; },
    async exists(name: string) { return (await idb.get(name)) !== undefined; },
  };
}
