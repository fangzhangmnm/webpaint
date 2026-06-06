// app-store —— WebPaint 把 sync-store lib 接起来的唯一地方（cut-over）。
// 取代 cloud.js / auth.js / graph.js：app.js 从这里 import（多数旧名字 re-export 成 shim，
// 映射到新 lib API），所以 app.js 调用点基本不动。store.flow.push 走真编排（B1/B2/B5/C4）。
// WebPaint 专属（不 vendor）。lib 是 canonical；这里只做 config 注入 + 装配 + 兼容 shim。

import { createStore, createCloudSync, createOneDriveProvider } from "./store/index.js";
import { CloudConflictError } from "./store/cloud-sync.js";
import { createFolderFlow } from "./store/folder-flow.js";
export { resolveRef } from "./store/folder-merge.js";   // {id,name} 引用解析（id→name 兜底），活动笔刷引用用
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
// ③ 完成：push / pull / fetchMeta / hard-delete 不再裸暴露——身份/持久化流全走 store.flow.*
//   （push/open/close/rename/saveAs/acquire/delete），红线在库内。剩下的 list/trash/rename 是
//   gallery 对「非 active item」的只读/搬运操作，仍直用 cloud.*。
export const listCloudSessionsRecursive = () => cloud.list();
// gallery：一次取齐 { files, folders }（folders 含空文件夹）。文件夹模型「云端真文件夹为准」单一真相源。
export const listCloudAll = () => cloud.listAll();
export const listCloudFolders = () => cloud.listFolders();
export const listCloudTrash = () => cloud.listTrash();
// 旧裸 cloud trash/rename/restore/purge shim 已删（trashCloudSession / restoreCloudFromTrash /
// purgeCloudTrashItem / renameCloudSession，均 0 调用方）：删/改名/还原/彻底删/清空回收站
// 全走 store.flow.*（含新 flow.emptyTrash）。缩小「能绕过 flow 的表面积」——绕过做成不可能而非靠自觉。
// 旧 isCloudDirty 在未登录时返 false（app 多处 `isSignedIn() && isCloudDirty()`，保此语义）。
export const isCloudDirty = (name) => _auth.isSignedIn() && cloud.isDirty(name);
// 经 store 的 cloudState.setDirty（**门**）：clean→dirty 边沿在此捕获 parentBase（ADR-0016 §4）。
// 绝不再直连低层 cloud.setDirty——否则编辑标脏却没锚 parentBase，下次 push 会撞 bypass 守卫。
export const setCloudDirty = (name, d) => store.cloud.setDirty(name, d);
export const getKnownETag = (name) => cloud.getETag(name);

// ---- brush-rack 单源 dirty（v2：取代 app 的 _rackDirty 双源；rackSync 是 SSoT）----
//   编辑 → setRackDirty(true)；FolderFlow.sync 成功内部清（pull/push setDirty(false)）。
export const setRackDirty = (d) => rackSync.setDirty("rack", d);
export const isRackDirty = () => rackSync.isDirty("rack");

// ---- brush-rack = Folder shape：FolderFlow（pull-merge-push，无损 union，零冲突 UI）----
// 取代 pushBrushRack/pullBrushRack/_resolveRackCloudConflict 那套手搓平行同步栈。
// cloud blob 仍是 {version, brushes, trash, resetAt}（brushes 名不变，旧设备仍认）；引擎内部用 items。
const RACK_UAT_PREHISTORY = 1;
function rackDecode(text) {
  let o; try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || !Array.isArray(o.brushes)) return null;   // 非 rack（伪在线 HTML / 截断）→ null
  return {
    version: 2,
    items: o.brushes.map((b) => (b && b.uat == null ? { ...b, uat: RACK_UAT_PREHISTORY } : b)),
    trash: Array.isArray(o.trash) ? o.trash : [],
    resetAt: o.resetAt || 0,
  };
}
function rackEncode(folder) {
  return new Blob([JSON.stringify({ version: 2, brushes: folder.items, trash: folder.trash, resetAt: folder.resetAt })], { type: "application/json" });
}
export const rackFolderFlow = createFolderFlow({
  cloud: rackSync, name: "rack", encode: rackEncode, decode: rackDecode,
  isOnline: () => navigator.onLine !== false,
});

// ---- graph 直用（gallery folder 操作 + thumb byte-range）→ lib 的 graph（原始形态，单一 auth）----
export {
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
};
