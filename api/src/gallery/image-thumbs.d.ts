export declare const IMAGE_THUMB_MAX = 128;
export declare const IMAGE_THUMB_QUALITY = 80;
export { imageThumbToken } from "./cloud-image-model.ts";
/** 整份图片字节 → 缩略图 jpeg Blob（纯派生，不碰缓存；picker 之外想复用也从这走）。 */
export declare function makeImageThumb(fileBlob: Blob): Promise<Blob>;
/**
 * 拿云盘图片缩略图：cache 命中（token 同）直接返；miss → 整张下载自压 + 回写。失败抛（caller 显占位）。
 * @param path  全名 path（= store.file key / 缓存 key）
 * @param token imageThumbToken(item)；变 = 文件改了 → 重拉覆盖同 key
 */
export declare function getOrFetchImageThumb(path: string, token: string): Promise<Blob>;
/** 调试：清空全部图片缩略图缓存（无损可再生）。window.WeebPaint 挂载见 dev-console。 */
export declare const clearImageThumbCache: () => Promise<number>;
