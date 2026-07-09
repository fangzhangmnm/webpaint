// app-store —— WebPaint 装配 sync-store 的唯一点（cutover：薄库 + editor-session）。
//   只做 config 注入（provider / ui bundle / crypto codec / crypt / validateAdopt）+ auth 转发 + gallery 列举适配。
//   app 只碰 store 四面（file/collection/localSettings/syncedSettings）+ editor-session。绝不裸碰 kv/IDB/graph/vendor。
import { createStore, createOneDriveProvider } from "./store/index.ts";
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

// ---- gallery 数据：统一列举（local ∪ cloud，每项带 syncState）+ cloud-gone 安全收敛（都进库）----
export async function listGallery({ signedIn, online }: { signedIn?: boolean; online?: boolean } = {}) {
  const ctx = { signedIn: !!signedIn, online: !!online };
  try { await store.reconcile(); } catch (e) { storeUI.reportError(e); }
  const { items, folders, complete } = await store.listAllItems(ctx);
  return { items, cloudFolders: folders, complete };
}
export const listGalleryTrash = () => store.listTrash();

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
