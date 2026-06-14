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
import { looksEncryptedContainer } from "./crypto-format.js";
import { smartResample, canvasToBlob } from "./resample.js";
import { getSession, putSession, deleteSession, listSessionIds, renameSessionKey } from "./storage.js";
import { LOCAL_BACKUP_PREFIX } from "./store/move-aside.ts";   // 深模块的隐藏命名空间约定（backup 不进图库）

const LS_CURRENT_NAME = "webpaint.currentSessionName";
const DEFAULT_NAME = "未命名";
const LEGACY_SLOT = "current";   // 旧 v35 单 slot key；冷启动会迁移到 DEFAULT_NAME

// gallery-first: 空字符串 = 没活动 session（在 gallery）。
// 老 user 没 set 过 → null → 返 ""（停 gallery，等用户选）
export function getCurrentSessionName() {
  try { return localStorage.getItem(LS_CURRENT_NAME) || ""; }
  catch { return ""; }
}
export function setCurrentSessionName(name) {
  try { localStorage.setItem(LS_CURRENT_NAME, name); } catch {}
}

/** 把 doc 序列化进指定 session（默认当前），同时生成 thumb 存进 pkg。
 *  **仅限明文新建路径**（newDoc / saveAs 的新名字天然明文）——活动 doc 的常规保存
 *  走 store.flow.save（v235：加密包壳在深模块，这里不感知加密）。
 *  opts.referenceImage: optional Blob —— 嵌进 .ora 跟着文件走（webpaint/reference.png）。
 *  opts.webpaintState:  optional 对象，进 webpaint/state.json
 */
export async function saveSession(doc, name, opts = {}) {
  const sessionName = name || getCurrentSessionName();
  const [ora, thumb] = await Promise.all([
    encodeDocToOra(doc, {
      referenceImage: opts.referenceImage,
      webpaintState: opts.webpaintState,
    }),
    renderThumbBlob(doc, 256),
  ]);
  return await putSessionPkg(sessionName, ora, thumb);
}

/** **单一本地落盘点**：组 pkg（name/updatedAt/ora/thumb）+ 原子 putSession。
 *  两条路共用——saveSession（活 doc 算 ora+thumb，热路径不解码）与 LocalAdapter
 *  （Store 流：bytes 解码渲 thumb，冷路径）。pkg 结构只在这里定义一次。 */
export async function putSessionPkg(name, ora, thumb = null) {
  const pkg = { name, updatedAt: Date.now(), ora, thumb };
  await putSession(name, pkg);
  return pkg;
}

/** 渲染缩略图 blob（最长边 = maxSide）。给图库 grid 用。
 *  PNG 保留 alpha → 容器 CSS 背景可独立调色，立绘透明区跟容器自然融合。
 */
export async function renderThumbBlob(doc, maxSide = 256) {
  const W = doc.width, H = doc.height;
  const merged = document.createElement("canvas");
  merged.width = W; merged.height = H;
  const mctx = merged.getContext("2d");
  // 不涂底：保 alpha，PNG 编码透出来 → 容器 CSS bg 直接生效（调色不用改 JS）
  for (const L of doc.layers) {
    if (!L.visible || L.bboxW <= 0 || L.bboxH <= 0) continue;
    const pa = mctx.globalAlpha, pc = mctx.globalCompositeOperation;
    mctx.globalAlpha = L.opacity;
    mctx.globalCompositeOperation = L.mode || "source-over";
    mctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    mctx.globalAlpha = pa;
    mctx.globalCompositeOperation = pc;
  }
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const tw = Math.max(1, Math.round(W * scale));
  const th = Math.max(1, Math.round(H * scale));
  // step-halving 缩小（抗锯齿，缩略图更干净）；scale=1（doc 比 maxSide 小）时 smartResample 直接收尾不失真
  const thumb = smartResample(merged, tw, th);

  // PNG 保 alpha；体积通常 5-25KB（立绘透明区压缩好），可接受
  return await canvasToBlob(thumb, "image/png");
}

