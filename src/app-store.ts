// app-store —— WebPaint 接 sync-store lib 的唯一装配点（cutover：JRP 深模块引擎 + editor-shell 超集 B/C）。
//   只做 config 注入（provider / ui bundle / crypto codec / crypt / validateAdopt）+ auth 转发 + gallery 列举适配。
//   红线全在库内。app 只碰 store 的四面 + editor-shell 超集（file/collection/localSettings/syncedSettings + edit/edits/
//   session/adoptBase/busy/autosave + 加密裸字节面）。绝不裸碰 kv/IDB/cloud vendor（ADR-0021）。
import {
  createStore, createOneDriveProvider, createCloudSync, createFolderStore,
  CloudConflictError, CloudNameCollisionError, resolveRef, runStoreMigrations,
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
  type Kv, type FolderEnvelope,
} from "./store/index.ts";
import { storeUI } from "./store-ui.ts";
import { looksEncryptedContainer } from "./crypto-format.ts";
import { CLIENT_ID, SCOPES, sessionFileName, stripSessionExt } from "./config.ts";
import { zipReadEntry, zipPack, zipUnpack } from "./zip.ts";
import { pack7z, unpack7z } from "./sevenzip.ts";
import { getPassword } from "./crypto-state.ts";
export { resolveRef };   // {id,name} 引用解析（活动笔刷引用用）
export { CloudConflictError, CloudNameCollisionError };

// localStorage → kv port（rackSync 第二 cloud-sync 实例 + lastSessionSignedIn 用；主 store 自带 kv，app 不注入）。
//   TODO(ADR-0021)：lastSessionSignedIn 该进 store.localSettings；rackSync 待 brush-rack→collection 后消失。
const lsKv: Kv = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* quota */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

// OneDrive provider + auth（config：clientId + vendored MSAL 脚本）。
const od = createOneDriveProvider({ clientId: CLIENT_ID, scopes: SCOPES, msalUrl: "./vendor/msal/msal-browser.min.js" });
export const provider = od.provider;
const _auth = od.auth;

// 加密 codec 注入（ADR-0019：crypto-container 不再静态 import 宿主 zip/7z；不注入=加密 dormant）。
const cryptoCodec = { zipPack, zipUnpack, pack7z, unpack7z };

// 唯一 store（JRP 深模块引擎）。appKey 默认 "sync"（migration 把旧 webpaint.* 迁到 sync.*/head.*）。
export const store = createStore({
  provider,
  ui: storeUI,
  crypto: cryptoCodec,
  crypt: {
    ext: "ora",
    // ora 内容知识只活在这一行：peek=ORA 里的 Thumbnails/thumbnail.png（store 格式盲）。
    makePeek: async (blob) => { try { return await zipReadEntry(blob, "Thumbnails/thumbnail.png"); } catch { return null; } },
    getPassword,   // 非交互内存密码（唯一 seam）；弹窗/验证/重试在 enc-thumbs.ensureUnlocked（busy 外）
  },
  // N2：采纳云端字节落盘前校验是真容器（ora-zip 或加密容器）——挡 captive-portal 200-HTML 覆盖唯一好本地副本。
  validateAdopt: async (blob) => {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) return true;   // ZIP 局部头 PK\x03\x04
    return looksEncryptedContainer(blob);
  },
  keepOnOpen: true,   // 编辑器：开即留本地
});

// migration ready-gate（ADR-0019）：boot 用 store 前 await storeReady。
//   collectionNames=∅：WebPaint 的 webpaint.dirty: 全是 .ora 工作文件（reading-state/syncedSettings 是 JRP 的；
//   brush-rack 在独立 webpaint-rack.* 命名空间，v001 不碰）→ dirty 全进 head 轨。
export const storeReady: Promise<void> = runStoreMigrations(new Set<string>());

