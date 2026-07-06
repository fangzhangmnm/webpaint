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

import { encodeDocToOra, decodeOraToDoc } from "./ora.ts";
import { compositeLayers } from "./layer-composite.ts";
import { looksEncryptedContainer } from "./crypto-format.ts";
import { smartResample, canvasToBlob } from "./resample.ts";
import { getSession, putSession, deleteSession, listSessionIds, renameSessionKey } from "./storage.ts";
import { LOCAL_BACKUP_PREFIX } from "./store/move-aside.ts";   // 深模块的隐藏命名空间约定（backup 不进图库）
import type { PaintDoc } from "./doc.ts";

// navigator.canShare/share 的 files 形参在部分 lib.dom 里未覆盖 → 窄化扩展（不引入 any）。
// 抄 src/brush-io.ts 的 FileShareNavigator 模式。
type FileShareNavigator = Navigator & {
  canShare?: (data?: { files?: File[] }) => boolean;
  share?: (data?: { files?: File[]; title?: string }) => Promise<void>;
};

interface SaveSessionOpts {
  referenceImage?: Blob;
  webpaintState?: object;
}

interface SessionPkg {
  name: string;
  updatedAt: number;
  ora: Blob;
  thumb: Blob | null;
}

const LS_CURRENT_NAME = "webpaint.currentSessionName";
const DEFAULT_NAME = "未命名";
const LEGACY_SLOT = "current";   // 旧 v35 单 slot key；冷启动会迁移到 DEFAULT_NAME

// gallery-first: 空字符串 = 没活动 session（在 gallery）。
// 老 user 没 set 过 → null → 返 ""（停 gallery，等用户选）
export function getCurrentSessionName() {
  try { return localStorage.getItem(LS_CURRENT_NAME) || ""; }
  catch { return ""; }
}
export function setCurrentSessionName(name: string) {
  try { localStorage.setItem(LS_CURRENT_NAME, name); } catch {}
}

/** 把 doc 序列化进指定 session（默认当前），同时生成 thumb 存进 pkg。
 *  **仅限明文新建路径**（newDoc / saveAs 的新名字天然明文）——活动 doc 的常规保存
 *  走 store.flow.save（v235：加密包壳在深模块，这里不感知加密）。
 *  opts.referenceImage: optional Blob —— 嵌进 .ora 跟着文件走（webpaint/reference.png）。
 *  opts.webpaintState:  optional 对象，进 webpaint/state.json
 */
