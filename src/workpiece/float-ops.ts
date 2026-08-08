// float-ops —— 浮层像素纯函数（0.4 S6 生；T4b 起只剩纯函数——3 个 DocumentOperator 已死，
// 状态/记账归 float-component.ts，编排归 floating-transform.ts）。
//
// 像素路径全走 typed-array（getRegion/putRegion + materializeMaskRegion），零 Canvas2D —— node 全测。
// reject 的 identity 写回（不走 warp 采样器）= composeIdentityWriteback：straight-alpha source-over，
// 语义 ≡「identity 变换下的 commit」——stamp 保留、float 落在其上（spec:220-225）。

import { LayerPixels } from "../tiles/tile-layer.ts";
import type { ViewLeaf } from "./painting-view.ts";
import type { FloatRect, WorkpieceFloat } from "./float-component.ts";
import type { Selection } from "../selection.ts";

let _floatIdCounter = 1;

// ============ 像素纯函数（typed-array；node 全测） ============

// leaf ∩ selection → 浮层像素（trim 到非透明内容紧 bbox；不足 2×2 → null，v232 误触级别）。
// sel=null = 隐式整层全选（fallbackFullLayer）。纯读，不动 leaf。
export function extractFloatPixels(leaf: ViewLeaf, sel: Selection | null): WorkpieceFloat | null {
  const content = leaf.pixels.contentBounds(true);
  if (!content) return null;
  // 选区可能跨内容框外；clip 到交集
  const x0 = sel ? Math.max(content.x, sel.bboxX) : content.x;
  const y0 = sel ? Math.max(content.y, sel.bboxY) : content.y;
  const x1 = sel ? Math.min(content.x + content.w, sel.bboxX + sel.bboxW) : content.x + content.w;
  const y1 = sel ? Math.min(content.y + content.h, sel.bboxY + sel.bboxH) : content.y + content.h;
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const src = leaf.pixels.getRegion(x0, y0, w, h);
  const mask = sel ? sel.materializeMaskRegion(x0, y0, w, h) : null;
  // mask 乘进 alpha（straight：只动 a，rgb 保留——比 Canvas2D dst-in 免掉预乘取整损耗）+ 顺手扫紧 bbox
  let mnX = w, mnY = h, mxX = -1, mxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let a = src[i + 3];
      if (mask) { a = Math.round(a * mask[y * w + x] / 255); src[i + 3] = a; }
      if (a > 0) {
        if (x < mnX) mnX = x;
        if (x > mxX) mxX = x;
        if (y < mnY) mnY = y;
        if (y > mxY) mxY = y;
      }
    }
  }
  if (mxX < mnX || mxY < mnY) return null;             // 选区内全透明
  const tw = mxX - mnX + 1, th = mxY - mnY + 1;
  if (tw * th < 4) return null;                        // 不足 2×2
  let trimmed = src;
  if (tw !== w || th !== h) {
    trimmed = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const si = ((y + mnY) * w + mnX) * 4;
      trimmed.set(src.subarray(si, si + tw * 4), y * tw * 4);
    }
  }
  const fp = new LayerPixels(leaf.docW, leaf.docH);
  fp.putRegion(x0 + mnX, y0 + mnY, tw, th, trimmed);
  return { id: _floatIdCounter++, sourceLayerId: leaf.id, rect: { x: x0 + mnX, y: y0 + mnY, w: tw, h: th }, pixels: fp };
}

// 源层挖洞缓冲（dst-out 等价：a' = a·(255−m)/255；sel=null = 隐式全选 → 区域清空）。
// 纯函数：调用方经 leaf.putImageData 落层（保 ViewLeaf 物化缓存失效）；全透明化的 tile 由
// putRegion 自动回收（dirty 标记 → GL 增量重传，路径同旧 editRegion）。
export function composeCutHole(leaf: ViewLeaf, sel: Selection | null, region: FloatRect): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null {
  const { x, y, w, h } = region;
  if (w <= 0 || h <= 0) return null;
  const buf = leaf.pixels.getRegion(x, y, w, h);
  const mask = sel ? sel.materializeMaskRegion(x, y, w, h) : null;
  for (let i = 0, p = 0; i < buf.length; i += 4, p++) {
    buf[i + 3] = mask ? Math.round(buf[i + 3] * (255 - mask[p]) / 255) : 0;
  }
  return { x, y, w, h, data: buf };
}

// putImageData 只消费 {width,height,data}——node 无 ImageData 构造器时用普通对象喂（测试路径）。
export function applyRegionBuf(leaf: ViewLeaf, r: { x: number; y: number; w: number; h: number; data: Uint8ClampedArray }): void {
  leaf.putImageData(r.x, r.y, { width: r.w, height: r.h, data: r.data } as unknown as ImageData);
}

