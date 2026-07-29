// marching-ants —— 蚂蚁线深模块（S5，v0.4.6；spec:255「蚂蚁线抽一个深模块，自己持久化」）。
//
// 职责：Selection（gray8 tile mask）→ 轮廓 polyline 链（board 画黑白相间虚线用）。
// 缓存：**自持**，WeakMap keyed by Selection 对象身份——Selection 不可变，换选区必换对象，
//   缓存天然自失效、互不干扰（旧版把 _outlineChains 挂在 Selection 内部，职责漂到 mask 值对象上；
//   spec 点名蚂蚁线不是 workpiece/selection 的职责 → 收进本模块）。
// 计算时机：首次请求同步算（选区一变下一帧就要画蚂蚁线，异步化只会闪空；旧版也是同步 O(bbox)，
//   iPad 实测扛得住）。若未来大 doc 出现卡顿，切片重算再走 background-sync-jobs——留在 S7/S8 观察。
// v0.6.43（user：「像素改成 boundary tracing」）：marching squares（半格中点+45°切角）→
//   **像素边界阶梯轮廓**（整数格；每个入选像素的裸露边直接发段）。所见轮廓 = 将被操作的像素集
//   真边界，像素画视角严格阶梯。阈值 >128 与 Selection.morphed/消费端二值化一致（选区已全二值）。

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

// ============ 内部：像素边界阶梯描边（boundary tracing） ============

// 每个入选像素（>128）的四条边里，邻居不入选的那些边 → 整数格线段。链化后 = 阶梯轮廓。
// O(bboxW×bboxH)，一次性（antsOutline 缓存）。出界视 0（mask 占满 bbox 边时也有轮廓）。
function extractMaskOutline(sel: Selection): Float32Array {
  const w = sel.bboxW, h = sel.bboxH;
  if (w < 1 || h < 1) return new Float32Array(0);
  const { data } = sel.bboxMask();
  const segs: number[] = [];
  const on = (x: number, y: number) => (x < 0 || x >= w || y < 0 || y >= h) ? 0 : (data[y * w + x] > 128 ? 1 : 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      const X = sel.bboxX + x, Y = sel.bboxY + y;
      if (!on(x, y - 1)) segs.push(X, Y, X + 1, Y);
      if (!on(x, y + 1)) segs.push(X, Y + 1, X + 1, Y + 1);
      if (!on(x - 1, y)) segs.push(X, Y, X, Y + 1);
      if (!on(x + 1, y)) segs.push(X + 1, Y, X + 1, Y + 1);
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
