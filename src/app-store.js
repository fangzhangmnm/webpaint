// app-store —— WebPaint 把 sync-store lib 接起来的唯一地方（cut-over）。
// 取代 cloud.js / auth.js / graph.js：app.js 从这里 import（多数旧名字 re-export 成 shim，
// 映射到新 lib API），所以 app.js 调用点基本不动。store.flow.push 走真编排（B1/B2/B5/C4）。
// WebPaint 专属（不 vendor）。lib 是 canonical；这里只做 config 注入 + 装配 + 兼容 shim。

import { createStore, createCloudSync, createOneDriveProvider } from "./store/index.js";
import { CloudConflictError } from "./store/cloud-sync.js";
import { createLocalAdapter } from "./store/local-adapter.js";
import { CLIENT_ID, SCOPES, sessionFileName } from "./config.js";
// lib 的 graph（OneDrive transport，单一 auth）—— gallery folder 操作 + thumb byte-range 都走它。
import {
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
} from "./store/providers/graph.js";

// localStorage → kv port（lib 不直碰 localStorage；红线 #7）。
const lsKv = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} },
  remove: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// OneDrive provider + auth（config：clientId + vendored MSAL 脚本）。
const od = createOneDriveProvider({ clientId: CLIENT_ID, scopes: SCOPES, msalUrl: "./vendor/msal/msal-browser.min.js" });
export const provider = od.provider;
const _auth = od.auth;

// session 同步（.ora）。cloud-sync：push/pull/fetchMeta/trash/restore/purge/list/listTrash/rename/remove。
export const cloud = createCloudSync({
  provider, kv: lsKv,
  fileName: sessionFileName,
  contentType: "application/zip",
  appKey: "webpaint",
  match: (it) => /\.ora$/i.test(it.name || ""),
  toName: (path) => path.replace(/\.ora$/i, ""),
});

// brush-rack 单文件同步（复用 lib，fileName 固定）。
const rackSync = createCloudSync({ provider, kv: lsKv, fileName: () => "brush-rack.json", contentType: "application/json", appKey: "webpaint-rack" });

const local = createLocalAdapter();
export const store = createStore({ cloud, local, kv: lsKv });
export { CloudConflictError };

// ============ 兼容 shim（旧 cloud.js / auth.js / graph.js 名字 → 新 lib）============
// app.js 改 import 来源即可，调用点不动。store.flow.push 才是真编排入口（save 路径用它）。

// ---- auth（名字不变，直接转发）----
export const isAuthConfigured = () => _auth.isAuthConfigured();
export const initAuth = (...a) => _auth.initAuth(...a);
export const signIn = (...a) => _auth.signIn(...a);
export const signOut = (...a) => _auth.signOut(...a);
export const isSignedIn = () => _auth.isSignedIn();
export const getActiveAccount = () => _auth.getActiveAccount();
export const retrySilentSignIn = (...a) => _auth.retrySilentSignIn(...a);
export const getToken = (...a) => _auth.getToken(...a);
export const onAuthChanged = (cb) => _auth.onAuthChanged(cb);   // auth 可观察 seam（候选1）
export const getAuthState = () => _auth.getAuthState();

// ---- 上次登录 flag ----
export const getLastSessionSignedIn = () => lsKv.get("webpaint.lastSessionSignedIn") === "1";
export const setLastSessionSignedIn = (v) => lsKv.set("webpaint.lastSessionSignedIn", v ? "1" : "0");

// ---- session 云同步（旧名 → cloud.*）----
export const pushSession = (name, bytes, opts) => cloud.push(name, bytes, opts);
export const pullSession = (name) => cloud.pull(name);
export const pullSessionByPath = (path) => cloud.pull(String(path).replace(/\.ora$/i, ""));
export const fetchSessionMetadata = (name) => cloud.fetchMeta(name);
export const listCloudSessionsRecursive = () => cloud.list();
export const listCloudTrash = () => cloud.listTrash();
export const trashCloudSession = (name) => cloud.trash(name);
export const restoreCloudFromTrash = (itemId, targetName) => cloud.restore(itemId, targetName);
export const purgeCloudTrashItem = (itemId) => cloud.purge(itemId);
export const renameCloudSession = (oldN, newN) => cloud.rename(oldN, newN);
export const deleteCloudSession = (name) => cloud.remove(name);
// 旧 isCloudDirty 在未登录时返 false（app 多处 `isSignedIn() && isCloudDirty()`，保此语义）。
export const isCloudDirty = (name) => _auth.isSignedIn() && cloud.isDirty(name);
export const setCloudDirty = (name, d) => cloud.setDirty(name, d);
export const getKnownETag = (name) => cloud.getETag(name);

// ---- brush-rack（旧名 → brushRack.*）----
const _rackBlob = (rack) => new Blob([JSON.stringify(rack)], { type: "application/json" });
export const pushBrushRack = (rack, opts = {}) =>
  rackSync.push("rack", _rackBlob(rack), opts.force ? { baseEtag: undefined } : {});
export const pullBrushRack = async () => {
  const r = await rackSync.pull("rack");
  return r ? { rack: JSON.parse(await r.blob.text()), etag: r.item.eTag } : null;
};
export const fetchBrushRackMetadata = () => rackSync.fetchMeta("rack");
export const getBrushRackKnownETag = () => rackSync.getETag("rack");

// ---- graph 直用（gallery folder 操作 + thumb byte-range）→ lib 的 graph（原始形态，单一 auth）----
export {
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
};
