// 图像解码 + 高质量缩放工具。多处复用：参考窗导入、图片导入(新 doc/图层)、doc 重采样、缩略图。
//
// 深模块理由（deletion test）：缩小若一次性大比例 drawImage，浏览器只做双线性 → 严重 aliasing。
// 高质量缩小要 step-halving（每步 ≤2x，近似 box/area 平均）。这套逻辑若散在 N 个 resample 点会被抄 N 遍，
// 收进这里：调用方只说"缩到这么大"，怎么缩干净是实现细节。PS 缩小推荐 Bicubic Sharper，我们用 step-halving + high smoothing 近似。

function makeCanvas(w, h) {
  w = Math.max(1, w | 0); h = Math.max(1, h | 0);
  return (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; })();
}

// 高质量缩放到 (tw,th)。缩小走 step-halving（防 aliasing），放大/收尾走 high smoothing。
// src 可是 ImageBitmap / HTMLImageElement / canvas（任意 drawImage 源）。返回一张 canvas。
export function smartResample(src, tw, th) {
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));
  let sw = src.width || src.naturalWidth;
  let sh = src.height || src.naturalHeight;
  let cur = src;
  // 缩小：每步最多减半，逼近目标
  while (sw > tw * 2 || sh > th * 2) {
    const nw = Math.max(tw, Math.floor(sw / 2));
    const nh = Math.max(th, Math.floor(sh / 2));
    const c = makeCanvas(nw, nh);
    const cx = c.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(cur, 0, 0, sw, sh, 0, 0, nw, nh);
    cur = c; sw = nw; sh = nh;
  }
  const out = makeCanvas(tw, th);
  const ox = out.getContext("2d");
  ox.imageSmoothingEnabled = true;
  ox.imageSmoothingQuality = "high";
  ox.drawImage(cur, 0, 0, sw, sh, 0, 0, tw, th);
  return out;
}

// 限制在 maxW×maxH 内（保持比例）。没超 → 原样返回 src（不复制）。超了 → step-halving 缩小。
// 返回 { source, w, h, scaled }：source 可直接 drawImage / setBitmap。
export function fitWithin(src, maxW, maxH) {
  const sw = src.width || src.naturalWidth;
  const sh = src.height || src.naturalHeight;
  if (sw <= maxW && sh <= maxH) return { source: src, w: sw, h: sh, scaled: false };
  const k = Math.min(maxW / sw, maxH / sh);
  const tw = Math.round(sw * k), th = Math.round(sh * k);
  return { source: smartResample(src, tw, th), w: tw, h: th, scaled: true };
}

// 鲁棒解码图片文件 → ImageBitmap，失败（某些 Windows / 浏览器配置 / 格式下 createImageBitmap(File) 会抛）
// 退回 Image + objectURL 解码。返回可 drawImage 的源（ImageBitmap 或 HTMLImageElement）。
export async function decodeImageFile(file) {
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

// canvas → PNG Blob（持久化用）。OffscreenCanvas 用 convertToBlob，普通 canvas 用 toBlob。
export function canvasToBlob(canvas, type = "image/png") {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type });
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}
