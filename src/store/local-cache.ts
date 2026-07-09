// ⚠ 使用前必读 README.md。store 内部模块,**不要从 app 直接 import**——app 只走 createStore()。
//
// LocalCache —— store 的本地持久层(离线缓存 + 秒开)。**内容无关、零 ORA 知识**:
//   只存/取不透明 binary blob(ora/glb/pdf/txt 一律),thumbnail 由 app 经 hint.thumb 供——
//   **store 绝不解码内容、绝不渲缩略图**(那是 app 的事)。自包含 IDB(idb-store.ts),不依赖任何 app 代码。
// (旧版反向 import WebPaint 的 ora.ts/session.ts/storage.ts 解码渲 thumb —— 那是污染,2026-06-21 抽掉。)
// 契约见 types.ts 的 LocalCache。浏览器专用,真机验。

import { idbCache } from "./idb-store.ts";
import { LOCAL_BACKUP_PREFIX, asideStamp } from "./move-aside.ts";
import type { Bytes, LocalCache, TrashEntry } from "./types.ts";

const TRASH_PREFIX = "local-trash:";
function stripTrashPrefix(key: string): string { return key.replace(/^local-trash:[^:]*:/, ""); }

export function createLocalCache(): LocalCache {
  return {
    // 覆盖写。bytes 归一化成 Blob(契约落 Blob)。thumb 只取 hint.thumb(store 不解码、不渲)。
    async save(name: string, bytes: Bytes | Blob, hint?: unknown) {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
      const thumb = (hint && (hint as { thumb?: unknown }).thumb instanceof Blob) ? (hint as { thumb: Blob }).thumb : null;
      await idbCache.put(name, { blob, thumb, updatedAt: Date.now() });
    },
    async get(name: string) { const r = await idbCache.get(name); return r ? r.blob : null; },
    async exists(name: string) { return (await idbCache.get(name)) !== undefined; },
    // 已缓存的应用文件名（排除内部命名空间：local-trash: / .backup-local 前缀 / __collection__/）。
    async appKeys() {
      const keys = await idbCache.keys();
      return keys.filter((k) => !k.startsWith(TRASH_PREFIX) && !k.startsWith(LOCAL_BACKUP_PREFIX) && !k.startsWith("__collection__/"));
    },
    // 覆盖前留底:复制到隐藏 backup 命名空间(yyyymmddhhmmss-guid 防撞;原件不动)。
    async backup(name: string) {
      const r = await idbCache.get(name);
      if (!r) throw new Error(`本地无 ${name},无法备份`);
      const key = `${LOCAL_BACKUP_PREFIX}${asideStamp(Date.now())}:${name}`;
      await idbCache.put(key, { ...r, updatedAt: Date.now() });
      return key;
    },
    async trash(name: string) {
      const key = `${TRASH_PREFIX}${asideStamp(Date.now())}:${name}`;
      await idbCache.rename(name, key);
      return key;
    },
    async hardDelete(name: string) { await idbCache.del(name); },
    async restore(trashKey: string) {
      const orig = stripTrashPrefix(trashKey);
      await idbCache.rename(trashKey, orig);
      return orig;
    },
    async purgeTrash(trashKey: string) { await idbCache.del(trashKey); },
    async listTrash(): Promise<TrashEntry[]> {
      const keys = await idbCache.keys();
      return keys.filter((k) => k.startsWith(TRASH_PREFIX)).map((k) => ({ trashKey: k, name: stripTrashPrefix(k) }));
    },
  };
}