export async function saveSession(doc: PaintDoc, name?: string, opts: SaveSessionOpts = {}) {
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
export async function putSessionPkg(name: string, ora: Blob, thumb: Blob | null = null) {
  const pkg = { name, updatedAt: Date.now(), ora, thumb };
  await putSession(name, pkg);
  return pkg;
}

/** 渲染缩略图 blob（最长边 = maxSide）。给图库 grid 用。
 *  PNG 保留 alpha → 容器 CSS 背景可独立调色，立绘透明区跟容器自然融合。
 */
export async function renderThumbBlob(doc: PaintDoc, maxSide = 256) {
  const W = doc.width, H = doc.height;
  const merged = document.createElement("canvas");
  merged.width = W; merged.height = H;
  const mctx = merged.getContext("2d")!;
  // 不涂底：保 alpha，PNG 编码透出来 → 容器 CSS bg 直接生效（调色不用改 JS）。
  // 走规范合成器（deep module A）：respect clip/mode + **组隔离**（手抄扁平 loop 会漏掉组内层）。
  compositeLayers(mctx, doc.layers);
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
function makeTrashKey(name: string) {
  return `${TRASH_PREFIX}${Date.now()}-${++_trashCounter}:${name}`;
}
function isTrashKey(key: string) { return typeof key === "string" && key.startsWith(TRASH_PREFIX); }
function parseTrashKey(key: string) {
  // trash:<ts>[-<counter>]:<originalName>。counter 段可选（旧记录无）。name 可能含 ":"
  const m = /^trash:(\d+)(?:-\d+)?:(.+)$/s.exec(key);
  if (!m) return null;
  return { deletedAt: Number(m[1]), originalName: m[2] };
}
// 本地 backup 的命名/防撞/命名空间策略在深模块（src/store/move-aside.js + local-adapter）。
// 这里只消费它的前缀常量，把这道隐藏命名空间从图库列表过滤掉（覆盖前留底，不该 flood 用户文件夹）。

/** 本地原子重命名（atomic put new + delete old）。同名抛 destination-exists。 */
export async function renameLocalSession(oldName: string, newName: string) {
  if (oldName === newName) return;
  await renameSessionKey(oldName, newName);
}

/** 列所有 session 元信息（name + updatedAt + size + thumb Blob + encrypted）。不解码 .ora。
 *  默认过滤 trash:* keys；要看 trash 用 listTrashedSessions */
// 加密探测 memo：尾部 96KB 扫一次 MAGIC 就够，但图库每次 reload 都列 → 按 (name, updatedAt, size) 缓存
const _encDetectMemo = new Map();
async function _detectEncrypted(id: string, pkg: SessionPkg) {
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
export async function trashSession(name: string) {
  const trashKey = makeTrashKey(name);
  await renameSessionKey(name, trashKey);
  return trashKey;
}

/** 从 trash 恢复。如果 originalName 冲突（同名 active session 存在）→ 自动加 (2)(3)... 后缀。
 *  返实际恢复的 name */
export async function restoreSession(trashKey: string) {
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
export async function purgeFromTrash(trashKey: string) {
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

export async function removeSession(name: string) {
  await deleteSession(name);
}

/** Save As：把 doc 写到新 name 下。**不删旧的**。caller 决定切到新 name。 */
export async function saveAsSession(doc: PaintDoc, name: string) {
  return await saveSession(doc, name);
}

// 兼容 v35 命名（app.js 旧 import）
export const saveCurrentSession = saveSession;

/** 导出 .ora 到本地下载 */
export async function exportOraDownload(doc: PaintDoc, filename = "未命名.ora") {
  const blob = await encodeDocToOra(doc);
  triggerDownload(blob, filename);
}

/** 导出 .psd 到本地下载（最小子集：raster layer + bbox + blend mode + opacity + name）。
 *  Photoshop / Affinity / Procreate / Krita 都吃。详见 src/psd.js */
export async function exportPsdDownload(doc: PaintDoc, filename = "未命名.psd") {
  const { encodeDocToPsd } = await import("./psd.ts");
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
export async function renderDocToImageBlob(doc: PaintDoc, mime = "image/png", quality?: number, scope = "merged") {
  const c = document.createElement("canvas");
  c.width = doc.width;
  c.height = doc.height;
  const ctx = c.getContext("2d")!;
  // v134 (user：「导出 png 保留透明度！！」) 只 JPG 涂 doc 背景（无 alpha 通道）
  //   PNG 永远不涂，empty 区域 = 透明，user 想要白底自己加图层
  const wantBg = mime === "image/jpeg";
  if (wantBg) {
    ctx.fillStyle = doc.backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  // 合成走规范合成器（deep module A，含 clip + 组隔离）。ctx 在 doc 坐标 1:1，无 live overlay。
  //   scope==="active"：仅当前层。若选中的是组 → 导出该组合并结果（组内 clip/blend/隔离照常）；
  //   ignoreSelfClip 只忽略被选节点**自身**对外部兄弟的 clip（基底不在导出里），不影响组内部 clip。
  if (scope === "active") {
    if (doc.activeLayer) compositeLayers(ctx, [doc.activeLayer], { ignoreSelfClip: true });
  } else {
    compositeLayers(ctx, doc.layers);
  }
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, mime, quality));
  if (blob) return blob;
  // jpg 返 null 兜底走 png
  if (mime !== "image/png") {
    return await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
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
export async function shareOrDownloadBlob(blob: Blob, filename: string, mime?: string) {
  const file = new File([blob], filename, { type: mime || blob.type || "application/octet-stream" });
  const nav = navigator as FileShareNavigator;
  if (_prefersShare() && nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: filename });
      return { method: "share" };
    } catch (e) {
      // 用户取消 = AbortError，不报错；其他错降级到 download
      if (e && (e as { name?: string }).name === "AbortError") return { method: "cancel" };
      // 失败 fall through 到 download
    }
  }
  triggerDownload(blob, filename);
  return { method: "download" };
}

export async function shareOrDownloadImage(doc: PaintDoc, format = "png", filename = "WebPaint", scope = "merged") {
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const ext  = format === "jpg" ? "jpg" : "png";
  const quality = format === "jpg" ? 0.92 : undefined;
  const blob = await renderDocToImageBlob(doc, mime, quality, scope);
  return shareOrDownloadBlob(blob!, `${filename}.${ext}`, mime);
}

// ---- 剪贴板 IO ----

/** 把 doc 合成图复制到剪贴板（PNG）。iPad Safari / 桌面都支持。 */
export async function copyImageToClipboard(doc: PaintDoc, scope = "merged") {
  // iOS Safari 要求 clipboard.write 在 user gesture 内"同步"触达；**不能**先 await blob 再 write
  // （那个 await 跨过 gesture 窗口 → NotAllowedError）。把 renderDocToImageBlob 的 Promise<Blob>
  // 直接交给 ClipboardItem（lazy promise 写法），复用 writeImageBlobToClipboard 同款路径。
  const blobPromise = renderDocToImageBlob(doc, "image/png", undefined, scope)
    .then((blob) => { if (!blob) throw new Error("生成 PNG 失败"); return blob; });
  await writeImageBlobToClipboard(blobPromise);
}

/** 把任意 PNG blob（或 Promise<Blob>，Safari lazy 写法）复制到剪贴板。 */
export async function writeImageBlobToClipboard(blobOrPromise: Blob | Promise<Blob>) {
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

export function triggerDownload(blob: Blob, filename: string) {
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

// ---- 打印 sink ----

/**
 * 把图片 blob 送系统打印对话框（与文件/剪贴板/分享正交的第 4 个 sink）。
 * iPad Safari：弹 iOS 打印面板 → 选 AirPrint 打印机走 WiFi 直打。桌面：弹浏览器打印对话框。
 *
 * 关键：打**隐藏 iframe 自己的文档**（doc 里只有这张图），调 `iframe.contentWindow.print()`。
 *   - v370 的「当前文档注入 @media print 覆盖层 + 顶层 window.print()」在 iOS 上失败：
 *     iOS Safari 基本无视 @media print，把当前视口整页栅格化 → 打出来是网页截图（用户实测）。
 *   - iframe 是独立文档，iOS 打的是 iframe 里的内容，绕开顶层页的 print CSS。
 *     （注意区别：顶层 window.print() 才会打整页；iframe.contentWindow.print() 打 iframe 文档。
 *      print-js / react-to-print 在 iOS 上就是这么干的。）
 *
 * hooks 给 app 层重绘用，救 WebGL 白屏——iPad 打印面板是**盖在页面上的 popover**（不铺满屏，
 *   主画布在旁边可见），页面从不 hidden/blur，故不触发 visibilitychange/focus。iOS 在打印面板里
 *   **每调一项设置就重合成一次预览**，每次重合成都撞上被清空的 drawing buffer（preserveDrawingBuffer:false）
 *   → 主画布反复闪白（用户实测）。单靠 afterprint 一次重绘救不了面板期间的连闪。
 *   - onFrame：打印窗口期间**每帧**调（board.requestRender，轻）——持续重画，让每次重合成都撞上新鲜帧。
 *   - onDone：afterprint / 60s 兜底时调一次（board.invalidateAll，重，全量重传）——收尾兜底。
 * window.print() 不需要 user gesture（不像 clipboard.write），故 encode 的 await 不会失效。
 */
export async function printImageBlob(
  blobOrPromise: Blob | Promise<Blob>,
  hooks: { onFrame?: () => void; onDone?: () => void } = {},
) {
  const { onFrame, onDone } = hooks;
  const blob = await blobOrPromise;
  const url = URL.createObjectURL(blob);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  // 不能 display:none（iOS 不渲染就打不出内容）；挪到视口外 + visibility:hidden。
  iframe.style.cssText = "position:fixed; right:0; bottom:0; width:1px; height:1px; border:0; visibility:hidden;";
  document.body.appendChild(iframe);

  const idoc = iframe.contentDocument;
  const iwin = iframe.contentWindow;
  const cleanup = () => { iframe.remove(); URL.revokeObjectURL(url); };
  if (!idoc || !iwin) { cleanup(); throw new Error("打印 iframe 创建失败"); }

  idoc.open();
  idoc.write(
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
    "@page { margin: 0; }" +
    "html,body { margin:0; padding:0; height:100%; }" +
    "body { display:flex; align-items:center; justify-content:center; }" +
    "img { max-width:100%; max-height:100%; object-fit:contain; }" +
    "</style></head><body></body></html>"
  );
  idoc.close();

  const img = idoc.createElement("img");
  img.src = url;
  idoc.body.appendChild(img);

  await new Promise<void>((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    img.onload = () => resolve();
    img.onerror = () => resolve();
  });

  // afterprint 桌面可靠；iOS 未必触发 → 长兜底定时清理（打印面板期间别删 iframe）。
  let done = false;
  // keep-alive：打印窗口期间每帧请主画布重绘，抵消 iOS 每次预览重合成带来的闪白。
  let raf = 0;
  const tick = () => {
    if (done) return;
    try { onFrame?.(); } catch { /* 重绘失败不该炸打印流程 */ }
    raf = requestAnimationFrame(tick);
  };
  const finish = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    cleanup();
    iwin.removeEventListener("afterprint", finish);
    // 收尾：面板关掉后浏览器还会重合成一次 → 放 rAF 后一拍再全量重绘一次兜底。
    if (onDone) {
      try { onDone(); } catch { /* ditto */ }
      requestAnimationFrame(() => { try { onDone(); } catch { /* ditto */ } });
    }
  };
  iwin.addEventListener("afterprint", finish);
  setTimeout(finish, 60000);

  // 先起 keep-alive 循环，再唤打印面板——面板一出现主画布就已在持续重画。
  if (onFrame) raf = requestAnimationFrame(tick);
  iwin.focus();
  iwin.print();
}
