// marching-ants —— 蚂蚁线深模块（S5，v0.4.6；spec:255「蚂蚁线抽一个深模块，自己持久化」）。
//
// 职责：Selection（gray8 tile mask）→ 轮廓 polyline 链（board 画黑白相间虚线用）。
// 缓存：**自持**，WeakMap keyed by Selection 对象身份——Selection 不可变，换选区必换对象，
//   缓存天然自失效、互不干扰（旧版把 _outlineChains 挂在 Selection 内部，职责漂到 mask 值对象上；
//   spec 点名蚂蚁线不是 workpiece/selection 的职责 → 收进本模块）。
// 计算时机：首次请求同步算（选区一变下一帧就要画蚂蚁线，异步化只会闪空；旧版也是同步 O(bbox)，
//   iPad 实测扛得住）。若未来大 doc 出现卡顿，切片重算再走 background-sync-jobs——留在 S7/S8 观察。
// 算法原封不动搬自旧 selection.ts（marching squares + 链化，v113 virtual padding），
//   阈值 >128 与 Selection.morphed 的二值化一致。输入换成 gray8 窄读口（不再 getImageData RGBA）。

import type { Selection } from "./selection.ts";

const _cache = new WeakMap<Selection, Float32Array[]>();

// 返回 Array<Float32Array>，每条 = 一条 polyline（doc 坐标，[x,y,x,y,...]）。
export function antsOutline(sel: Selection): Float32Array[] {
  let chains = _cache.get(sel);
  if (!chains) {
    chains = chainMaskOutline(extractMaskOutline(sel));
    _cache.set(sel, chains);
  }
  return chains;
}

// ============ 内部：marching squares 描边 ============

// 从 gray8 mask 抽轮廓 polyline 段。输出 Float32Array 平铺 [x0,y0,x1,y1,...]（doc 坐标）。
// O(bboxW×bboxH)，一次性（antsOutline 缓存）。
function extractMaskOutline(sel: Selection): Float32Array {
  const w = sel.bboxW, h = sel.bboxH;
  if (w <= 1 || h <= 1) return new Float32Array(0);
  const { data } = sel.bboxMask();
  const segs: number[] = [];
  // v113: virtual padding —— mask 外侧一圈 0，让 mask 占满边时也能 detect transition。
  const alpha = (x: number, y: number) => (x < 0 || x >= w || y < 0 || y >= h) ? 0 : (data[y * w + x] > 128 ? 1 : 0);
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const a00 = alpha(x, y), a10 = alpha(x + 1, y), a01 = alpha(x, y + 1), a11 = alpha(x + 1, y + 1);
      const idx = a00 | (a10 << 1) | (a11 << 2) | (a01 << 3);
      if (idx === 0 || idx === 15) continue;
      const cxL = Math.max(0, Math.min(w, x)), cxR = Math.max(0, Math.min(w, x + 1));
      const cyT = Math.max(0, Math.min(h, y)), cyB = Math.max(0, Math.min(h, y + 1));
      const xL = sel.bboxX + cxL, xR = sel.bboxX + cxR, xM = (xL + xR) / 2;
      const yT = sel.bboxY + cyT, yB = sel.bboxY + cyB, yM = (yT + yB) / 2;
      switch (idx) {
        case 1:  segs.push(xM, yT, xL, yM); break;
        case 2:  segs.push(xM, yT, xR, yM); break;
        case 3:  segs.push(xL, yM, xR, yM); break;
        case 4:  segs.push(xR, yM, xM, yB); break;
        case 5:  segs.push(xM, yT, xR, yM); segs.push(xM, yB, xL, yM); break;
        case 6:  segs.push(xM, yT, xM, yB); break;
        case 7:  segs.push(xM, yB, xL, yM); break;
        case 8:  segs.push(xL, yM, xM, yB); break;
        case 9:  segs.push(xM, yT, xM, yB); break;
        case 10: segs.push(xM, yT, xL, yM); segs.push(xR, yM, xM, yB); break;
        case 11: segs.push(xR, yM, xM, yB); break;
        case 12: segs.push(xL, yM, xR, yM); break;
        case 13: segs.push(xM, yT, xR, yM); break;
        case 14: segs.push(xM, yT, xL, yM); break;
      }
    }
  }
  return new Float32Array(segs);
}

// 把碎段链成连续 polyline（dash 才能沿整条边流，否则每段当 subpath dash 重置）。
function chainMaskOutline(segs: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  if (segs.length < 4) return out;
  const n = segs.length / 4;
  const key = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const endpoints = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k0 = key(segs[i * 4], segs[i * 4 + 1]);
    const k1 = key(segs[i * 4 + 2], segs[i * 4 + 3]);
    if (!endpoints.has(k0)) endpoints.set(k0, []);
    if (!endpoints.has(k1)) endpoints.set(k1, []);
    endpoints.get(k0)!.push(i * 2);
    endpoints.get(k1)!.push(i * 2 + 1);
  }
  const used = new Uint8Array(n);
  const findUnused = (k: string) => {
    const arr = endpoints.get(k);
    if (!arr) return -1;
    for (const slot of arr) if (!used[slot >> 1]) return slot;
    return -1;
  };
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [segs[i * 4], segs[i * 4 + 1], segs[i * 4 + 2], segs[i * 4 + 3]];
    while (true) {
      const ex = chain[chain.length - 2], ey = chain[chain.length - 1];
      const slot = findUnused(key(ex, ey));
      if (slot < 0) break;
      const segIdx = slot >> 1; used[segIdx] = 1; const si = segIdx * 4;
      if (slot & 1) chain.push(segs[si], segs[si + 1]);
      else          chain.push(segs[si + 2], segs[si + 3]);
    }
    while (true) {
      const sx = chain[0], sy = chain[1];
      const slot = findUnused(key(sx, sy));
      if (slot < 0) break;
      const segIdx = slot >> 1; used[segIdx] = 1; const si = segIdx * 4;
      if (slot & 1) chain.unshift(segs[si], segs[si + 1]);
      else          chain.unshift(segs[si + 2], segs[si + 3]);
    }
    out.push(new Float32Array(chain));
  }
  return out;
}