/** trash 用 key prefix。delete 时 rename 到 trash:<timestamp>-<counter>:<name>，恢复时 rename 回。
 *  counter 防同 ms 内多次 trash 同名冲突（Date.now() ms 级 + 自增 counter 永不重复）。 */
const TRASH_PREFIX = "trash:";
let _trashCounter = 0;
function makeTrashKey(name) {
  return `${TRASH_PREFIX}${Date.now()}-${++_trashCounter}:${name}`;
}
function isTrashKey(key) { return typeof key === "string" && key.startsWith(TRASH_PREFIX); }
function parseTrashKey(key) {
  // trash:<ts>[-<counter>]:<originalName>。counter 段可选（旧记录无）。name 可能含 ":"
  const m = /^trash:(\d+)(?:-\d+)?:(.+)$/s.exec(key);
  if (!m) return null;
  return { deletedAt: Number(m[1]), originalName: m[2] };
}
// 本地 backup 的命名/防撞/命名空间策略在深模块（src/store/move-aside.js + local-adapter）。
// 这里只消费它的前缀常量，把这道隐藏命名空间从图库列表过滤掉（覆盖前留底，不该 flood 用户文件夹）。

/** 本地原子重命名（atomic put new + delete old）。同名抛 destination-exists。 */
export async function renameLocalSession(oldName, newName) {
  if (oldName === newName) return;
  await renameSessionKey(oldName, newName);
}

/** 列所有 session 元信息（name + updatedAt + size + thumb Blob + encrypted）。不解码 .ora。
 *  默认过滤 trash:* keys；要看 trash 用 listTrashedSessions */
