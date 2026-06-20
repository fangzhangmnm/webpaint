// 锐化 / 模糊
// 双极 slider：负值 = 模糊（3×3 box N 次迭代）；正值 = 锐化（unsharp mask）
//
// v132: modes = ["region","brush"]，region 是大图全烤（卡），brush 是局部小 stamp（不卡）
//   brush 模式 bakeBrush 由 FilterBrushEngine 调，待 Phase B 实装
// 论证：模糊本质 non-local 卷积，大图慢；brush 模式天然限定 bbox 不卡

import { registerFilter, clamp8, makeSliderRow, attachColorBrushBehavior } from "../filters.ts";
import type { Filter, FilterParams } from "../filters.ts";

export class SharpenBlurFilter {
  static id = "sharpenBlur";
  static title = "锐化 / 模糊";
  static category = "adjustment";
  // v132 (user：「全屏的锐化模糊可以删」)：只保留 brush 模式
  //   region 模式大图（4K+）非常卡，brush 模式 stamp bbox 小天然不卡
  static modes = ["brush"];
  // brush 模式 2 个 variants：模糊（amount=-50）/ 锐化（amount=+50）
  // FilterBrushEngine 用 variant.params 初始化；user 进入对应模式就拿到合适默认
  static brushVariants = [
    { id: "blur",  title: "模糊（笔刷）", params: { amount: -50 } },
    { id: "sharp", title: "锐化（笔刷）", params: { amount: +50 } },
  ];

  // bleed = 模糊 N 次 box 半径 = N；锐化单次 box = 1；0 = identity
  static bleedRadius(p: FilterParams): number {
    const amt = (p && (p.amount as number)) | 0;
    if (amt < 0) return Math.max(1, Math.min(10, Math.round(-amt / 10)));
    if (amt > 0) return 1;
    return 0;
  }

  static defaults() { return { amount: 0 }; }

  static buildBody(container: HTMLElement, state: unknown, onChange: () => void): void {
    const st = state as { params: { amount: number } };
    container.appendChild(makeSliderRow("← 模糊      锐化 →", "amount", -100, 100, 1, st.params.amount, (k: string, v: number) => {
      st.params.amount = v | 0;
      onChange();
    }, {
      gradient: "linear-gradient(90deg, #c4d2dc 0%, #888 50%, #f5f5f5 100%)",
    }));
  }

  // v135 锐化重写（user：「老版全是彩色噪点」）
  //   - per-channel USM 跨通道 ringing → 色噪。改 luma-only delta
  //   - box blur 替成 Gaussian 3×3 (1,2,1/2,4,2/1,2,1 /16)，边缘干净
  //   - threshold（|luma diff| < 4 跳过）= 抗噪（PS Unsharp Mask 的 threshold 参数）
  //   - k = amt/100（不再 ×2）减弱过冲
  //   模糊 path 保持 box blur N iter
  static bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, p: FilterParams, mask: Uint8ClampedArray | null, w: number, h: number): void {
    const amt = (p.amount as number) | 0;
    if (amt === 0) { dstData.set(srcData); return; }
    if (amt < 0) {
      const N = Math.max(1, Math.min(10, Math.round(-amt / 10)));
      let src = srcData;
      const tmp = new Uint8ClampedArray(srcData.length);
      let dst = tmp;
      for (let it = 0; it < N; it++) {
        SharpenBlurFilter._boxBlur3(src, dst, w, h, mask);
        [src, dst] = [dst, src];
      }
      if (src !== dstData) dstData.set(src);
      return;
    }
    // 锐化：luma-only USM with Gaussian + threshold
    const blurred = new Uint8ClampedArray(srcData.length);
    SharpenBlurFilter._gaussianBlur3(srcData, blurred, w, h);
    const k = amt / 100;        // amt=100 → k=1.0 适度
    const THRESHOLD = 4;        // |luma diff| < 4 不锐化（抗噪）
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      const r = srcData[o], g = srcData[o+1], b = srcData[o+2];
      const br = blurred[o], bg = blurred[o+1], bb = blurred[o+2];
      const luma  = 0.2126 * r  + 0.7152 * g  + 0.0722 * b;
      const lumaB = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
      const diff = luma - lumaB;
      if (Math.abs(diff) < THRESHOLD) {
        dstData[o] = r; dstData[o+1] = g; dstData[o+2] = b;
      } else {
        // 3 通道同 delta = 保 chroma：无 cross-channel ringing → 无色噪
        const delta = k * diff;
        dstData[o]   = clamp8(r + delta);
        dstData[o+1] = clamp8(g + delta);
        dstData[o+2] = clamp8(b + delta);
      }
      dstData[o+3] = srcData[o+3];
    }
  }

  // v135 Gaussian 3×3 (1,2,1 / 2,4,2 / 1,2,1 / 16)：sharpen path 用，比 box 干净
  static _gaussianBlur3(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
            const sy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
            const so = (sy * w + sx) * 4;
            const kw = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            r += src[so] * kw; g += src[so+1] * kw; b += src[so+2] * kw; a += src[so+3] * kw;
          }
        }
        dst[o] = (r / 16) | 0; dst[o+1] = (g / 16) | 0; dst[o+2] = (b / 16) | 0; dst[o+3] = (a / 16) | 0;
      }
    }
  }
  static _boxBlur3(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, mask: Uint8ClampedArray | null): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (mask && mask[o + 3] < 128) {
          dst[o] = src[o]; dst[o+1] = src[o+1]; dst[o+2] = src[o+2]; dst[o+3] = src[o+3];
          continue;
        }
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
            const sy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
            const so = (sy * w + sx) * 4;
            r += src[so]; g += src[so+1]; b += src[so+2]; a += src[so+3];
          }
        }
        dst[o]   = (r / 9) | 0;
        dst[o+1] = (g / 9) | 0;
        dst[o+2] = (b / 9) | 0;
        dst[o+3] = (a / 9) | 0;
      }
    }
  }
}

attachColorBrushBehavior(SharpenBlurFilter);
registerFilter(SharpenBlurFilter);
