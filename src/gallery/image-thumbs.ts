// 云盘图片 picker 的缩略图：整张下载 → 字节缩 → jpeg 自压 → IDB 缓存（spec 20260820 §6）。
//
// 与 ora 的 cloud-thumb-cache **分开存**（user 2026-08-20 拍板）：webpaint DB 的 image-thumbs store。
//   派生缓存家族形状照旧：key = store 文件身份（全名 path 含扩展名，图片没有裸名代数）、
//   token = lastModified 优先退 size（变 = 重拉覆盖同 key）、全删无损可再生。
// 管线守家规「字节进出不走 canvas」：decodeImageFile（解码边界读出一次）→ resampleBytes（纯字节）→
//   encodeJpegFromBytes（vendored jpeg-js 编码半边）。jpeg 无 alpha → 先平铺到白底（透明 png 不糊黑）。
// 图片本就明文（加密容器不是图片扩展名，进不了这条管线），jpeg 落 IDB 无明文红线问题。

import { decodeImageFile, imageSourceToBytes } from "../shell/image-io.ts";
import type { DecodedImage } from "../shell/image-io.ts";
import { resampleBytes } from "../backend/algorithms/resample-bytes.ts";
import { encodeJpegFromBytes } from "../backend/jpeg-codec.ts";
import { getImageThumb, setImageThumb, clearImageThumbs } from "../storage.ts";
import { openCloudImage } from "../app-store.ts";
import { thumbTargetSize, flattenOntoWhite } from "./cloud-image-model.ts";
import { reportError } from "../error-badge.ts";

export const IMAGE_THUMB_MAX = 128;    // 长边（「Windows 资源管理器-大图标」档，user 拍板）
export const IMAGE_THUMB_QUALITY = 80; // jpg 高压但不出可见噪点（user 拍板）

interface CachedImageThumb { token: string; blob: Blob; at: number; }

// 纯数学（token/目标尺寸/白底平铺）在 cloud-image-model.ts（node 可测）；此处只管 IO 编排。
export { imageThumbToken } from "./cloud-image-model.ts";

// 缩略图专用解码（v0.9.31，QA ⑤；v0.9.32 加文件大小门）：createImageBitmap 的 resize 选项让浏览器
//   在**解码期**降采样，JS 侧峰值从 全图 W*H*4（8k 图 ≈256MB，iPad 可崩 tab）降到 ~128*长宽比 量级。
//   只给 resizeWidth 时按比例缩（规范行为）；竖图宽 128 后长边仍 >128，交给下游 resampleBytes 收口。
//   ⚠ resize 解码对 <128px 小图是**放大**（违背「缩略图绝不放大」不变量，小图标会糊）——而内存优化
//   只对大文件才有意义 → 只在 blob 超过阈值时启用（128px 级图片文件不可能超 256KB；小文件全尺寸
//   解码本来就不费内存）。老浏览器不认 options / 解码失败 → 退全尺寸 decodeImageFile。
const RESIZE_DECODE_MIN_BYTES = 256 * 1024;
async function _decodeForThumb(blob: Blob): Promise<DecodedImage> {
  if (blob.size >= RESIZE_DECODE_MIN_BYTES) {
    try {
      return await createImageBitmap(blob, { resizeWidth: IMAGE_THUMB_MAX, resizeQuality: "high" });
    } catch { /* 退全尺寸 */ }
  }
  return decodeImageFile(blob);
}

/** 整份图片字节 → 缩略图 jpeg Blob（纯派生，不碰缓存；picker 之外想复用也从这走）。 */
export async function makeImageThumb(fileBlob: Blob): Promise<Blob> {
  const bitmap = await _decodeForThumb(fileBlob);
  const px = imageSourceToBytes(bitmap);
  (bitmap as ImageBitmap).close?.();
  const { w, h } = thumbTargetSize(px.w, px.h, IMAGE_THUMB_MAX);
  const small = (w !== px.w || h !== px.h) ? resampleBytes(px.data, px.w, px.h, w, h, "auto") : px.data;
  const jpeg = encodeJpegFromBytes(flattenOntoWhite(small), w, h, IMAGE_THUMB_QUALITY);
  return new Blob([jpeg as unknown as BlobPart], { type: "image/jpeg" });
}

// 同 path 并发去重（picker 网格一次渲染几十条，别重复下载同一张）
const _inflight = new Map<string, Promise<Blob>>();

/**
 * 拿云盘图片缩略图：cache 命中（token 同）直接返；miss → 整张下载自压 + 回写。失败抛（caller 显占位）。
 * @param path  全名 path（= store.file key / 缓存 key）
 * @param token imageThumbToken(item)；变 = 文件改了 → 重拉覆盖同 key
 */
export async function getOrFetchImageThumb(path: string, token: string): Promise<Blob> {
  try {
    const cached = await getImageThumb(path) as CachedImageThumb | undefined;
    if (cached && cached.blob && cached.token === token) return cached.blob;
  } catch { /* cache 读挂 = miss */ }
  const running = _inflight.get(path);
  if (running) return running;
  const job = (async () => {
    const fileBlob = await openCloudImage(path);
    if (!fileBlob) throw new Error(`cloud image unreachable: ${path}`);
    const thumb = await makeImageThumb(fileBlob);
    setImageThumb(path, { token, blob: thumb, at: Date.now() } satisfies CachedImageThumb)
      .catch((e) => reportError(new Error("[image-thumbs] cache write failed: " + String(e)), "log"));
    return thumb;
  })();
  _inflight.set(path, job);
  try { return await job; } finally { _inflight.delete(path); }
}

/** 调试：清空全部图片缩略图缓存（无损可再生）。window.WebPaint 挂载见 dev-console。 */
export const clearImageThumbCache = (): Promise<number> => clearImageThumbs();
