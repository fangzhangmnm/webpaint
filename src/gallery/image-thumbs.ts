// 云盘图片 picker 的缩略图：整张下载 → 字节缩 → jpeg 自压 → IDB 缓存（spec 20260820 §6）。
//
// 与 ora 的 cloud-thumb-cache **分开存**（user 2026-08-20 拍板）：webpaint DB 的 image-thumbs store。
//   派生缓存家族形状照旧：key = store 文件身份（全名 path 含扩展名，图片没有裸名代数）、
//   token = lastModified 优先退 size（变 = 重拉覆盖同 key）、全删无损可再生。
// 管线守家规「字节进出不走 canvas」：decodeImageFile（解码边界读出一次）→ resampleBytes（纯字节）→
//   encodeJpegFromBytes（vendored jpeg-js 编码半边）。jpeg 无 alpha → 先平铺到白底（透明 png 不糊黑）。
// 图片本就明文（加密容器不是图片扩展名，进不了这条管线），jpeg 落 IDB 无明文红线问题。

import { decodeImageFile, imageSourceToBytes } from "../shell/image-io.ts";
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

/** 整份图片字节 → 缩略图 jpeg Blob（纯派生，不碰缓存；picker 之外想复用也从这走）。 */
export async function makeImageThumb(fileBlob: Blob): Promise<Blob> {
  const bitmap = await decodeImageFile(fileBlob);
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
