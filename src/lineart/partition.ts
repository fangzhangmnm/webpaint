// 线稿分区总管线（论文 Fourey–Tschumperlé–Revoy 2018）：
//   RGBA → 白底亮度二值化 → 笔画半宽估计（EDT 中位数）+ 粗笔细化腐蚀（§3）
//   → 端点检测（border.ts，§4）→ 笔画闭合（closing.ts，§5）
//   → 背景 4-连通区 label（§6.1）→ 洋葱剥皮把 label 推进笔画像素（多源 BFS
//     ≈ 论文的 watershed onion-peel，城市距离代替精确 EDT，逐层确定性传播）。
// 产物 = 全图 label map：每个像素属于哪个「闭合区域」，笔画像素也被两侧区域
// 瓜分到中线——魔棒 tap 查表即得区域 mask，颜色自然填到线条下面（消 AA 白边）。
// 纯函数无 DOM，node 直测；app 侧接缝（缓存/Selection 转换）在 src/ 顶层，不进本目录。

import { edtSquared } from "./edt.ts";
import { keypointsFromBinary } from "./border.ts";
import { closeStrokes } from "./closing.ts";
import type { Keypoint } from "./border.ts";
import type { BridgeDebug } from "./closing.ts";

export interface LineartParams {
  /** 白底合成亮度 ≤ 此值（0..255）判为笔画 */
  binarizeThreshold: number;
  /** 法线平滑核半径 L */
  kernelL: number;
  /** 端点曲率阈值 θκ */
  thetaKappa: number;
  /** 样条配对最大距离 px（≤0 关闭） */
  dmax: number;
  /** 法线对置容差角（度） */
  alphaDeg: number;
  /** 样条切线系数 ρ */
  rho: number;
  /** 最小允许背景区面积 */
  amin: number;
  /** 补段最大长度 px（≤0 关闭） */
  smax: number;
  /** 每端点最多闭合笔画数 */
  cmax: number;
  /** 粗笔自动细化（腐蚀到几 px 再分析；论文 §3） */
  erode: boolean;
}

// 论文声称同一组默认参数跑遍全部实验图；这里的数值按同精神取，测试图上调定。
export const DEFAULT_LINEART_PARAMS: LineartParams = {
  binarizeThreshold: 128,
  kernelL: 5,
  thetaKappa: 0.24,
  dmax: 64,
  alphaDeg: 90,
  rho: 1.0,
  amin: 32,
  smax: 48,
  cmax: 2,
  erode: true,
};

export interface LineartPartition {
  w: number;
  h: number;
  /** 每像素区域号 1..regionCount；0 = 无区域（仅整图全笔画的病态情形） */
  labels: Int32Array;
  regionCount: number;
  /** 每区 tight bbox，[label-1] 起 4 元 (x0,y0,x1,y1) 闭区间 */
  bboxes: Int32Array;
  /** 估出的笔画半宽（px），调参/诊断用 */
  strokeHalfWidth: number;
  /** 调试视图（v0.7.4）：检出的端点（腐蚀后坐标）+ 候选桥（含被守卫毙的） */
  keypoints: Keypoint[];
  bridges: BridgeDebug[];
  /** 每像素「陷进真墨水多深」：0=非墨水（背景或虚拟闭合桥）；≥1=原始二值墨水像素到最近
   *  背景的欧氏距离（ceil，封顶 255）。蔓延过滤基底（v0.7.17 像素画模式）：按**原始**墨水算
   *  （非腐蚀后）——粗线腐蚀掉的表皮仍是可见墨水，蔓延小时不该被填。 */
  inkDepth: Uint8Array;
}

/** RGBA（straight alpha）→ 二值笔画图：合成到白底的亮度 ≤ θ 判为笔画。透明 = 白 = 背景。 */
export function binarizeLuma(
  rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, threshold: number,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) {
    const a = rgba[o + 3] / 255;
    const gray = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
    const lum = 255 + (gray - 255) * a;
    if (lum <= threshold) out[i] = 1;
  }
  return out;
}