// ============ auth（名字不变，直接转发）============
export const isAuthConfigured = () => _auth.isAuthConfigured();
export const initAuth = (...a: Parameters<typeof _auth.initAuth>) => _auth.initAuth(...a);
export const signIn = (...a: Parameters<typeof _auth.signIn>) => _auth.signIn(...a);
export const signOut = (...a: Parameters<typeof _auth.signOut>) => _auth.signOut(...a);
export const isSignedIn = () => _auth.isSignedIn();
export const getActiveAccount = () => _auth.getActiveAccount();
export const retrySilentSignIn = (...a: Parameters<typeof _auth.retrySilentSignIn>) => _auth.retrySilentSignIn(...a);
export const getToken = (...a: Parameters<typeof _auth.getToken>) => _auth.getToken(...a);
export const onAuthChanged = (cb: Parameters<typeof _auth.onAuthChanged>[0]) => _auth.onAuthChanged(cb);
export const getAuthState = () => _auth.getAuthState();

// ---- 上次登录 flag（TODO(ADR-0021)→ store.localSettings）----
export const getLastSessionSignedIn = () => lsKv.get("webpaint.lastSessionSignedIn") === "1";
export const setLastSessionSignedIn = (v: unknown) => lsKv.set("webpaint.lastSessionSignedIn", v ? "1" : "0");

// ---- dirty 查询：经 store 面（file().isDirty）。未登录返 false（app 多处 `isSignedIn() && isCloudDirty()`，保语义）----
export const isCloudDirty = (name: string) => _auth.isSignedIn() && store.file(name, { isZip: true }).isDirty();

// ---- gallery 数据：统一列举（local ∪ cloud，每项带 8-badge syncState）+ cloud-gone 安全收敛（都进库了）----
//   旧 mergeLocalCloud / classifyCloudGone / reconcileCloudGone（app 层越狱）**已删**——listAllItems + store.reconcile 取代。
//   返回 Item[] { path, syncState, size?, lastModified? }；display 名/徽章由 gallery-view-model 从 syncState 解析（不再自推 dirty/ghost）。
export async function listGallery({ signedIn, online }: { signedIn?: boolean; online?: boolean } = {}) {
  const ctx = { signedIn: !!signedIn, online: !!online };
  try { await store.reconcile(); } catch (e) { storeUI.reportError(e); }   // clean 孤儿→local-only（不删不 trash）；失败-fetch no-op
  const { items, folders, complete } = await store.listAllItems(ctx);
  return { items, cloudFolders: folders, complete };
}

// 回收站清单：云端 trash 走 store.listTrash（local trash 待 Phase4 session.ts 退休后经 store 暴露）。
export const listGalleryTrash = () => store.listTrash();

// ---- brush-rack = Folder-shape Store（第二 cloud-sync 实例，独立 appKey；TODO：→ store.collection 后此块消失）----
const rackSync = createCloudSync({ provider, kv: lsKv, fileName: () => "brush-rack.json", contentType: "application/json", appKey: "webpaint-rack" });
const RACK_UAT_PREHISTORY = 1;
function rackDecode(text: string): FolderEnvelope | null {
  let o: { brushes?: unknown; trash?: unknown; resetAt?: unknown };
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || !Array.isArray(o.brushes)) return null;
  return {
    version: 2,
    items: (o.brushes as Array<{ uat?: number }>).map((b) => (b && b.uat == null ? { ...b, uat: RACK_UAT_PREHISTORY } : b)),
    trash: Array.isArray(o.trash) ? o.trash : [],
    resetAt: (o.resetAt as number) || 0,
  } as FolderEnvelope;
}
function rackEncode(folder: FolderEnvelope) {
  return new Blob([JSON.stringify({ version: 2, brushes: folder.items, trash: folder.trash, resetAt: folder.resetAt })], { type: "application/json" });
}
export const rackStore = createFolderStore({
  cloud: rackSync, name: "rack", encode: rackEncode, decode: rackDecode,
  isOnline: () => navigator.onLine !== false,
});
export const setRackDirty = (d: boolean) => rackStore.setDirty(d);
export const isRackDirty = () => rackStore.isDirty();

// ---- graph 直用（gallery folder-tree 操作 + thumb byte-range）----
export {
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
};
