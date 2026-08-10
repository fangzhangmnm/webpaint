// Session 管理：当前 session 名的读写面 + 缩略图渲染 + 导出下载 / 分享。
//
// **当前 session 名**：SSoT = `appState.currentFile`（synced-app-state collection，跨设备 resume）。
//   ⚠ 不是 localStorage —— v406 起迁进 collection 了，别信任何还说 "localStorage 记当前 name" 的注释。
//   默认 "未命名"。重名直接覆盖。
//
// **保存策略**（抄 AtlasMaker shareback TL;DR 第 2 条）：
//   - Ctrl+S 主导（v409：按 save = 无条件 encode+推，让时间戳走字）
//   - 3 min 兜底（只本地，consent-safe）
//   - visibilitychange / pagehide 抢救
//   - **不要** debounce/heartbeat —— 画图工具用户预期 Blender / Photoshop 模式
//   实现在 session-state.ts + editor-session/。本文件只管"当前叫什么名"。
//
// 幽灵 current path 陷阱（feedback-phantom-current-path memory）——载体变了、教训没变：
//   - boot load 失败时**不要**清 `appState.currentFile`（用户下次冷启动能重试）
//     → 见 boot.ts 的 `session.setName(null, { persist: false })`
//   - 但内存里 _activeSessionName（session-state）用 safe default，避免 save 走 rename 路径
//     把"加载失败的 path"当 oldName 删掉
//   - **破坏性操作永远用「真正载入的路径」**，不用这里的 getCurrentSessionName()

import { renderNodesToBytes } from "./backend/doc-render.ts";
import { areaResampleBytes } from "./backend/algorithms/resample-bytes.ts";
import { encodePngFromBytes } from "./backend/png-codec.ts";
import { canvasToBlob } from "./shell/image-io.ts";
import { appState } from "./app-state.ts";   // active session name = appState.currentFile（synced-app-state，跨设备 resume）
import type { PaintingView } from "./backend/workpiece/painting-view.ts";

// navigator.canShare/share 的 files 形参在部分 lib.dom 里未覆盖 → 窄化扩展（不引入 any）。
// 抄 src/brush-io.ts 的 FileShareNavigator 模式。
type FileShareNavigator = Navigator & {
  canShare?: (data?: { files?: File[] }) => boolean;
  share?: (data?: { files?: File[]; title?: string }) => Promise<void>;
};


// gallery-first: 空字符串 = 没活动 session（在 gallery）。
// active session = appState.currentFile（synced-app-state，非 null → boot 自动 open；跨设备 resume）。
//   null/未设 → 返 ""（停 gallery，等用户选）。try/catch 兜 pre-init（collection 未 hydrate 时 setItem 抛）。
export function getCurrentSessionName() {
  try { return appState.currentFile ?? ""; }
  catch { return ""; }
}
export function setCurrentSessionName(name: string) {
  try { appState.currentFile = name || null; } catch {}
}

// （v409 删 saveSession / putSessionPkg / saveAsSession / saveCurrentSession —— 四个**零 importer** 的死符号。
//  真正的保存路径是 session-state 的 es.flushLocal/forceSaveAndPush → store.file.save。
//  删的第二个理由：saveSession 是标准的 **phantom-path 反模式**——`name || getCurrentSessionName()`
//  从**持久化的** currentFile 取名，然后直接覆盖写。若 boot 加载失败而 currentFile 仍指向那个名字，
//  "复用一下现成的 saveSession" 就会把当前内存 doc 覆盖到那条 path 上。AtlasMaker 0.7.2 就是这么
//  吃掉一个加密文件的（见 feedback-phantom-current-path）。留着 = 一把上了膛的枪，删掉最省心。
//  现役破坏性操作全部用「真正载入的路径」（item.name / _activeSessionName，后者只在 es.open() 成功后升级）。）

/** 合成字节 → 缩略图 blob（最长边 = maxSide）。PNG 保 alpha（容器 CSS 背景可独立调色）。
 *  S9：不再自己合成——merged 由调用方给（GL doc-render 渲出，与 display/存档同源同刻）。
 *  C3：全字节管线——areaResampleBytes（面积平均，α 加权）+ UPNG，零 canvas。 */
