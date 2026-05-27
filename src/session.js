// Session 管理：把当前 PaintDoc 序列化进 IDB / 从 IDB 还原 / 导出下载 / 分享。
//
// **多 session（v36 起）**：IDB key = sessionName。localStorage 记当前 name。
// 默认 "未命名"。重名直接覆盖。
//
// **保存策略**（抄 AtlasMaker shareback TL;DR 第 2 条）：
//   - Ctrl+S 主导
//   - 3 min 兜底
//   - visibilitychange / pagehide 抢救
//   - **不要** debounce/heartbeat —— 画图工具用户预期 Blender / Photoshop 模式
//
// 幽灵 current path 陷阱（feedback-phantom-current-path memory）：
//   - boot load 失败时**不要**重置 localStorage（用户下次冷启动能重试）
//   - 但内存里 _activeSessionName 用 safe default，避免 save 走 rename 路径
//     把"加载失败的 path"当 oldName 删掉

import { encodeDocToOra, decodeOraToDoc } from "./ora.js";
import { getSession, putSession, deleteSession, listSessionIds } from "./storage.js";

const LS_CURRENT_NAME = "webpaint.currentSessionName";
const DEFAULT_NAME = "未命名";
const LEGACY_SLOT = "current";   // 旧 v35 单 slot key；冷启动会迁移到 DEFAULT_NAME

export function getCurrentSessionName() {
  try { return localStorage.getItem(LS_CURRENT_NAME) || DEFAULT_NAME; }
  catch { return DEFAULT_NAME; }
}
export function setCurrentSessionName(name) {
  try { localStorage.setItem(LS_CURRENT_NAME, name); } catch {}
}

/** 把 doc 序列化进指定 session（默认当前），同时生成 thumb jpg 存进 pkg */
export async function saveSession(doc, name) {
  const sessionName = name || getCurrentSessionName();
  const [ora, thumb] = await Promise.all([
    encodeDocToOra(doc),
    renderThumbBlob(doc, 256),
  ]);
  const pkg = {
    name: sessionName,
    updatedAt: Date.now(),
    ora,
    thumb,            // Blob (image/jpeg, ~5-15KB)
  };
  await putSession(sessionName, pkg);
  return pkg;
}

/** 渲染缩略图 jpg blob（最长边 = maxSide）。给图库 grid 用。 */
async function renderThumbBlob(doc, maxSide = 256) {
  // Render merged at doc resolution
  const W = doc.width, H = doc.height;
  const merged = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(W, H)
    : (() => { const x = document.createElement("canvas"); x.width = W; x.height = H; return x; })();
  const mctx = merged.getContext("2d");
  mctx.fillStyle = doc.backgroundColor || "#ffffff";
  mctx.fillRect(0, 0, W, H);
  for (const L of doc.layers) {
    if (!L.visible || L.bboxW <= 0 || L.bboxH <= 0) continue;
    const pa = mctx.globalAlpha, pc = mctx.globalCompositeOperation;
    mctx.globalAlpha = L.opacity;
    mctx.globalCompositeOperation = L.mode || "source-over";
    mctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    mctx.globalAlpha = pa;
    mctx.globalCompositeOperation = pc;
  }
  // Downscale
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const tw = Math.max(1, Math.round(W * scale));
  const th = Math.max(1, Math.round(H * scale));
  const thumb = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(tw, th)
    : (() => { const x = document.createElement("canvas"); x.width = tw; x.height = th; return x; })();
  const tctx = thumb.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(merged, 0, 0, tw, th);
  if (typeof thumb.convertToBlob === "function") {
    return await thumb.convertToBlob({ type: "image/jpeg", quality: 0.78 });
  }
  return await new Promise((resolve) => thumb.toBlob(resolve, "image/jpeg", 0.78));
}

