import type { PaintingView } from "./backend/workpiece/painting-view.ts";
export declare function getCurrentSessionName(): string;
export declare function setCurrentSessionName(name: string): void;
/** 合成字节 → 缩略图 blob（最长边 = maxSide）。PNG 保 alpha（容器 CSS 背景可独立调色）。
 *  S9：不再自己合成——merged 由调用方给（GL doc-render 渲出，与 display/存档同源同刻）。
 *  C3：全字节管线——areaResampleBytes（面积平均，α 加权）+ UPNG，零 canvas。 */
export declare function thumbBlobFromBytes(merged: {
    data: Uint8ClampedArray;
    w: number;
    h: number;
}, maxSide?: number): Promise<Blob>;
/** 渲染合成图 blob（分享 PNG/JPG 用）。全走 HTMLCanvasElement.toBlob，
 *  避开 Safari OffscreenCanvas.convertToBlob JPEG 返 null 的 bug。 */
export declare function renderDocToImageBlob(doc: PaintingView, mime?: string, quality?: number, scope?: string, cropRect?: {
    x: number;
    y: number;
    w: number;
    h: number;
} | null): Promise<Blob>;
export declare function prefersShare(): boolean;
/**
 * 分享 / 保存合成图。移动端优先 navigator.share（→ 相册 / Files）；桌面直接下载到 Downloads。
 */
export declare function shareOrDownloadBlob(blob: Blob, filename: string, mime?: string): Promise<{
    method: string;
}>;
/** 把 doc 合成图复制到剪贴板（PNG）。iPad Safari / 桌面都支持。 */
export declare function copyImageToClipboard(doc: PaintingView, scope?: string, cropRect?: {
    x: number;
    y: number;
    w: number;
    h: number;
} | null): Promise<void>;
/** 把任意 PNG blob（或 Promise<Blob>，Safari lazy 写法）复制到剪贴板。 */
export declare function writeImageBlobToClipboard(blobOrPromise: Blob | Promise<Blob>): Promise<void>;
/** 读剪贴板里的图片。返回 Blob 或 null（剪贴板里没图）。 */
export declare function readImageFromClipboard(): Promise<Blob | null>;
export declare function triggerDownload(blob: Blob, filename: string): void;
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
export declare function printImageInNewWindow(win: Window, blobOrPromise: Blob | Promise<Blob>): Promise<void>;
/**
 * 兜底打印路径：弹窗被拦时用页内隐藏 iframe 打（桌面/降级）。打 iframe 自己的文档、调
 * iframe.contentWindow.print()（顶层 window.print() 会打整页；iOS 无视 @media print，故必走 iframe 文档）。
 * onAfterPrint：afterprint / 60s 兜底回调一次，给 app 重绘兜底。
 */
export declare function printImageBlob(blobOrPromise: Blob | Promise<Blob>, onAfterPrint?: () => void): Promise<void>;
