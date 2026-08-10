// image-io —— 解码/编码边界的壳域工具（C3 债 a：resample.ts 物理消灭后的幸存三函数）。
// 政策（提案 §4 壳域合法名单 + 硬原则「字节进出不走 canvas」）：外来格式 jpeg/webp/heic 只有
// 原生解码器，canvas 只许在**边界读出这一次**（ai-docs/reports/20260728-canvas-audit.md Ⅰ 类）；
// 一切重采样数学走 backend/algorithms/resample-bytes（typed-array，α 加权）——本文件零算法。

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  w = Math.max(1, w | 0); h = Math.max(1, h | 0);
  return (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; })();
}

export type DecodedImage = ImageBitmap | HTMLImageElement;

// 鲁棒解码图片文件 → ImageBitmap，失败（某些 Windows / 浏览器配置 / 格式下 createImageBitmap(File) 会抛）
// 退回 Image + objectURL 解码。返回可 drawImage 的源（ImageBitmap 或 HTMLImageElement）。
export async function decodeImageFile(file: Blob): Promise<DecodedImage> {
  try {
    return await createImageBitmap(file);
  } catch {
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e instanceof Error ? e : new Error("image decode failed")); };
      img.src = url;
    });
  }
}

// 解码边界的唯一 canvas 读出：读出这一次后管线全字节。
export function imageSourceToBytes(src: DecodedImage | HTMLCanvasElement | OffscreenCanvas): { data: Uint8ClampedArray; w: number; h: number } {
  const w = src.width || (src as HTMLImageElement).naturalWidth;
  const h = src.height || (src as HTMLImageElement).naturalHeight;
  const c = makeCanvas(w, h);
  const cx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  cx.drawImage(src as CanvasImageSource, 0, 0);
  const img = cx.getImageData(0, 0, w, h);
  return { data: img.data, w, h };
}

// C7：png-codec 的 canvas 回退路（iCCP 色彩配置 / UPNG 解码失败 → 浏览器原生解码一次性读出）
// 从 backend/png-codec.ts 移壳到此。app.ts boot 显式安装；
// 逻辑与旧 decodePngViaCanvas 逐字节同（decodeImageFile 的 Image 兜底顺带更鲁棒）。
import { setPngDecodeFallback } from "../backend/png-codec.ts";
export function installPngDecodeFallback(): void {
  setPngDecodeFallback(async (u8) => {
    const blob = new Blob([u8 as unknown as BlobPart], { type: "image/png" });
    return imageSourceToBytes(await decodeImageFile(blob));
  });
}

// canvas → Blob（jpg 编码等壳域名单场景）。OffscreenCanvas 用 convertToBlob，普通 canvas 用 toBlob。
export function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type = "image/png") {
  if ((canvas as OffscreenCanvas).convertToBlob) return (canvas as OffscreenCanvas).convertToBlob({ type });
  return new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type));
}
