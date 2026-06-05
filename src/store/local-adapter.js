// LocalAdapter —— 真本地持久层，满足 store.local 契约（包 session.js/storage.js 的 IDB）。
// 测试用 MockLocal（mock-local.js）；浏览器跑这个。**浏览器专用**（IDB + canvas），node 测不到——
// 故写成薄到一眼能看对的胶水，留到真机那轮一起验。
//
// 契约（见 store.js 头注 + mock-local.js）：
//   save(name, bytes)   覆盖写（bytes=ora blob；解码渲 thumb 后 putSession，非热路径）
//   get(name)           → ora blob | null
//   exists(name)        → bool
//   backup(name)        → backupName（复制整 pkg，含 thumb；原件不动）
//   trash(name)         → trashKey（session.trashSession：IDB rename 到 trash:）
//   hardDelete(name)    → void（storage.deleteSession）
//   restore(trashKey)   → name（session.restoreSession，撞名自动 (2)）

import { getSession, putSession, deleteSession } from "../storage.js";
import { trashSession, restoreSession, purgeFromTrash, renderThumbBlob } from "../session.js";
import { decodeOraToDoc } from "../ora.js";

export function createLocalAdapter() {
  return {
    async save(name, oraBlob) {
      // app 主存路径用 saveNow（live doc，不解码）；这里给 Store 流（exit flush / pull 覆盖）用，非热路径。
      // 解码一次渲 thumb，用**原始 ora bytes** putSession（不 re-encode，保字节）。
      const doc = await decodeOraToDoc(oraBlob);
      const thumb = await renderThumbBlob(doc, 256);
      await putSession(name, { name, updatedAt: Date.now(), ora: oraBlob, thumb });
    },

    async get(name) {
      const pkg = await getSession(name);
      return pkg ? pkg.ora || null : null;
    },

    async exists(name) {
      return (await getSession(name)) != null;
    },

    async backup(name) {
      const pkg = await getSession(name);
      if (!pkg) throw new Error(`本地无 ${name}，无法备份`);
      const backupName = `${name}-backup-${Date.now()}`;
      // 复制整 pkg（含 thumb）；原件留着，pull 失败时无害。
      await putSession(backupName, { ...pkg, name: backupName, updatedAt: Date.now() });
      return backupName;
    },

    async trash(name) {
      return await trashSession(name);     // IDB rename name → trash:<ts>:name
    },

    async hardDelete(name) {
      await deleteSession(name);
    },

    async restore(trashKey) {
      return await restoreSession(trashKey);  // rename 回原名，撞名自动 (2)(3)
    },

    async purgeTrash(trashKey) {
      await purgeFromTrash(trashKey);          // 永久删本地回收站一条
    },
  };
}
