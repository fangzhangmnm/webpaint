// 云盘图片 picker 的纯模型（零 DOM/零 store，node 可测）——spec ai-docs/20260820-cloud-image-picker-spec.md。
// 扩展名知识的唯一住址（库零内容格式知识纪律：这类知识只在 app 层，且只此一处）：
//   gallery 白名单 = 画作（.ora）+ 加密容器（.zip）；图片白名单 = 浏览器可解码集（picker 列举/路由用）。
//   其余一切（.md / 未知）gallery 和 picker 都不见。tga 等自研解码器落地后在 IMAGE_EXT_RE 扩。

const DOC_EXT_RE = /\.(ora|zip)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
export const isDocPath = (p: string): boolean => DOC_EXT_RE.test(p);
export const isImagePath = (p: string): boolean => IMAGE_EXT_RE.test(p);

/** path → basename（picker 显示名；File 包装名 =「有名保名」命名规范的上游）。 */
export const imageBasename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** 孪生裸名（v0.9.34 拍板：图库点图片 = 开同夹同名 ora，没有才新建）：foo.png @ 夹A → "夹A/foo"。 */
export const imageTwinBareName = (folder: string, basename: string): string => {
  const stem = basename.replace(/\.[^.]+$/, "") || basename;
  return folder ? `${folder}/${stem}` : stem;
};

/** File 包装的 MIME（decodeImageFile 实际按字节嗅探，给对只是礼貌）。 */
export function mimeForImageName(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" }[m ?? ""] || "application/octet-stream";
}

/** 缩略图新鲜度 token（cloud-thumb-cache 同款语义：lastModified 优先，退 size）。变 = 重拉覆盖同 key。 */
export function imageThumbToken(it: { lastModified?: number; size?: number }): string {
  return it.lastModified != null ? `m:${it.lastModified}` : `s:${it.size ?? 0}`;
}

/** 缩到长边 ≤ max 的目标尺寸（不放大）。 */
export function thumbTargetSize(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(1, w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** 拿一个不占用的 `${base}.${ext}` / `${base} N.${ext}`（导出到云盘用；兜底加时间戳保证必返回）。
 *  isOccupied = store.files.nameOccupied 注入（本模块保持零 store 依赖可测）。 */
export async function nextFreeExportName(
  base: string, ext: string,
  isOccupied: (name: string) => Promise<boolean>,
  fallbackStamp: () => number = () => Date.now(),
): Promise<string> {
  const first = `${base}.${ext}`;
  if (!(await isOccupied(first))) return first;
  for (let i = 1; i < 20; i++) {
    const cand = `${base} ${i}.${ext}`;
    if (!(await isOccupied(cand))) return cand;
  }
  return `${base}-${fallbackStamp()}.${ext}`;
}

/** RGBA 平铺到白底（就地写，返回同一 buffer）：jpeg 无 alpha，透明区不平铺会糊成黑。 */
export function flattenOntoWhite(data: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) continue;
    const inv = 255 - a;
    data[i] = (data[i] * a + 255 * inv + 127) / 255 | 0;
    data[i + 1] = (data[i + 1] * a + 255 * inv + 127) / 255 | 0;
    data[i + 2] = (data[i + 2] * a + 255 * inv + 127) / 255 | 0;
    data[i + 3] = 255;
  }
  return data;
}