export async function thumbBlobFromBytes(merged: { data: Uint8ClampedArray; w: number; h: number }, maxSide = 256) {
  const scale = Math.min(1, maxSide / Math.max(merged.w, merged.h));
  const tw = Math.max(1, Math.round(merged.w * scale));
  const th = Math.max(1, Math.round(merged.h * scale));
  const px = scale < 1 ? areaResampleBytes(merged.data, merged.w, merged.h, tw, th) : merged.data;
  // PNG 保 alpha；体积通常 5-25KB（立绘透明区压缩好），可接受
  const png = await encodePngFromBytes(px, tw, th);
  return new Blob([png as unknown as BlobPart], { type: "image/png" });
}

// 本地 session 列举（listSessions / isTrashKey / _detectEncrypted）已删（v415）：它读的 `sessions`
//   object store **早已没有写入者**（putSession 在 store cutover 后成死码），于是恒返空数组——
//   四个消费方（图库底栏占用 / uniqueLocalName / 找加密作品解锁 / 复制改名去重）全在静默失效。
//   现在各走真 SSoT：store.files.usage() / store.files.nameOccupied() / gallery.requestUnlock()
//   （当前夹）/ gallery 手上的 watchFolder 单夹快照。**不要再引入任何"列全库"的函数**——
//   列举唯一面 = store.files.watchFolder(当前夹)。
// 本地 session trash 生命周期（listTrashedSessions / trashSession / restoreSession / purgeFromTrash /
//   emptyTrash / removeSession / renameLocalSession）已删（v410）——七个零 importer 的死符号；图库回收站
//   走 store 的 .trash（store.listTrash / restore / purge / emptyTrash），本地不再自管一套 trash。
// loadCurrentSession / openSession 已退役（v235）：本地读取统一走 store.flow.load（加密容器自动解壳）。
//   boot 在 app.js、打开在 session-state.openItem。

// exportOraDownload / exportPsdDownload 已删（v415）：零调用者。
//   导出走 exporters.ts 的注册表（registerExporter + export-import-menu 的菜单），不是这两个裸函数。

// ---- 分享 / 导出 PNG / JPG ----

/** 渲染合成图 blob（分享 PNG/JPG 用）。全走 HTMLCanvasElement.toBlob，
 *  避开 Safari OffscreenCanvas.convertToBlob JPEG 返 null 的 bug。 */