/** 笔画半宽估计：每个 8-连通笔画组件取「到背景距离」最大值，全体取中位数（§3）。 */
export function strokeHalfWidthMedian(Ib: Uint8Array, w: number, h: number, distSq: Int32Array): number {
  const seen = new Uint8Array(w * h);
  const maxima: number[] = [];
  const stack: number[] = [];
  for (let p0 = 0; p0 < Ib.length; p0++) {
    if (!Ib[p0] || seen[p0]) continue;
    let maxD = 0;
    stack.length = 0;
    stack.push(p0);
    seen[p0] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      if (distSq[p] > maxD) maxD = distSq[p];
      const px = p % w, py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const qx = px + dx, qy = py + dy;
          if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
          const q = qy * w + qx;
          if (Ib[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    maxima.push(Math.sqrt(maxD));
  }
  if (maxima.length === 0) return 0;
  maxima.sort((a, b) => a - b);
  return maxima[maxima.length >> 1];
}

/** 背景（Ic==0）4-连通区 label，1 起编号；顺带记 tight bbox。 */
function labelRegions(Ic: Uint8Array, w: number, h: number): { labels: Int32Array; count: number; bboxes: number[] } {
  const labels = new Int32Array(w * h);
  const bboxes: number[] = [];
  const stack: number[] = [];
  let count = 0;
  for (let p0 = 0; p0 < Ic.length; p0++) {
    if (Ic[p0] !== 0 || labels[p0] !== 0) continue;
    count++;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack.length = 0;
    stack.push(p0);
    labels[p0] = count;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w, py = (p / w) | 0;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && Ic[p - 1] === 0 && labels[p - 1] === 0) { labels[p - 1] = count; stack.push(p - 1); }
      if (px < w - 1 && Ic[p + 1] === 0 && labels[p + 1] === 0) { labels[p + 1] = count; stack.push(p + 1); }
      if (py > 0 && Ic[p - w] === 0 && labels[p - w] === 0) { labels[p - w] = count; stack.push(p - w); }
      if (py < h - 1 && Ic[p + w] === 0 && labels[p + w] === 0) { labels[p + w] = count; stack.push(p + w); }
    }
    bboxes.push(x0, y0, x1, y1);
  }
  return { labels, count, bboxes };
}

/** 洋葱剥皮：多源 BFS 把区域 label 逐层推进笔画像素（含闭合虚线），bbox 同步扩。 */
function propagateUnderStrokes(labels: Int32Array, w: number, h: number, bboxes: number[]): void {
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  // 种子 = 已 label 像素（都是背景区），向 4 邻的未 label（笔画）像素扩
  for (let p = 0; p < labels.length; p++) if (labels[p] !== 0) queue[tail++] = p;
  while (head < tail) {
    const p = queue[head++];
    const lab = labels[p];
    const px = p % w, py = (p / w) | 0;
    for (let d = 0; d < 4; d++) {
      const qx = px + (d === 1 ? 1 : d === 3 ? -1 : 0);
      const qy = py + (d === 2 ? 1 : d === 0 ? -1 : 0);
      if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
      const q = qy * w + qx;
      if (labels[q] !== 0) continue;
      labels[q] = lab;
      const b = (lab - 1) * 4;
      if (qx < bboxes[b]) bboxes[b] = qx;
      if (qy < bboxes[b + 1]) bboxes[b + 1] = qy;
      if (qx > bboxes[b + 2]) bboxes[b + 2] = qx;
      if (qy > bboxes[b + 3]) bboxes[b + 3] = qy;
      queue[tail++] = q;
    }
  }
}

