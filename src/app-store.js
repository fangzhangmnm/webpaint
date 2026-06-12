// app-store —— WebPaint 把 sync-store lib 接起来的唯一地方（cut-over）。
// 取代 cloud.js / auth.js / graph.js：app.js 从这里 import（多数旧名字 re-export 成 shim，
// 映射到新 lib API），所以 app.js 调用点基本不动。store.flow.push 走真编排（B1/B2/B5/C4）。
// WebPaint 专属（不 vendor）。lib 是 canonical；这里只做 config 注入 + 装配 + 兼容 shim。

import { createStore, createCloudSync, createOneDriveProvider } from "./store/index.ts";
import { CloudConflictError, CloudNameCollisionError } from "./store/cloud-sync.ts";
import { createFolderStore } from "./store/folder-store.ts";
export { resolveRef } from "./store/folder-merge.ts";   // {id,name} 引用解析（id→name 兜底），活动笔刷引用用
import { createLocalAdapter } from "./store/local-adapter.ts";
import { withBusy } from "./fullscreen-busy.ts";   // 注入给 store：用户态写流深模块强制锁屏（契约见 store.createStore）
import { listSessions, listTrashedSessions, trashSession, getCurrentSessionName } from "./session.js";
import { mergeLocalCloud, mergeTrash, classifyCloudGone } from "./gallery-model.js";
import { CLIENT_ID, SCOPES, sessionFileName, encSessionFileName, stripSessionExt } from "./config.js";
import { zipReadEntry } from "./zip.js";
import { getPassword, requestPassword, onPasswordVerified } from "./crypto-state.js";
// lib 的 graph（OneDrive transport，单一 auth）—— gallery folder 操作 + thumb byte-range 都走它。
import {
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
} from "./store/providers/graph.ts";

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
  encFileName: encSessionFileName,   // 加密容器在云端叫 <name>.zip（ADR-0012；翻转/双路径在 cloud-sync）
  contentType: "application/zip",
  appKey: "webpaint",
  match: (it) => /\.(ora|zip)$/i.test(it.name || ""),
  toName: stripSessionExt,
});

// brush-rack 单文件同步（复用 lib，fileName 固定）。
const rackSync = createCloudSync({ provider, kv: lsKv, fileName: () => "brush-rack.json", contentType: "application/json", appKey: "webpaint-rack" });

const local = createLocalAdapter();
export const store = createStore({
  cloud, local, kv: lsKv, busy: withBusy,
  // 加密 seam（ADR-0012）：之后 save/load/push/pull 对调用方全透明。store 格式盲——
  // 「ora 是 zip、里面有 Thumbnails/thumbnail.png、peek=缩略图 PNG」这些知识只活在 makePeek 这一行。
  crypt: {
    ext: "ora",
    makePeek: async (blob) => { try { return await zipReadEntry(blob, "Thumbnails/thumbnail.png"); } catch (_) { return null; } },
    getPassword, requestPassword, onPasswordVerified,   // 密码政策在 crypto-state（统一密码 + per-name 覆盖）
  },
});
export { CloudConflictError, CloudNameCollisionError };

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
// clean→dirty 门（parentBase 唯一捕获点，ADR-0016 §4）已收进 store.edit(name)（L4 ②）——
// app 编辑落地只调 _store.edit()，不再直暴露 setCloudDirty（绕过门 = 缺 parentBase footgun，已删）。
export const getKnownETag = (name) => cloud.getETag(name);
// 卸载本地（K3）/类似「本地副本不再存在」场景用：清掉指向云版的 etag+dirty。
//   留着不清：dirty 残留 → 假徽章；etag 残留 → K6 类 If-Match 误用的使能条件。
export const clearCloudState = (name) => cloud.clearState(name);

