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

import { isAuthConfigured, initAuth, signIn, signOut, getActiveAccount, isSignedIn } from "./auth.js";
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

export { isAuthConfigured, initAuth, signIn, signOut, getActiveAccount, isSignedIn };

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

export function clearCloudState(name) {
  try {
    localStorage.removeItem(etagKey(name));
    localStorage.removeItem(cloudDirtyKey(name));
  } catch (_) {}
}