// v124 加 scope 参数 (user)：
//   "merged" (default) = 所有可见层 + doc 背景（兼容旧行为）
//   "active" = 仅当前 active layer。JPG 仍涂 doc 背景（无 alpha）；PNG 保 alpha
// candidate 2：导出格式（png/jpg exporter）只负责把 doc 渲成 image blob；
// 去向（分享/下载/剪贴板）是正交的 sink，见 shareOrDownloadBlob。故此函数公开。
// #16（v0.5）：cropRect = 「仅导出选区范围」（选区 bbox，doc 坐标）；null/undefined = 全文档（旧行为）。
export async function renderDocToImageBlob(doc: PaintingView, mime = "image/png", quality?: number, scope = "merged", cropRect?: { x: number; y: number; w: number; h: number } | null) {
  // S9：合成走 GL（doc-render，与 display 同源，含 clip + 组隔离）。C3（债 d）：全字节管线——
  //   合成字节 → 裁剪/铺底全在字节上做；canvas 只剩 JPEG 编码边界（提案 §4 壳域合法名单）。
  //   scope==="active"：仅当前节点（组照常整树合成）；剥掉节点**自身**的 clippingMask（基底不在导出里，
  //   否则 planner 判 clip 无基底不渲染——对齐旧 ignoreSelfClip 语义），组/叶内部 clip 不受影响。
  const nodes = scope === "active"
    ? (doc.activeLayer ? [{ ...(doc.activeLayer as unknown as Record<string, unknown>), clippingMask: false }] : [])
    : (doc.layers as unknown[]);
  let plane = nodes.length ? renderNodesToBytes(nodes, doc.width, doc.height) : { data: new Uint8ClampedArray(doc.width * doc.height * 4), w: doc.width, h: doc.height };
  if (!plane) throw new Error("GL 不可用，无法合成导出图");
  // #16：裁剪到选区 bbox（合成仍整 doc 做——GL 合成一次性的，裁剪只是末端行拷贝）
  if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
    const cw = cropRect.w, ch = cropRect.h;
    const cut = new Uint8ClampedArray(cw * ch * 4);
    const x0 = Math.max(0, cropRect.x), x1 = Math.min(plane.w, cropRect.x + cw);
    const y0 = Math.max(0, cropRect.y), y1 = Math.min(plane.h, cropRect.y + ch);
    for (let y = y0; y < y1; y++) {
      const si = (y * plane.w + x0) * 4;
      const di = ((y - cropRect.y) * cw + (x0 - cropRect.x)) * 4;
      cut.set(plane.data.subarray(si, si + (x1 - x0) * 4), di);
    }
    plane = { data: cut, w: cw, h: ch };
  }
  // v134 (user：「导出 png 保留透明度！！」) PNG 永远不涂底，empty 区域 = 透明，user 想要白底自己加图层。
  if (mime !== "image/jpeg") {
    const png = await encodePngFromBytes(plane.data, plane.w, plane.h);
    return new Blob([png as unknown as BlobPart], { type: "image/png" });
  }
  // JPG 无 alpha 通道 → doc 背景直下（straight source-over 到不透明底，纯字节数学）。
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((doc.backgroundColor || "#ffffff").trim());
  const br = m ? parseInt(m[1], 16) : 255, bgc = m ? parseInt(m[2], 16) : 255, bb = m ? parseInt(m[3], 16) : 255;
  const flat = new Uint8ClampedArray(plane.w * plane.h * 4);
  const src = plane.data;
  for (let p = 0; p < src.length; p += 4) {
    const a = src[p + 3] / 255;
    flat[p] = src[p] * a + br * (1 - a);
    flat[p + 1] = src[p + 1] * a + bgc * (1 - a);
    flat[p + 2] = src[p + 2] * a + bb * (1 - a);
    flat[p + 3] = 255;
  }
  // canvas 仅当 JPEG 编码器（壳域名单：jpg 编码）。全走 HTMLCanvasElement.toBlob，
  // 避开 Safari OffscreenCanvas.convertToBlob JPEG 返 null 的 bug。
  const c = document.createElement("canvas");
  c.width = plane.w; c.height = plane.h;
  c.getContext("2d")!.putImageData(new ImageData(flat, plane.w, plane.h), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, mime, quality));
  if (blob) return blob;
  // jpg 返 null 兜底走 png（铺过底的字节直接 UPNG）
  const png = await encodePngFromBytes(flat, plane.w, plane.h);
  return new Blob([png as unknown as BlobPart], { type: "image/png" });
}

// 只有移动端（iOS/iPadOS/Android）才优先 share（→ 相册/Files 才是自然"保存"路径）。
// 桌面（Windows/Mac/Linux）的 share 面板不能存文件（user：「windows 的 share 没有保存」）→ 直接下载。
// #23：导出菜单的打印路径也按它分流（iOS 打印走分享面板，分享单里自带「打印」）→ 导出为公开谓词。
export function prefersShare() { return _prefersShare(); }
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

// shareOrDownloadImage 已删（v415）：零调用者。分享/下载走 exporters + export-import-menu 的
//   renderDocToImageBlob → shareOrDownloadBlob 组合（两者各自都还活着）。

// ---- 剪贴板 IO ----

/** 把 doc 合成图复制到剪贴板（PNG）。iPad Safari / 桌面都支持。 */
export async function copyImageToClipboard(doc: PaintingView, scope = "merged", cropRect?: { x: number; y: number; w: number; h: number } | null) {
  // iOS Safari 要求 clipboard.write 在 user gesture 内"同步"触达；**不能**先 await blob 再 write
  // （那个 await 跨过 gesture 窗口 → NotAllowedError）。把 renderDocToImageBlob 的 Promise<Blob>
  // 直接交给 ClipboardItem（lazy promise 写法），复用 writeImageBlobToClipboard 同款路径。
  const blobPromise = renderDocToImageBlob(doc, "image/png", undefined, scope, cropRect)
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

// 只有图的极简打印文档（新窗口 / iframe 共用）。src 传 blob objectURL 或 data URL。
// autoPrint：新窗口用 true（内嵌脚本 img.onload→window.print()→afterprint 自关标签页，父窗口跨窗口
//   驱动子窗口打印不可靠）；iframe 用 false（父窗口拿到 iwin 后自己驱动 print，别让脚本重复打）。
function _printDocHtml(src: string, autoPrint: boolean): string {
  const script = autoPrint
    ? "<scr" + "ipt>" +
      "var i=document.images[0];" +
      "function p(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},120);}" +
      "if(i.complete&&i.naturalWidth)p();else{i.onload=p;i.onerror=p;}" +
      // 打印面板关/取消后自动关标签页（自开窗口可自关）；iOS 未必触发 afterprint 则用户手动关。
      "window.onafterprint=function(){setTimeout(function(){try{window.close();}catch(e){}},300);};" +
      "</scr" + "ipt>"
    : "";
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>打印</title><style>" +
    "@page{margin:0}" +
    "html,body{margin:0;padding:0;height:100%;background:#fff}" +
    "body{display:flex;align-items:center;justify-content:center}" +
    "img{max-width:100%;max-height:100%;object-fit:contain}" +
    "</style></head><body>" +
    "<img alt=\"\" src=\"" + src + "\">" +
    script +
    "</body></html>"
  );
}