// ---- store.list seam（gallery 数据解析）----
// 本地⊕云 → 统一 item 列表 + 每项 dirty + 云端真文件夹。store 只做 acquisition+merge+status，
// **不懂「当前文件夹」**（那是 UI 概念，view-model 切片）。离线/未登录 → 只本地（cloud 留空，
// 绝不阻断）。本地读失败 → 标 localError，app 报状态。返回的 item = { name, local|null, cloud|null, dirty }，
// item.cloud 自带 { id, eTag, size, lastModifiedDateTime, path, downloadUrl? }（thumb provider 直接读）。
// cloud-gone reconciliation（ADR-0014 👻 ghost · etag-tombstone · 无 GUID；见
//   docs/reports/2026-06-10-cloud-gone-reconciliation-proposal.md）。
// 本地有 etag（曾 synced）但云端 path 没了 = 被别的设备改名/移动/删 → 孤儿：
//   · clean（无未推编辑）→ **自动收敛 drop 本地缓存 + clearState**（改名/删除有效传播、零 duplicate、无复活；
//     clean == 等同某个仍在云端改名后/或 .trash 里的版本，本地无未见字节可丢）。
//   · dirty（有未推编辑）→ 绝不 drop，标 ghost 交 UI surface（用户在重命名留存 / 丢弃间选）。
// **硬护栏**（否则一次网络抖动会全量误删）：只在云端列表权威时跑——signedIn ∧ online ∧ list 成功 ∧ 非空；
//   且 etag-presence 是唯一闸门（无 etag = 真本地文件，永不碰）。
async function reconcileCloudGone(localItems, cloudFiles, { cloudListOk, signedIn, online }) {
  // 权威闸门：未登录/离线/list 失败/空列表 → authoritative=false → classifyCloudGone 返回全空（不收敛）。
  const authoritative = !!(cloudListOk && signedIn && online && cloudFiles.length > 0);
  const cloudNames = new Set(cloudFiles.map((c) => stripSessionExt(c.path)));
  // K1（审计 2026-06-10）：**完全跳过当前画布上打开的 doc**——push 成功后的 gallery.refresh 在编辑态
  //   也会跑到这里，若把活 doc 收进回收站：之后落笔 isDirty 缺省 true → captureParent 被跳过 →
  //   push 撞 bypass 守卫卡死 + trash/IDB 双份。用共享指针（localStorage currentSessionName）而非
  //   本 tab 内存——顺带护住别的 tab 正开着的 doc。孤儿处理推迟到它不活跃时（多跳过=安全方向）。
  const activeName = getCurrentSessionName();
  const candidates = activeName ? localItems.filter((l) => l.name !== activeName) : localItems;
  const { drop, ghost } = classifyCloudGone(
    candidates.map((l) => l.name), cloudNames,
    { hasEtag: (n) => !!cloud.getETag(n), isDirty: (n) => isCloudDirty(n), authoritative },
  );
  const droppedNames = new Set(), ghostNames = new Set(ghost);
  for (const name of drop) {
    // clean 孤儿 → **移到本地回收站**（非硬删）：红线「删除=移到.trash」+ 可恢复。
    //   堵住窄丢失路径：若云端被删且云回收站也被清空，本地这份是最后副本，硬删=真丢；进回收站可救。
    //   clearState 清掉指向已消失云版的 etag（防再触发；恢复后变纯本地 item，reconcile 不再碰）。
    try { await trashSession(name); cloud.clearState(name); droppedNames.add(name); }
    catch (e) { console.warn("[gallery] cloud-gone reconcile failed:", name, e); }
  }
  return { droppedNames, ghostNames };
}

export async function listGallery({ signedIn, online } = {}) {
  let local = [], localError = null;
  try { local = await listSessions(); }
  catch (e) { localError = e; }
  let files = [], cloudFolders = [], cloudListOk = false;
  if (signedIn && online) {
    // cloudListOk 取 all.complete（**不是**「没抛错」）：listAll 内任一子树列举失败 → complete=false →
    //   partial 列表，reconcile 必须当不权威处理（partial 里「缺失」≠云端真没了，绝不据此 drop 缓存）。
    try { const all = await listCloudAll(); files = all.files; cloudFolders = all.folders; cloudListOk = all.complete; }
    catch (e) { console.warn("[gallery] cloud list failed:", e); }
  }
  // cloud-gone 收敛：drop clean 孤儿、标 dirty 孤儿为 ghost（护栏在函数内；列表不权威时整体跳过）
  const { droppedNames, ghostNames } = await reconcileCloudGone(local, files, { cloudListOk, signedIn, online });
  if (droppedNames.size) local = local.filter((l) => !droppedNames.has(l.name));
  const items = mergeLocalCloud(local, files);
  for (const it of items) {
    it.dirty = !!(it.cloud && isCloudDirty(it.name));
    it.ghost = ghostNames.has(it.name);   // dirty 孤儿（云端 path 没了但本地有未推编辑）→ UI surface
  }
  return { items, cloudFolders, localError };
}

// 回收站清单（本地 trash ⊕ 云端 trash），按 originalName 合并成统一 item（mergeTrash 纯函数）。
//   item = { name, local:{trashKey,deletedAt,thumb,size}|null, cloud:{id,name,...}|null, deletedAt }
export async function listGalleryTrash({ signedIn, online } = {}) {
  let localTrash = [];
  try { localTrash = await listTrashedSessions(); } catch (e) { console.warn("[gallery] local trash failed:", e); }
  let cloudTrash = [];
  if (signedIn && online) {
    try { cloudTrash = await listCloudTrash(); } catch (e) { console.warn("[gallery] cloud trash failed:", e); }
  }
  return mergeTrash(localTrash, cloudTrash);
}

// ---- brush-rack = Folder shape blob：{version, brushes, trash, resetAt}（brushes 名不变，旧设备仍认）；引擎内部用 items。
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
// ---- brush-rack = Folder-shape Store 实例（L4 ③：第二 Store 实例，内置 FolderFlow + busy/status/防抖 cadence）----
//   取代 pushBrushRack/pullBrushRack/_resolveRackCloudConflict 手搓栈 + app 的 _rackCloudState/_scheduleRackSync/
//   deriveRackCloudState（报告 C4：两套 sync-icon 态机合一）。dirty 单源仍是 rackSync。
//   app 经 rackStore.configure 注入 snapshot/onResult/canSync/onBusyChange（模型/UI 语义留 app）。
export const rackStore = createFolderStore({
  cloud: rackSync, name: "rack", encode: rackEncode, decode: rackDecode,
  isOnline: () => navigator.onLine !== false,
});
export const setRackDirty = (d) => rackStore.setDirty(d);
export const isRackDirty = () => rackStore.isDirty();

// ---- graph 直用（gallery folder 操作 + thumb byte-range）→ lib 的 graph（原始形态，单一 auth）----
export {
  getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches,
  downloadItemRange, downloadItemBlob, downloadRangeFromUrl, getDownloadUrl,
};