// reject 的 identity 写回：float 像素在原 rect 处 source-over 落到 leaf 当前内容之上
// （straight-alpha 合成；stamp 保留、float 在其上；无重采样）。返回合成好的 region 缓冲，
// 调用方负责 leaf.putImageData（保 ViewLeaf 物化缓存失效）。
// (ox,oy)：整数像素偏移（commit/stamp 的整数平移快路用；reject 传缺省 0,0 = 原位）。
export function composeIdentityWriteback(leaf: ViewLeaf, f: WorkpieceFloat, ox = 0, oy = 0): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } {
  const { w, h } = f.rect;
  return composeRigidWriteback(leaf, f, {
    dx0: f.rect.x + ox, dy0: f.rect.y + oy, dw: w, dh: h,
    m11: 1, m12: 0, s0x: 0, m21: 0, m22: 1, s0y: 0,
  });
}

/** 整数刚体写回映射（v0.6.34 90° 族置换快路）：dest 整数矩形 (dx0,dy0,dw,dh)，
 *  dest 内偏移 (u,v) 的源 texel 索引 = (m11·u+m12·v+s0x, m21·u+m22·v+s0y)。
 *  系数 ∈ {−1,0,1} + 整数平移 → 纯像素置换，零重采样。 */
export interface RigidMap {
  dx0: number; dy0: number; dw: number; dh: number;
  m11: number; m12: number; s0x: number;
  m21: number; m22: number; s0y: number;
}

// 任意 straight RGBA 缓冲在 (x,y) 处 source-over 落到 leaf 当前内容之上（typed array，
// 零 canvas premult 往返——v0.6.38 warp bake 落层用，取代 editRegion/drawImage）。
// 调用方负责 leaf.putImageData（保 ViewLeaf 物化缓存失效）。
export function composeOverWriteback(leaf: ViewLeaf, x: number, y: number, w: number, h: number, src: Uint8ClampedArray): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } {
  const dst = leaf.pixels.getRegion(x, y, w, h);
  for (let i = 0; i < dst.length; i += 4) {
    const fa = src[i + 3];
    if (fa === 0) continue;
    if (fa === 255) {
      dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = 255;
      continue;
    }
    const la = dst[i + 3];
    const inv = (255 - fa);
    const outA = fa + Math.round(la * inv / 255);
    if (outA === 0) { dst[i + 3] = 0; continue; }
    const wf = fa * 255, wl = la * inv;
    dst[i]     = Math.round((src[i]     * wf + dst[i]     * wl) / (wf + wl));
    dst[i + 1] = Math.round((src[i + 1] * wf + dst[i + 1] * wl) / (wf + wl));
    dst[i + 2] = Math.round((src[i + 2] * wf + dst[i + 2] * wl) / (wf + wl));
    dst[i + 3] = outA;
  }
  return { x, y, w, h, data: dst };
}

// 整数刚体写回：float 像素按置换映射 source-over 落到 leaf 当前内容之上（straight-alpha，
// 逐字节精确、与采样模式无关）。调用方负责 leaf.putImageData（保 ViewLeaf 物化缓存失效）。
export function composeRigidWriteback(leaf: ViewLeaf, f: WorkpieceFloat, m: RigidMap): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } {
  const { w, h } = f.rect;
  const { dx0, dy0, dw, dh } = m;
  const dst = leaf.pixels.getRegion(dx0, dy0, dw, dh);
  const src = f.pixels.getRegion(f.rect.x, f.rect.y, w, h);
  for (let v = 0; v < dh; v++) {
    for (let u = 0; u < dw; u++) {
      const sx = m.m11 * u + m.m12 * v + m.s0x;
      const sy = m.m21 * u + m.m22 * v + m.s0y;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;   // 护栏（合法映射不该出界）
      const si = (sy * w + sx) * 4;
      const fa = src[si + 3];
      if (fa === 0) continue;
      const di = (v * dw + u) * 4;
      if (fa === 255) {
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
        continue;
      }
      const la = dst[di + 3];
      const inv = (255 - fa);
      const outA = fa + Math.round(la * inv / 255);
      if (outA === 0) { dst[di + 3] = 0; continue; }
      // straight rgb：加权平均（权 = 各自贡献的覆盖率）
      const wf = fa * 255, wl = la * inv;
      dst[di]     = Math.round((src[si]     * wf + dst[di]     * wl) / (wf + wl));
      dst[di + 1] = Math.round((src[si + 1] * wf + dst[di + 1] * wl) / (wf + wl));
      dst[di + 2] = Math.round((src[si + 2] * wf + dst[di + 2] * wl) / (wf + wl));
      dst[di + 3] = outA;
    }
  }
  return { x: dx0, y: dy0, w: dw, h: dh, data: dst };
}
