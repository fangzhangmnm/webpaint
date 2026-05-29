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
import { listChildren, getItemByPath, downloadItemBlob, uploadFileToApproot, deleteItem } from "./graph.js";
import { sessionFileName } from "./config.js";

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
  if (!isSignedIn()) return false;
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
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await getItemByPath(path);
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

export async function pushSession(name, oraBlob) {
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const knownETag = getKnownETag(name);
  try {
    const item = await uploadFileToApproot(path, oraBlob, ORA_CT, {
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
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await getItemByPath(path);
  if (!item) return null;
  const blob = await downloadItemBlob(item.id);
  setKnownETag(name, item.eTag);
  setCloudDirty(name, false);
  return { blob, item, suggestedName: name };
}

// 用路径拉（含子文件夹的 "characters/wall.ora"）
export async function pullSessionByPath(path) {
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const item = await getItemByPath(path);
  if (!item) return null;
  const blob = await downloadItemBlob(item.id);
  const stem = path.replace(/\.ora$/i, "");
  setKnownETag(stem, item.eTag);
  setCloudDirty(stem, false);
  return { blob, item, suggestedName: stem };
}

// ----- 列云端所有 .ora -----
export async function listCloudSessions() {
  if (!isSignedIn()) return [];
  const items = await listChildren();
  return items.filter((it) => it.file && /\.ora$/i.test(it.name));
}

// 递归（含子文件夹）
export async function listCloudSessionsRecursive() {
  if (!isSignedIn()) return [];
  const out = [];
  await _walkApproot("", out);
  return out;
}
async function _walkApproot(subpath, out, depth = 0) {
  if (depth > 8) return;
  let items;
  try { items = await listChildren(subpath); }
  catch (e) { console.warn("listChildren failed at", subpath, e); return; }
  for (const it of items) {
    const itPath = subpath ? `${subpath}/${it.name}` : it.name;
    if (it.folder) {
      await _walkApproot(itPath, out, depth + 1);
    } else if (it.file && /\.ora$/i.test(it.name)) {
      out.push({ ...it, path: itPath });
    }
  }
}

// ----- 删除云端 session -----
export async function deleteCloudSession(name) {
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const path = sessionFileName(name);
  const item = await getItemByPath(path);
  if (item) await deleteItem(item.id);
  clearCloudState(name);
}

// ============ Brush rack 云同步（v84）============
// 单文件 Apps/WebPaint/brush-rack.json。低频改动，跟 doc 同模式：ETag 防并发覆盖。
// user 指示：「不进行笔刷整理或者笔刷设置操作不 sync 云。操作的时候只有点保存退出 UI 才 sync 云」
// → 整理 / 设置只写 IDB；关 rack sheet / 关 settings view 时才推云。

const BRUSH_RACK_NAME = "brush-rack";
const BRUSH_RACK_PATH = "brush-rack.json";
const BRUSH_RACK_CT = "application/json";

export async function pushBrushRack(rack) {
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const knownETag = getKnownETag(BRUSH_RACK_NAME);
  const json = JSON.stringify(rack);
  const blob = new Blob([json], { type: BRUSH_RACK_CT });
  try {
    const item = await uploadFileToApproot(BRUSH_RACK_PATH, blob, BRUSH_RACK_CT, {
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
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const item = await getItemByPath(BRUSH_RACK_PATH);
  if (!item) return null;
  const blob = await downloadItemBlob(item.id);
  setKnownETag(BRUSH_RACK_NAME, item.eTag);
  const text = await blob.text();
  return { rack: JSON.parse(text), etag: item.eTag };
}

export async function fetchBrushRackMetadata() {
  if (!isSignedIn()) throw new Error("未登录 OneDrive");
  const item = await getItemByPath(BRUSH_RACK_PATH);
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
