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
import { looksEncryptedContainer } from "../crypto-container.js";
import { LOCAL_BACKUP_PREFIX, asideStamp } from "./move-aside.ts";
import type { Bytes, LocalAdapter, TrashEntry } from "./types.ts";

export function createLocalAdapter(): LocalAdapter {
  return {
    async save(name: string, oraBlob: Bytes | Blob) {
      // app 主存路径用 saveNow（live doc，不解码）；这里给 Store 流（exit flush / pull 覆盖 /
      // rename / push）用，非热路径。
      // **必须归一化成 Blob**：Store 流经 toU8 传进来的是 Uint8Array，但本地持久层契约是 Blob——
      //   pkg.ora.size 给图库列大小（Uint8Array 只有 byteLength → undefined → 列「0B」），
      //   decodeOraToDoc/zipUnpack 的 BlobReader 也只吃 Blob（Uint8Array → 抛 → 打不开 + 渲不出 thumb）。
      //   rename 后「变 0B / 点进去打不开 / thumb 问号」三联症全是这条漏归一化。
      const blob = oraBlob instanceof Blob ? oraBlob : new Blob([oraBlob], { type: "application/zip" });
      // 解码一次渲 thumb，用**原始 ora bytes** 落盘（不 re-encode，保字节）。
      // 解码 / 渲 thumb 失败**不阻断落盘**：字节是真相，thumb 是派生——宁可少缩略图也绝不丢字节
      //   （否则坏/新格式 ora 会卡死整条 pull/flush，见 docs/reports 候选 4）。
      let thumb = null;
      try {
        // APP-DIVERGENCE(webpaint)：加密容器（ADR-0012）不渲明文 thumb——
        //   ① 明文缩略图不落 IDB；② decodeOraToDoc 对容器会弹密码（pull 流里弹窗 = 伏击）。
        //   图库解锁后从容器尾部的加密 thumb blob 解密预览。
        if (!(await looksEncryptedContainer(blob))) {
          thumb = await renderThumbBlob(await decodeOraToDoc(blob), 256);
        }
      }
      catch (e) { console.warn("[local] thumb 渲染失败，仅存字节：", e); }
      await putSessionPkg(name, blob, thumb);   // 与 saveSession 共用唯一落盘原语（落 Blob）
    },

    async get(name: string) {
      const pkg = await getSession(name);
      return pkg ? pkg.ora || null : null;
    },

    async exists(name: string) {
      return (await getSession(name)) != null;
    },

    async backup(name: string) {
      // 覆盖前留底：复制到隐藏 .backup-local/ 命名空间（深模块约定，见 move-aside.js）；
      // 名字 yyyymmddhhmmss-guid 防撞；原件不动、不进图库（不 flood 用户文件夹）。
      const pkg = await getSession(name);
      if (!pkg) throw new Error(`本地无 ${name}，无法备份`);
      const backupKey = `${LOCAL_BACKUP_PREFIX}${asideStamp(Date.now())}:${name}`;
      await putSession(backupKey, { ...pkg, updatedAt: Date.now() });   // 复制，原件留着
      return backupKey;
    },

    async trash(name: string) {
      return await trashSession(name);     // IDB rename name → trash:<ts>:name
    },

    async hardDelete(name: string) {
      await deleteSession(name);
    },

    async restore(trashKey: string) {
      return await restoreSession(trashKey);  // rename 回原名，撞名自动 (2)(3)
    },

    async purgeTrash(trashKey: string) {
      await purgeFromTrash(trashKey);          // 永久删本地回收站一条
    },

    async listTrash(): Promise<TrashEntry[]> {
      // 本地回收站清单（给 flow.emptyTrash 枚举用）：{ trashKey, name }。
      return (await listTrashedSessions()).map((t: { trashKey: string; originalName: string }) => ({ trashKey: t.trashKey, name: t.originalName }));
    },
  };
}
