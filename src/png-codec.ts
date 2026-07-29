// PNG 编解码深模块（v0.6.42 止血 facade，user 2026-07-29：「把 canvas 封成一个伪装的 png 库，
// 这样下次不会再越狱 canvas」）。
//
// 现状：内部实现**暂时仍是 canvas**（putImageData→toBlob / createImageBitmap→getImageData），
// 所以像素数据仍吃一轮 straight→premult→straight 量化——这不是终态，是把全库的 PNG 编解码
// 收进**唯一接缝**：将来换 UPNG/自研 codec 只改本文件，调用方零动。
//
// 【硬原则（user）】：库外任何地方不许再为 PNG 编解码创建 canvas / createImageBitmap——
// 字节进出一律走这里。发现新需求（压缩级/调色板量化/16bit）改本库，别在外面绕。
//
// 展望（已拍板方向）：解码什么都吃（UPNG：16bit/隔行/调色板）；编码走专业绘图软件路线
// （自定义压缩比、调色板/GIF 式配置——push to future，本版不做）。

import { makeBitmap } from "./bitmap.ts";

export interface RgbaPlane { data: Uint8ClampedArray; w: number; h: number }

// straight RGBA 字节 → PNG 字节。⚠当前 canvas 实现：低 α 像素 RGB 有 premult 量化损（换 codec 后消失）。
export async function encodePngFromBytes(data: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const c = makeBitmap(w, h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return encodePngFromCanvas(c);
}

// canvas → PNG 字节（扁平化导出/缩略图这类"canvas 语义即输出"的 B 类调用方用；
// 像素管线调用方请走 encodePngFromBytes）。原 ora.canvasToPngBytes 原样搬入。
export async function encodePngFromCanvas(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  let blob: Blob | null | undefined;
  const oc = canvas as OffscreenCanvas, hc = canvas as HTMLCanvasElement;
  if (typeof oc.convertToBlob === "function") {
    blob = await oc.convertToBlob({ type: "image/png" });
  } else if (typeof hc.toBlob === "function") {
    blob = await new Promise<Blob | null>((resolve) => hc.toBlob(resolve, "image/png"));
  } else {
    throw new Error("canvas 无 toBlob / convertToBlob");
  }
  if (!blob) throw new Error("canvas → blob 失败");
  return new Uint8Array(await blob.arrayBuffer());
}

// PNG 字节 → straight RGBA 字节。⚠当前 createImageBitmap+getImageData 实现：同上 premult 量化损；
// 浏览器解码会应用内嵌色彩 profile（换自研/UPNG 后此行为会变——届时对非 sRGB profile 保留本路径回退）。
export async function decodePngToBytes(bytes: Uint8Array | Blob): Promise<RgbaPlane> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as unknown as BlobPart], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  const c = makeBitmap(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { data: img.data, w: img.width, h: img.height };
}
