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
import { trashSession, restoreSession, purgeFromTrash, listTrashedSessions, renderThumbBlob, putSessionPkg } from "../session.js";
import { decodeOraToDoc } from "../ora.js";
import { LOCAL_BACKUP_PREFIX, asideStamp } from "./move-aside.js";

export function createLocalAdapter() {
  return {
    async save(name, oraBlob) {
      // app 主存路径用 saveNow（live doc，不解码）；这里给 Store 流（exit flush / pull 覆盖）用，非热路径。
      // 解码一次渲 thumb，用**原始 ora bytes** 落盘（不 re-encode，保字节）。
      // 解码 / 渲 thumb 失败**不阻断落盘**：字节是真相，thumb 是派生——宁可少缩略图也绝不丢字节
      //   （否则坏/新格式 ora 会卡死整条 pull/flush，见 docs/reports 候选 4）。
      let thumb = null;
      try { thumb = await renderThumbBlob(await decodeOraToDoc(oraBlob), 256); }
      catch (e) { console.warn("[local] thumb 渲染失败，仅存字节：", e); }
      await putSessionPkg(name, oraBlob, thumb);   // 与 saveSession 共用唯一落盘原语
    },

    async get(name) {
      const pkg = await getSession(name);
      return pkg ? pkg.ora || null : null;
    },

    async exists(name) {
      return (await getSession(name)) != null;
    },

    async backup(name) {
      // 覆盖前留底：复制到隐藏 .backup-local/ 命名空间（深模块约定，见 move-aside.js）；
      // 名字 yyyymmddhhmmss-guid 防撞；原件不动、不进图库（不 flood 用户文件夹）。
      const pkg = await getSession(name);
      if (!pkg) throw new Error(`本地无 ${name}，无法备份`);
      const backupKey = `${LOCAL_BACKUP_PREFIX}${asideStamp(Date.now())}:${name}`;
      await putSession(backupKey, { ...pkg, updatedAt: Date.now() });   // 复制，原件留着
      return backupKey;
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

    async listTrash() {
      // 本地回收站清单（给 flow.emptyTrash 枚举用）：{ trashKey, name }。
      return (await listTrashedSessions()).map((t) => ({ trashKey: t.trashKey, name: t.originalName }));
    },
  };
}
