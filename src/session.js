// Session 管理：把当前 PaintDoc 序列化进 IDB / 从 IDB 还原 / 导出下载 / 分享。
//
// phase 1 单一 slot：IDB key = "current"。phase 2 (云同步) 接 sessionFileName 多 slot。
//
// **保存策略**（抄 AtlasMaker shareback TL;DR 第 2 条）：
//   - Ctrl+S 主导
//   - 3 min 兜底
//   - visibilitychange / pagehide 抢救
//   - **不要** debounce/heartbeat —— 画图工具用户预期 Blender / Photoshop 模式
//
// 幽灵 current path 陷阱（feedback-phantom-current-path memory）：
//   phase 1 只有一个 fixed slot 不涉及 rename-delete-old；不会撞。phase 2 多
//   session 时如果实现 rename，必须遵守 "_active 只在 load 成功后才升级到真实
//   path" 原则。

import { encodeDocToOra, decodeOraToDoc } from "./ora.js";
import { getSession, putSession } from "./storage.js";

const CURRENT_SLOT = "current";

/** 把 doc 序列化进 IDB "current" slot。返回 { ora: Blob } 用于状态显示 */
export async function saveCurrentSession(doc) {
  const ora = await encodeDocToOra(doc);
  const pkg = {
    name: "current",
    updatedAt: Date.now(),
    ora,                              // Blob
    // phase 1 不存 thumb；phase 2 sessions browser 时再补
  };
  await putSession(CURRENT_SLOT, pkg);
  return pkg;
}

/**
 * 启动时尝试加载 "current" slot。
 * - 没有：返回 null（caller 用 default doc）
 * - 失败：throw（caller 决定怎么 catch，per phantom-current-path 教训，
 *   失败时不要把 _active 锁死在失败的 path）
 */
export async function loadCurrentSession() {
  const pkg = await getSession(CURRENT_SLOT);
  if (!pkg || !pkg.ora) return null;
  return await decodeOraToDoc(pkg.ora);
}

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
  if (c.convertToBlob) return await c.convertToBlob({ type: mime, quality });
  return await new Promise((resolve) => c.toBlob(resolve, mime, quality));
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
