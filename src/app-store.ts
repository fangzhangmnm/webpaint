// app-store —— WebPaint 装配 sync-store 的唯一点（cutover：薄库 + editor-session）。
//   只做 config 注入（provider / ui bundle / crypto codec / crypt / validateAdopt）+ auth 转发 + gallery 列举适配。
//   app 只碰 store 四面（file/collection/localSettings/syncedSettings）+ editor-session。绝不裸碰 kv/IDB/graph/vendor。
import { createStore, createOneDriveProvider, isCached, isDirty } from "./store/index.ts";
import { stripSessionExt } from "./config.ts";
import { storeUI } from "./store-ui.ts";
import { looksEncryptedContainer } from "./crypto-format.ts";
import { CLIENT_ID, SCOPES } from "./config.ts";
import { zipReadEntry, zipPack, zipUnpack } from "./zip.ts";
import { pack7z, unpack7z } from "./sevenzip.ts";
import { getPassword } from "./crypto-state.ts";

// OneDrive provider + auth。
const od = createOneDriveProvider({ clientId: CLIENT_ID, scopes: SCOPES, msalUrl: "./vendor/msal/msal-browser.min.js" });
export const provider = od.provider;
const _auth = od.auth;

// 加密 codec 注入（不注入 = 加密 dormant）。
const cryptoCodec = { zipPack, zipUnpack, pack7z, unpack7z };

// 唯一 store（薄库）。app 建它（含 ui bundle）；migration 内部自跑（createStore 隐形，app 不 await）。
export const store = createStore({
  provider,
  ui: storeUI,
  crypto: cryptoCodec,
  crypt: {
    ext: "ora",
    makePeek: async (blob) => { try { return await zipReadEntry(blob, "Thumbnails/thumbnail.png"); } catch { return null; } },  // ora 内容知识只此一行
    getPassword,
  },
  validateAdopt: async (blob) => {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) return true;   // ZIP PK\x03\x04
    return looksEncryptedContainer(blob);
  },
  keepOnOpen: true,
  signedIn: () => _auth.isSignedIn(),   // 连接态 store 自持（网盘模型）：watchFolder/云列举不再由 app 每次传 ctx
});

// ============ auth（转发）============
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

// 上次登录 flag（ADR-0021：app 不碰 kv → store.localSettings）。
export const getLastSessionSignedIn = () => store.localSettings.get<boolean>("lastSessionSignedIn") === true;
export const setLastSessionSignedIn = (v: unknown) => store.localSettings.set("lastSessionSignedIn", !!v);

// ---- gallery 数据：统一列举（local ∪ cloud，每项带 syncState）。reconcile 已进库（watchFolder 惰性 per-folder）。----
const _CLOUD_STATES = new Set(["cloud-only", "synced", "unpushed", "newer-on-cloud", "conflict"]);   // 有云版的 syncState
// Item{path,syncState} → 旧 GalleryItem{name,local,cloud,dirty,ghost}（gallery-view-model 兼容；派生自 syncState）。
function itemToG(it: { path: string; syncState: string; lastModified?: number }) {
  const name = stripSessionExt(it.path);
  return {
    name,
    local: isCached(it.syncState as never) ? { name } : null,
    cloud: _CLOUD_STATES.has(it.syncState) ? { path: it.path, name, lastModifiedDateTime: it.lastModified ? new Date(it.lastModified).toISOString() : undefined } : null,
    dirty: isDirty(it.syncState as never),
    ghost: it.syncState === "ghost",
  };
}
// watchFolder（网盘模型）：订阅**当前文件夹** → 立即本地帧、云端到了同一 cb 再闪。app 只知「这一夹更新了」。
//   替代 listGallery 全树列举（JRP 开夹慢的根因）；连接态 store 自持、无 ctx。folderNames = immediate 子夹名。
export function watchGalleryFolder(
  folder: string,
  cb: (snap: { path: string; items: ReturnType<typeof itemToG>[]; folderNames: string[] }) => void,
): () => void {
  const prefix = folder ? `${folder}/` : "";
  return store.watchFolder(folder, (snap) => {
    cb({
      path: snap.path,
      items: snap.items.map(itemToG),
      folderNames: snap.folders.map((f) => f.slice(prefix.length)).filter(Boolean),   // 全路径 → immediate 段
    });
  });
}
// ⛔ listGallery（全树列举）已删 2026-07-12——**库不提供廉价全库入口**（隐藏 walk 整树的代价）。
//   日常浏览走 watchGalleryFolder（单夹）；定向查 store.listFolder(path)；真要全库 app 自己递归 listFolder（成本显式）。
export const listGalleryTrash = async () => (await store.listTrash()).map((c) => ({ name: stripSessionExt(c.path || c.name || ""), local: null, cloud: c, deletedAt: 0 }));

// ---- brush-rack cloud-sync（⚠TODO：→ store.collection("brush-rack.json") 逐 brush 一 item。当前本地-only stub）----
//   rack 本地持久化在 brush-rack.ts 自管（IDB via getMeta）；此处只是它期望的 cloud-sync 面，暂 no-op。
let _rackDirty = false;
export const rackStore = {
  edit(): void { _rackDirty = true; },
  isDirty(): boolean { return _rackDirty; },
  setDirty(d: boolean): void { _rackDirty = d; },
  flush(): void { _rackDirty = false; },
  async sync(): Promise<void> { /* TODO: store.collection 逐 item 同步 */ },
  status(_ctx?: { signedIn?: boolean; online?: boolean }): string { return "local-only"; },
  configure(_c: unknown): void { /* TODO */ },
};
export const setRackDirty = (d: boolean) => rackStore.setDirty(d);
export const isRackDirty = () => rackStore.isDirty();