/** 二值笔画图 → 分区（测试与调参入口；buildLineartPartition 的后半段）。 */
export function buildPartitionFromBinary(
  Ib0: Uint8Array, w: number, h: number, params: LineartParams = DEFAULT_LINEART_PARAMS,
): LineartPartition {
  let Ib = Ib0;
  let halfW = 0;
  let hasStroke = false;
  for (let i = 0; i < Ib.length; i++) if (Ib[i]) { hasStroke = true; break; }

  const inkDepth = new Uint8Array(w * h);
  if (hasStroke) {
    // EDT（feature=背景）→ 半宽估计 → 必要时腐蚀细化
    const bg = new Uint8Array(w * h);
    for (let i = 0; i < bg.length; i++) bg[i] = Ib[i] ? 0 : 1;
    const distSq = edtSquared(bg, w, h);
    for (let i = 0; i < Ib.length; i++) {
      if (Ib[i]) inkDepth[i] = Math.min(255, Math.ceil(Math.sqrt(distSq[i])));
    }
    halfW = strokeHalfWidthMedian(Ib, w, h, distSq);
    if (params.erode && halfW > 3) {
      // 目标：细化到 2-3px 半宽；腐蚀半径封顶防细线整段蒸发（断口交给闭合步骤修，论文 §3）
      const r = Math.min(Math.floor(halfW) - 2, 4);
      const rSq = r * r;
      const eroded = new Uint8Array(w * h);
      for (let i = 0; i < Ib.length; i++) if (Ib[i] && distSq[i] > rSq) eroded[i] = 1;
      Ib = eroded;
    }
  }

  const kps = hasStroke
    ? keypointsFromBinary(Ib, w, h, { kernelL: params.kernelL, thetaKappa: params.thetaKappa })
    : [];
  const closed = hasStroke ? closeStrokes(Ib, w, h, kps, params) : null;
  const Ic = closed ? closed.Ic : Ib;

  const { labels, count, bboxes } = labelRegions(Ic, w, h);
  if (count > 0) propagateUnderStrokes(labels, w, h, bboxes);
  return {
    w, h, labels, regionCount: count, bboxes: Int32Array.from(bboxes), strokeHalfWidth: halfW,
    keypoints: kps, bridges: closed ? closed.bridges : [],
    inkDepth,
  };
}

/** 总入口：RGBA → 分区。 */
export function buildLineartPartition(
  rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, params: LineartParams = DEFAULT_LINEART_PARAMS,
): LineartPartition {
  return buildPartitionFromBinary(binarizeLuma(rgba, w, h, params.binarizeThreshold), w, h, params);
}

/** tap 查表：(x,y) 所在区域的 tight-bbox gray8 mask（255/0）。无区域 → null。
 *  bleedPx（v0.7.17 蔓延距离，query-time 参数不碰缓存）：-1=自动（填到中线，现行为）；
 *  ≥0 = 最多陷进真墨水 bleedPx（0=像素画模式，真墨水一个不碰；虚拟闭合桥不是墨水，恒可跨）。 */
export function regionMaskAt(
  part: LineartPartition, x: number, y: number, bleedPx = -1,
): { x: number; y: number; w: number; h: number; mask: Uint8Array } | null {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || xi >= part.w || yi < 0 || yi >= part.h) return null;
  const lab = part.labels[yi * part.w + xi];
  if (lab === 0) return null;
  const b = (lab - 1) * 4;
  const x0 = part.bboxes[b], y0 = part.bboxes[b + 1];
  const bw = part.bboxes[b + 2] - x0 + 1, bh = part.bboxes[b + 3] - y0 + 1;
  const mask = new Uint8Array(bw * bh);
  const capped = bleedPx >= 0 ? Math.min(255, bleedPx) : -1;
  for (let ry = 0; ry < bh; ry++) {
    const row = (y0 + ry) * part.w;
    for (let rx = 0; rx < bw; rx++) {
      const p = row + x0 + rx;
      if (part.labels[p] !== lab) continue;
      if (capped >= 0 && part.inkDepth[p] > capped) continue;
      mask[ry * bw + rx] = 255;
    }
  }
  return { x: x0, y: y0, w: bw, h: bh, mask };
}
