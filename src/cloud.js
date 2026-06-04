// WebPaint × OneDrive 同步层。把 .ora 当单文件推 / 拉。
//
// Layout：
//   Apps/WebPaint/<sessionName>.ora
//
// 触发策略（与本地持久化区分）：
//   - 本地 IDB save: Ctrl+S / 3-min / visibility / pagehide — 自动
//   - 云端 push / pull: 用户**显式**点按钮 — 绝不偷推
//   - autosave 永不触云（避免用户不在场时 412 冲突 + 不可见的 sibling）
//
// **冲突策略 与 AtlasMaker 不同**（per WebPaint user 决定）：
//   - push 时 If-Match 失败（412）→ **直接 throw 让用户改名**，不做 sibling-copy
//     避免 user 不在场时云端被偷动 + 不可控的 sibling 文件越积越多
//   - pull **永远 duplicate**：拉云端文件 → 用 sibling 命名落到本地 IDB
//     不覆盖本地任何既存 session，零数据丢失风险
//
// 加密 (phase 3) 暂不做。

import { isAuthConfigured, initAuth, signIn, signOut, getActiveAccount, isSignedIn, retrySilentSignIn } from "./auth.js";
import * as _realGraph from "./graph.js";
import { sessionFileName } from "./config.js";

// ---- strangler 接缝（朝 Store 抽取，见 docs/sync-store-extraction.md slice B）----
// 默认 = 真 graph + 真 isSignedIn；prod 行为不变。
// 测试注入 MockCloudProvider 的 graph 适配器 + 假签到，让真 cloud.js 跑在内存里。
// 这两个缝将来演化成 Store 的 CloudProvider 注入点。
let graph = _realGraph;
let _isSignedIn = isSignedIn;
export function __setGraph(g) { graph = g; }
export function __setSignedIn(fn) { _isSignedIn = fn; }

const ORA_CT = "application/zip";

// localStorage 缓存（per sessionName）。survive reload。
function etagKey(name) { return `webpaint.etag:${name}`; }
export function getKnownETag(name) {
  try { return localStorage.getItem(etagKey(name)) || null; } catch (_) { return null; }
}
function setKnownETag(name, eTag) {
  try {
    if (eTag) localStorage.setItem(etagKey(name), eTag);
    else localStorage.removeItem(etagKey(name));
  } catch (_) {}
}

// Cloud-dirty 标记：本地 IDB 自从上次成功推 / 拉云端之后又改过。
// 单独存（per sessionName），让 UI 在 "已保存" 之外仍能提示「云端未同步」。
function cloudDirtyKey(name) { return `webpaint.cloudDirty:${name}`; }
export function isCloudDirty(name) {
  if (!_isSignedIn()) return false;
  try {
    const v = localStorage.getItem(cloudDirtyKey(name));
    if (v === null) return true;          // 没记录 → 假定 dirty（保守）
    return v === "1";
  } catch (_) { return false; }
}
export function setCloudDirty(name, dirty) {
  try { localStorage.setItem(cloudDirtyKey(name), dirty ? "1" : "0"); } catch (_) {}
}

// 上次 session 结束时是否是登录态。给「这次离线 → 上次登录的话锁屏问」用。
// **关键**：user 选「离线」时**不**改这个 flag——意图保留。下次进还会问。
// 只有显式登录 / 登出才改。
const LAST_SIGNED_IN_KEY = "webpaint.lastSessionSignedIn";
export function getLastSessionSignedIn() {
  try { return localStorage.getItem(LAST_SIGNED_IN_KEY) === "1"; } catch (_) { return false; }
}
export function setLastSessionSignedIn(v) {
  try { localStorage.setItem(LAST_SIGNED_IN_KEY, v ? "1" : "0"); } catch (_) {}
}

// 拉云端 item metadata（含 etag + lastModified）。不下载 body，~1KB 响应。
// 失败 → throw。caller 用 try/catch 区分 offline / 404 / 401。
export async function fetchSessionMetadata(name) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await graph.getItemByPath(path);
  if (!item) return null;
  return {
    etag: item.eTag,
    lastModified: item.lastModifiedDateTime,
    size: item.size,
    item,
  };
}

export { isAuthConfigured, initAuth, signIn, signOut, getActiveAccount, isSignedIn, retrySilentSignIn };

// ----- push 当前 session 到 OneDrive -----
// 返回 { item }。412 → 抛 CloudConflictError，caller 提示用户改名 / 重 push。
export class CloudConflictError extends Error {
  constructor(message, sessionName) {
    super(message);
    this.name = "CloudConflictError";
    this.sessionName = sessionName;
  }
}