// 加密探测 memo：尾部 96KB 扫一次 MAGIC 就够，但图库每次 reload 都列 → 按 (name, updatedAt, size) 缓存
const _encDetectMemo = new Map();
async function _detectEncrypted(id, pkg) {
  if (!pkg.ora) return false;
  const key = `${id}\x00${pkg.updatedAt || 0}\x00${pkg.ora.size || 0}`;
  const hit = _encDetectMemo.get(key);
  if (hit !== undefined) return hit;
  let enc = false;
  try { enc = await looksEncryptedContainer(pkg.ora); } catch (_) {}
  _encDetectMemo.set(key, enc);
  return enc;
}
export async function listSessions() {
  const ids = await listSessionIds();
  const out = [];
  for (const id of ids) {
    if (id === LEGACY_SLOT) continue;
    if (isTrashKey(id)) continue;                       // trash 单独列
    if (id.startsWith(LOCAL_BACKUP_PREFIX)) continue;   // .backup-local/ 隐藏安全网（深模块所有），不进图库
    const pkg = await getSession(id);
    if (!pkg) continue;
    out.push({
      name: id,
      updatedAt: pkg.updatedAt || 0,
      size: (pkg.ora && pkg.ora.size) || 0,
      thumb: pkg.thumb || null,
      encrypted: await _detectEncrypted(id, pkg),
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 列 trash 内 sessions。返 [{ trashKey, originalName, deletedAt, thumb, size }] */
export async function listTrashedSessions() {
  const ids = await listSessionIds();
  const out = [];
  for (const id of ids) {
    if (!isTrashKey(id)) continue;
    const parsed = parseTrashKey(id);
    if (!parsed) continue;
    const pkg = await getSession(id);
    if (!pkg) continue;
    out.push({
      trashKey: id,
      originalName: parsed.originalName,
      deletedAt: parsed.deletedAt,
      size: (pkg.ora && pkg.ora.size) || 0,
      thumb: pkg.thumb || null,
    });
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

/** 软删：把本地 session rename 到 trash:<ts>:<name>。返 trashKey */
export async function trashSession(name) {
  const trashKey = makeTrashKey(name);
  await renameSessionKey(name, trashKey);
  return trashKey;
}

/** 从 trash 恢复。如果 originalName 冲突（同名 active session 存在）→ 自动加 (2)(3)... 后缀。
 *  返实际恢复的 name */
export async function restoreSession(trashKey) {
  const parsed = parseTrashKey(trashKey);
  if (!parsed) throw new Error("非 trash key");
  let target = parsed.originalName;
  const existing = new Set(await listSessionIds());
  if (existing.has(target)) {
    for (let i = 2; i < 1000; i++) {
      const candidate = `${parsed.originalName} (${i})`;
      if (!existing.has(candidate)) { target = candidate; break; }
    }
  }
  await renameSessionKey(trashKey, target);
  return target;
}

/** 永久删 trash 里一条 */
export async function purgeFromTrash(trashKey) {
  if (!isTrashKey(trashKey)) throw new Error("非 trash key");
  await deleteSession(trashKey);
}

/** 清空整个 trash */
export async function emptyTrash() {
  const ids = await listSessionIds();
  for (const id of ids) {
    if (isTrashKey(id)) await deleteSession(id);
  }
}

// loadCurrentSession / openSession 已退役（v235）：本地读取统一走 store.flow.load
// （加密容器自动解壳）。boot 在 app.js、打开在 session-state.openItem。
// 旧 v35 单 slot 迁移随之退役（所有设备 ≥ v36 已久；LEGACY_SLOT 常量留 listSessions 过滤用）。

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

/** 导出 .psd 到本地下载（最小子集：raster layer + bbox + blend mode + opacity + name）。
 *  Photoshop / Affinity / Procreate / Krita 都吃。详见 src/psd.js */
export async function exportPsdDownload(doc, filename = "未命名.psd") {
  const { encodeDocToPsd } = await import("./psd.js");
  const blob = await encodeDocToPsd(doc);
  triggerDownload(blob, filename);
}

// ---- 分享 / 导出 PNG / JPG ----

/** 渲染合成图 blob（分享 PNG/JPG 用）。全走 HTMLCanvasElement.toBlob，
 *  避开 Safari OffscreenCanvas.convertToBlob JPEG 返 null 的 bug。 */
// v124 加 scope 参数 (user)：
//   "merged" (default) = 所有可见层 + doc 背景（兼容旧行为）
//   "active" = 仅当前 active layer。JPG 仍涂 doc 背景（无 alpha）；PNG 保 alpha
// candidate 2：导出格式（png/jpg exporter）只负责把 doc 渲成 image blob；
// 去向（分享/下载/剪贴板）是正交的 sink，见 shareOrDownloadBlob。故此函数公开。
export async function renderDocToImageBlob(doc, mime = "image/png", quality, scope = "merged") {
  const c = document.createElement("canvas");
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext("2d");
  // v134 (user：「导出 png 保留透明度！！」) 只 JPG 涂 doc 背景（无 alpha 通道）
  //   PNG 永远不涂，empty 区域 = 透明，user 想要白底自己加图层
  const wantBg = mime === "image/jpeg";
  if (wantBg) {
    ctx.fillStyle = doc.backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  const layers = scope === "active"
    ? (doc.activeLayer ? [doc.activeLayer] : [])
    : doc.layers;
  // v258：导出合成 respect 剪裁蒙版（对齐屏幕渲染 board.js）。
  //   剪裁基底解析同 doc.computeClipBaseFor：剪裁层往下找最近的「非剪裁、可见、非空」层当基底，
  //   连续剪裁链共用同一基底，无基底则当普通层。基底必须可见且非空。
  //   合成时剪裁层先 dst-in 裁到其基底 canvas 的 alpha（只在基底不透明处可见），再按 mode×opacity 叠。
  //   scope==="active" 单层导出：列表里没有基底 → 剪裁层当普通层画（最简单语义）。
  const drawNormal = (L) => {
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    ctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  };
  // 解析每个 layer 的剪裁基底（-1 = 无基底，按普通层画）。仅在多层 scope 下生效。
  const clipBase = new Array(layers.length).fill(-1);
  if (scope !== "active") {
    let currentBase = -1;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const nonEmptyVisible = L.visible && L.bboxW > 0 && L.bboxH > 0;
      if (L.clippingMask && currentBase >= 0) {
        clipBase[i] = currentBase;
      } else {
        clipBase[i] = -1;
        if (!L.clippingMask && nonEmptyVisible) currentBase = i;
      }
    }
  }
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (!L.visible) continue;
    if (L.bboxW <= 0 || L.bboxH <= 0) continue;
    const baseIdx = clipBase[i];
    if (baseIdx < 0) { drawNormal(L); continue; }
    // 剪裁层：在离屏上画 L → dst-in 基底 alpha → 把结果按 L.mode×opacity 叠到输出。
    const base = layers[baseIdx];
    const off = document.createElement("canvas");
    off.width = doc.width;
    off.height = doc.height;
    const octx = off.getContext("2d");
    octx.drawImage(L.canvas, L.bboxX, L.bboxY);
    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(base.canvas, base.bboxX, base.bboxY);
    octx.globalCompositeOperation = "source-over";
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    ctx.drawImage(off, 0, 0);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  const blob = await new Promise((resolve) => c.toBlob(resolve, mime, quality));
  if (blob) return blob;
  // jpg 返 null 兜底走 png
  if (mime !== "image/png") {
    return await new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }
  throw new Error("canvas.toBlob 返 null");
}

// 只有移动端（iOS/iPadOS/Android）才优先 share（→ 相册/Files 才是自然"保存"路径）。
// 桌面（Windows/Mac/Linux）的 share 面板不能存文件（user：「windows 的 share 没有保存」）→ 直接下载。
function _prefersShare() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ 伪装成 MacIntel 桌面 UA，但有多点触控
  if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

/**
 * 分享 / 保存合成图。移动端优先 navigator.share（→ 相册 / Files）；桌面直接下载到 Downloads。
 */
// 平台 sink（与格式正交）：移动端优先 navigator.share（→ 相册/Files）；桌面/降级直接下载。
// candidate 2：exporter 产 blob，这里只决定去哪。filename 含扩展名。
//   → { method: "share" | "cancel" | "download" }
export async function shareOrDownloadBlob(blob, filename, mime) {
  const file = new File([blob], filename, { type: mime || blob.type || "application/octet-stream" });
  if (_prefersShare() && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return { method: "share" };
    } catch (e) {
      // 用户取消 = AbortError，不报错；其他错降级到 download
      if (e && e.name === "AbortError") return { method: "cancel" };
      // 失败 fall through 到 download
    }
  }
  triggerDownload(blob, filename);
  return { method: "download" };
}

export async function shareOrDownloadImage(doc, format = "png", filename = "WebPaint", scope = "merged") {
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const ext  = format === "jpg" ? "jpg" : "png";
  const quality = format === "jpg" ? 0.92 : undefined;
  const blob = await renderDocToImageBlob(doc, mime, quality, scope);
  return shareOrDownloadBlob(blob, `${filename}.${ext}`, mime);
}

// ---- 剪贴板 IO ----

/** 把 doc 合成图复制到剪贴板（PNG）。iPad Safari / 桌面都支持。 */
export async function copyImageToClipboard(doc, scope = "merged") {
  if (!navigator.clipboard || !navigator.clipboard.write) {
    throw new Error("浏览器不支持剪贴板写入");
  }
  const blob = await renderDocToImageBlob(doc, "image/png", undefined, scope);
  if (!blob) throw new Error("生成 PNG 失败");
  // ClipboardItem 在 Safari 必须用 lazy promise 写法（write 在 user gesture 内）
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}

/** 把任意 PNG blob（或 Promise<Blob>，Safari lazy 写法）复制到剪贴板。 */
export async function writeImageBlobToClipboard(blobOrPromise) {
  if (!navigator.clipboard || !navigator.clipboard.write) {
    throw new Error("浏览器不支持剪贴板写入");
  }
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blobOrPromise }),
  ]);
}

/** 读剪贴板里的图片。返回 Blob 或 null（剪贴板里没图）。 */
export async function readImageFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error("浏览器不支持剪贴板读取");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    for (const type of item.types) {
      if (type.startsWith("image/")) {
        return await item.getType(type);
      }
    }
  }
  return null;
}

// ---- 工具 ----

export function triggerDownload(blob, filename) {
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
