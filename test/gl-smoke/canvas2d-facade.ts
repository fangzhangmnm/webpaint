// Canvas2D facade（**测试域**，browser-only）：LayerPixels ⇄ canvas 的桥，gl-smoke 2D 参照
// 合成器/预览 harness 专用。C3 债 b 起生产 src/ 零 canvas facade——真写者全走
// editRegionBytes/replaceFromBytes/putRegion；本文件是 2D 参照域（canvas 语义即输出）的合法住所。
import { LayerPixels } from "../../src/tiles/tile-layer.ts";

type Bitmap2D = HTMLCanvasElement | OffscreenCanvas;
function scratch2D(w: number, h: number): Bitmap2D {
  if (typeof OffscreenCanvas !== "undefined") { try { return new OffscreenCanvas(w, h); } catch { /* fall */ } }
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}

// 物化整个内容为一张 bbox 画布（+ doc 原点）。空 → null。
//   tight=true 用 per-tile bbox 聚合收紧；默认 tile 粒度（够 2D 合成用）。
export function materialize(lp: LayerPixels, tight = false): { canvas: Bitmap2D; ox: number; oy: number } | null {
  const b = lp.contentBounds(tight);
  if (!b) return null;
  const c = scratch2D(b.w, b.h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(lp.getRegion(b.x, b.y, b.w, b.h), b.w, b.h), 0, 0);
  return { canvas: c, ox: b.x, oy: b.y };
}

// 编辑事务（canvas 版）：物化 doc 矩形 [rx0,ry0,rw,rh]（含已有像素）→ 给 ctx 让 fn 画 → 切片回 tile。
// fn(ctx, ox, oy)：ctx 原点 = doc(ox,oy)。⚠putImageData→getImageData 往返有 premult 量化——参照域可容。
export function editRegion(lp: LayerPixels, rx0: number, ry0: number, rw: number, rh: number, fn: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void): void {
  if (rw <= 0 || rh <= 0) return;
  const c = scratch2D(rw, rh);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(lp.getRegion(rx0, ry0, rw, rh), rw, rh), 0, 0);   // 预填已有
  fn(ctx, rx0, ry0);
  lp.putRegion(rx0, ry0, rw, rh, ctx.getImageData(0, 0, rw, rh).data);             // 切片回 tile
}

// 整体从一张 canvas 重建：清空 + 切片。srcCanvas 内容在 doc (ox,oy) 起、w×h。
export function replaceFromCanvas(lp: LayerPixels, srcCanvas: CanvasImageSource, ox: number, oy: number, w: number, h: number): void {
  lp.clear();
  if (w <= 0 || h <= 0) return;
  const c = scratch2D(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(srcCanvas, 0, 0);
  lp.putRegion(ox, oy, w, h, ctx.getImageData(0, 0, w, h).data);
}