/**
 * 首选打印路径：把图开在**独立新标签页**里、从那儿打印（v375，用户实测选定）。
 * 为什么不在本页打：WebPaint 屏上是 2D canvas，但底下有 WebGL 合成器；iOS 16.7/17 已知 bug——
 *   打印 popover 这种模态一接管就丢 WebGL context（"WebGL: context lost"，见 Apple Dev Forums），
 *   打印期间任何 render 会把空 GL 结果 blit 到 2D 画布 → 主画布闪白/丢图。v370~v373 页内各招（@media
 *   print 覆盖层 / iframe / 每帧重绘 keep-alive / 持久 <img> 封面）都救不干净（用户逐版实测）。
 * 正解：把打印彻底搬离这个脆弱的 WebGL 页——新标签页只有一张 <img>，打印面板盖在它上面，主 app 页
 *   在另一个 tab、全程不被打印流程碰。
 *
 * win 必须在**用户手势同步期内**就 window.open 好再传进来（iOS transient-activation 很严，encode 的
 *   await 一跨就废）——所以开窗在 export-import-menu 的 click handler 里、encode 之前。
 * blob URL 与 opener 同源，子窗口能读；子窗口 <img> 一旦 load 完像素已进去，60s 后 revoke 不影响已渲染图。
 */
export async function printImageInNewWindow(win: Window, blobOrPromise: Blob | Promise<Blob>) {
  let url = "";
  try {
    const blob = await blobOrPromise;
    url = URL.createObjectURL(blob);
    win.document.open();
    win.document.write(_printDocHtml(url, true));   // autoPrint：子窗口自己打 + 打完自关
    win.document.close();
  } catch (e) {
    try { win.close(); } catch { /* ignore */ }
    if (url) URL.revokeObjectURL(url);
    throw e;
  }
  // 子窗口已把 blob 读进 <img>；给足加载时间后回收 objectURL（不影响已渲染的图）。
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * 兜底打印路径：弹窗被拦时用页内隐藏 iframe 打（桌面/降级）。打 iframe 自己的文档、调
 * iframe.contentWindow.print()（顶层 window.print() 会打整页；iOS 无视 @media print，故必走 iframe 文档）。
 * onAfterPrint：afterprint / 60s 兜底回调一次，给 app 重绘兜底。
 */
export async function printImageBlob(
  blobOrPromise: Blob | Promise<Blob>,
  onAfterPrint?: () => void,
) {
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
  idoc.write(_printDocHtml(url, false));   // 父窗口驱动 print，别让脚本重复打
  idoc.close();

  await new Promise<void>((resolve) => {
    const img = idoc.images[0];
    if (!img || (img.complete && img.naturalWidth > 0)) return resolve();
    img.onload = () => resolve();
    img.onerror = () => resolve();
  });

  // afterprint 桌面可靠；iOS 未必触发 → 长兜底定时清理（打印面板期间别删 iframe）。
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
    iwin.removeEventListener("afterprint", finish);
    if (onAfterPrint) {
      try { onAfterPrint(); } catch { /* 收尾失败不该炸打印流程 */ }
      requestAnimationFrame(() => { try { onAfterPrint(); } catch { /* ditto */ } });
    }
  };
  iwin.addEventListener("afterprint", finish);
  setTimeout(finish, 60000);

  iwin.focus();
  iwin.print();
}