// opts.baseEtag：显式指定 If-Match 基准（Store 用每-tab 内存里的 base 传入，避免读共享 localStorage
//   导致多 tab 静默覆盖 / C4）。传了就用它（含 null=不带 If-Match=强推）；不传则回落 getKnownETag。
export async function pushSession(name, oraBlob, opts = {}) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const knownETag = ("baseEtag" in opts) ? opts.baseEtag : getKnownETag(name);
  try {
    const item = await graph.uploadFileToApproot(path, oraBlob, ORA_CT, {
      conflictBehavior: "replace",
      eTag: knownETag,                    // 首次推 null → 服务器接受
    });
    setKnownETag(name, item.eTag);
    setCloudDirty(name, false);
    return { item };
  } catch (e) {
    if (e.status === 412) {
      throw new CloudConflictError(
        `云端已有更新版本 "${name}"。请另存为新名字后再推送。`,
        name,
      );
    }
    throw e;
  }
}

// ----- pull 云端 session（**永远** duplicate 进本地，不覆盖任何既存） -----
// 返回 { blob, item, suggestedName }。caller 负责 decode + 落地 IDB（用建议的新名）。
export async function pullSession(name) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await graph.getItemByPath(path);
  if (!item) return null;
  const blob = await graph.downloadItemBlob(item.id);
  setKnownETag(name, item.eTag);
  setCloudDirty(name, false);
  return { blob, item, suggestedName: name };
}

// 用路径拉（含子文件夹的 "characters/wall.ora"）
export async function pullSessionByPath(path) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const item = await graph.getItemByPath(path);
  if (!item) return null;
  const blob = await graph.downloadItemBlob(item.id);
  const stem = path.replace(/\.ora$/i, "");
  setKnownETag(stem, item.eTag);
  setCloudDirty(stem, false);
  return { blob, item, suggestedName: stem };
}

// ----- 列云端所有 .ora -----
export async function listCloudSessions() {
  if (!_isSignedIn()) return [];
  const items = await graph.listChildren();
  return items.filter((it) => it.file && /\.ora$/i.test(it.name));
}

// 递归（含子文件夹）—— 顶层 `.trash` 不进
const CLOUD_TRASH_FOLDER = ".trash";
export async function listCloudSessionsRecursive() {
  if (!_isSignedIn()) return [];
  const out = [];
  await _walkApproot("", out);
  return out;
}
async function _walkApproot(subpath, out, depth = 0) {
  if (depth > 8) return;
  let items;
  try { items = await graph.listChildren(subpath); }
  catch (e) { console.warn("listChildren failed at", subpath, e); return; }
  for (const it of items) {
    if (depth === 0 && it.folder && it.name === CLOUD_TRASH_FOLDER) continue;
    const itPath = subpath ? `${subpath}/${it.name}` : it.name;
    if (it.folder) {
      await _walkApproot(itPath, out, depth + 1);
    } else if (it.file && /\.ora$/i.test(it.name)) {
      out.push({ ...it, path: itPath });
    }
  }
}

// 列云端 trash 里的 ora
export async function listCloudTrash() {
  if (!_isSignedIn()) return [];
  try {
    const items = await graph.listChildren(CLOUD_TRASH_FOLDER);
    return items.filter((it) => it.file && /\.ora$/i.test(it.name));
  } catch (e) {
    console.warn("listCloudTrash failed:", e);
    return [];
  }
}

// ----- 重命名云端 session（支持跨 folder move）-----
// caller 已确保 newName 在云端不冲突
// 同 folder → PATCH name；跨 folder → move + rename（自动 ensureSubfolder 新 folder）
export async function renameCloudSession(oldName, newName) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  if (oldName === newName) return;
  const path = sessionFileName(oldName);
  const item = await graph.getItemByPath(path);
  if (!item) throw new Error(`云端找不到：${oldName}`);
  const oldFolder = oldName.includes("/") ? oldName.slice(0, oldName.lastIndexOf("/")) : "";
  const newFolder = newName.includes("/") ? newName.slice(0, newName.lastIndexOf("/")) : "";
  const newBaseName = sessionFileName(newName.includes("/") ? newName.slice(newName.lastIndexOf("/") + 1) : newName);
  if (oldFolder === newFolder) {
    // 同 folder → 仅改名
    await graph.renameItem(item.id, newBaseName);
  } else {
    // 跨 folder → ensureSubfolder + move
    const targetFolderId = newFolder ? await graph.ensureSubfolder(newFolder) : await graph.getApprootId();
    await graph.moveItemToFolder(item.id, targetFolderId, { newName: newBaseName, conflictBehavior: "fail" });
  }
  // 迁移本地 etag/dirty key（基于 name）
  const eTag = getKnownETag(oldName);
  if (eTag) setKnownETag(newName, eTag);
  clearCloudState(oldName);
}

// ----- 删除云端 session (硬删，DELETE → OneDrive 自然回收) -----
export async function deleteCloudSession(name) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await graph.getItemByPath(path);
  if (item) await graph.deleteItem(item.id);
  clearCloudState(name);
}