/** 列所有 session 元信息（name + updatedAt + size + thumb Blob）。不解码 .ora。 */
export async function listSessions() {
  const ids = await listSessionIds();
  const out = [];
  for (const id of ids) {
    if (id === LEGACY_SLOT) continue;   // 迁移完后旧 slot 会被删，这里 fallback
    const pkg = await getSession(id);
    if (!pkg) continue;
    out.push({
      name: id,
      updatedAt: pkg.updatedAt || 0,
      size: (pkg.ora && pkg.ora.size) || 0,
      thumb: pkg.thumb || null,         // v36 之前的 pkg 没 thumb，UI 给占位
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * 启动时加载当前 session。
 * - currentName 在 IDB 有 → 返回 decoded doc
 * - currentName 在 IDB 没 → 尝试 legacy "current" slot 迁移
 * - 都没 → 返回 null
 */
export async function loadCurrentSession() {
  const name = getCurrentSessionName();
  let pkg = await getSession(name);
  if (!pkg) {
    // v35 → v36 迁移：从旧 "current" key 拉一次，写到 DEFAULT_NAME 下，删旧 key
    pkg = await getSession(LEGACY_SLOT);
    if (pkg) {
      pkg.name = DEFAULT_NAME;
      await putSession(DEFAULT_NAME, pkg);
      await deleteSession(LEGACY_SLOT);
      setCurrentSessionName(DEFAULT_NAME);
    }
  }
  if (!pkg || !pkg.ora) return null;
  return await decodeOraToDoc(pkg.ora);
}

/** 主动按 name 打开。返回 decoded doc 或 null（不存在）。 */
export async function openSession(name) {
  const pkg = await getSession(name);
  if (!pkg || !pkg.ora) return null;
  return await decodeOraToDoc(pkg.ora);
}

export async function removeSession(name) {
  await deleteSession(name);
}

/** Save As：把 doc 写到新 name 下。**不删旧的**。caller 决定切到新 name。 */
export async function saveAsSession(doc, name) {
  return await saveSession(doc, name);
}

// 兼容 v35 命名（app.js 旧 import）
export const saveCurrentSession = saveSession;

/** 导出 .ora 到本地下载 */
export async function exportOraDownload(doc, filename = "未命名.ora") {
  const blob = await encodeDocToOra(doc);
  triggerDownload(blob, filename);
}

// ---- 分享 / 导出 PNG / JPG ----

/** 用 ora.js 同一个 merged 渲染逻辑（doc + bg + 各 layer composite）。 */
async function renderMergedBlob(doc, mime = "image/png", quality) {
  // 重写一遍而不是导出 ora.js 的 renderMerged，因为我们需要 Blob 不是 canvas，
  // 且 ora.js 没 export 那个 helper。简化：直接用同样的逻辑这里复写一遍。
  const c = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(doc.width, doc.height)
    : (() => {
        const x = document.createElement("canvas");
        x.width = doc.width; x.height = doc.height;
        return x;
      })();
  const ctx = c.getContext("2d");
  ctx.fillStyle = doc.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, doc.width, doc.height);
  for (const L of doc.layers) {
    if (!L.visible) continue;
    if (L.bboxW <= 0 || L.bboxH <= 0) continue;
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    ctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  if (typeof c.convertToBlob === "function") return await c.convertToBlob({ type: mime, quality });
  if (typeof c.toBlob === "function") return await new Promise((resolve) => c.toBlob(resolve, mime, quality));
  throw new Error("canvas 无 toBlob / convertToBlob");
}

/**
 * 分享 / 保存合成图。优先 navigator.share（iPad / Android 弹系统分享面板 → 相册
 * / iMessage / ...）。不支持时 fallback 触发下载到 Downloads 目录。
 */
export async function shareOrDownloadImage(doc, format = "png", filename = "WebPaint") {
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const ext  = format === "jpg" ? "jpg" : "png";
  const quality = format === "jpg" ? 0.92 : undefined;
  const blob = await renderMergedBlob(doc, mime, quality);
  const fname = `${filename}.${ext}`;
  const file = new File([blob], fname, { type: mime });

  // 优先 Web Share Level 2（支持 files）
  if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return { method: "share" };
    } catch (e) {
      // 用户取消 = AbortError，不报错；其他错降级到 download
      if (e && e.name === "AbortError") return { method: "cancel" };
      // 失败 fall through 到 download
    }
  }
  triggerDownload(blob, fname);
  return { method: "download" };
}

// ---- 工具 ----

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 100ms 后 revoke，给浏览器一点点时间发起下载
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