// 永久删 trash 内一个 item（用 itemId，因为 trash 内 path 不固定）
export async function purgeCloudTrashItem(itemId) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  await graph.deleteItem(itemId);
}

// 移到 .trash：原 path 文件 → graph.ensureSubfolder(".trash") → move
// **始终加 timestamp 后缀** "<name> [<ts>].ora" → 多次删同名永不冲突，最鲁棒
// 恢复时 listCloudTrash 会剥掉 [ts] 拿原名
export async function trashCloudSession(name) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await graph.getItemByPath(path);
  if (!item) { clearCloudState(name); return null; }   // 云端没这个文件 → 无操作
  const trashFolderId = await graph.ensureSubfolder(CLOUD_TRASH_FOLDER);
  // newName 必须是 basename（不能含 /），子文件夹的 folder context 在 trash 内丢失
  const baseName = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const stampedName = `${baseName} [${Date.now()}].ora`;
  const moved = await graph.moveItemToFolder(item.id, trashFolderId, { newName: stampedName, conflictBehavior: "fail" });
  clearCloudState(name);
  return moved;
}

// 从 trash 恢复：把 itemId 移回 approot 原 folder（targetName 含 folder path → 自动 ensureSubfolder）
// conflictBehavior=fail 防覆盖目标位置的同名文件（关键：data-loss 风险点）
// caller 已算好不冲突的 targetName；如果还是冲突 → 服务器抛 409 → 加 (2)(3)... 后缀重试
export async function restoreCloudFromTrash(itemId, targetName) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  // targetName 可能含 folder：拆 folder + basename
  const cleanName = targetName.replace(/\.ora$/i, "");
  const targetFolder = cleanName.includes("/") ? cleanName.slice(0, cleanName.lastIndexOf("/")) : "";
  const baseName = cleanName.includes("/") ? cleanName.slice(cleanName.lastIndexOf("/") + 1) : cleanName;
  const folderId = targetFolder ? await graph.ensureSubfolder(targetFolder) : await graph.ensureSubfolder("");
  // 候选名循环防冲突（newName 只能是 basename 不含 /）
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate = attempt === 1 ? baseName : `${baseName} (${attempt})`;
    const fileName = `${candidate}.ora`;
    try {
      return await graph.moveItemToFolder(itemId, folderId, { newName: fileName, conflictBehavior: "fail" });
    } catch (e) {
      if (e.status === 409 || e.status === 412) continue;
      throw e;
    }
  }
  return await graph.moveItemToFolder(itemId, folderId, { newName: `${baseName} [${Date.now()}].ora`, conflictBehavior: "fail" });
}

// ============ Brush rack 云同步（v84）============
// 单文件 Apps/WebPaint/brush-rack.json。低频改动，跟 doc 同模式：ETag 防并发覆盖。
// user 指示：「不进行笔刷整理或者笔刷设置操作不 sync 云。操作的时候只有点保存退出 UI 才 sync 云」
// → 整理 / 设置只写 IDB；关 rack sheet / 关 settings view 时才推云。

const BRUSH_RACK_NAME = "brush-rack";
const BRUSH_RACK_PATH = "brush-rack.json";
const BRUSH_RACK_CT = "application/json";

// v134 opts.force = true 跳过 ETag 检查（本地覆盖云端，强推）
export async function pushBrushRack(rack, opts = {}) {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const knownETag = opts.force ? undefined : getKnownETag(BRUSH_RACK_NAME);
  const json = JSON.stringify(rack);
  const blob = new Blob([json], { type: BRUSH_RACK_CT });
  try {
    const item = await graph.uploadFileToApproot(BRUSH_RACK_PATH, blob, BRUSH_RACK_CT, {
      conflictBehavior: "replace",
      eTag: knownETag,
    });
    setKnownETag(BRUSH_RACK_NAME, item.eTag);
    return { item };
  } catch (e) {
    if (e.status === 412) {
      throw new CloudConflictError(`云端笔架已被改过`, BRUSH_RACK_NAME);
    }
    throw e;
  }
}

export async function pullBrushRack() {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const item = await graph.getItemByPath(BRUSH_RACK_PATH);
  if (!item) return null;
  const blob = await graph.downloadItemBlob(item.id);
  setKnownETag(BRUSH_RACK_NAME, item.eTag);
  const text = await blob.text();
  return { rack: JSON.parse(text), etag: item.eTag };
}

export async function fetchBrushRackMetadata() {
  if (!_isSignedIn()) throw new Error("未登录 OneDrive");
  const item = await graph.getItemByPath(BRUSH_RACK_PATH);
  if (!item) return null;
  return { etag: item.eTag, lastModified: item.lastModifiedDateTime };
}

export function getBrushRackKnownETag() {
  return getKnownETag(BRUSH_RACK_NAME);
}

export function clearCloudState(name) {
  try {
    localStorage.removeItem(etagKey(name));
    localStorage.removeItem(cloudDirtyKey(name));
  } catch (_) {}
}
