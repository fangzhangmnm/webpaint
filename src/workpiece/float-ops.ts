// float-ops —— 浮层变换的 3 个 DocumentOperator（0.4 S6，spec: journal/20260721 Architecture.md :208-230）。
//
//   LiftFloatOp      lift 的一瞬间：(清选区 → 建 float tiles → 源层挖洞) 一个整点。操作型。
//   FloatTransformOp 调 transform：只 swap transform metadata（每次拖动/切模式一个整点）。操作型。
//   DropFloatOp      收摊浮层（accept/reject 的收尾微步；像素落层由调用方 pre-applied 走 ops.pixels）。
//
// 像素路径全走 typed-array（getRegion/putRegion + materializeMaskRegion），零 Canvas2D —— node 全测，
// 且 S5 报告点名的 materializeMaskCanvas 过渡口在 lift 链上就此退场。
//
// 所有权（对齐 batch1 句柄纪律）：FloatState 整体在 internals ↔ undo 包之间移交（同一时刻一个 owner）；
// prevSelection 沿 S5 的链：doc.selection → lift 包（undo 时装回 doc）。驱逐/截断经 disposeData 释放。
//
// reject 的 identity 写回（不走 warp 采样器）= composeIdentityWriteback：straight-alpha source-over，
// 语义 ≡「identity 变换下的 commit」——stamp 保留、float 落在其上（spec:220-225）。调用方（引擎）
// pre-applied 后走 ops.pixels 事务型入栈，本文件只出纯函数。

import {
  DocumentOperator, Workpiece,
  type OpResult, type WorkpieceInternals,
  type FloatState, type FloatTransformMeta, type FloatRect, type WorkpieceFloat,
} from "./workpiece.ts";
import { findNodeById, eachLeaf, disposeLayerSnap, type Layer, type LayerSnap, type PaintDoc } from "../doc.ts";
import { LayerPixels } from "../gl/tile-pixels.ts";
import type { Selection } from "../selection.ts";

let _floatIdCounter = 1;

// ---- 配额估计（同 LayerSnap 规：raw 记 0 走共享池配额，压缩后按压缩字节/refCount）----
export function estimateFloatPixelBytes(lp: LayerPixels): number {
  let sum = 0;
  for (const h of lp.handles()) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}
function estimateFloatStateBytes(fs: FloatState | null): number {
  if (!fs) return 0;
  let sum = 0;
  for (const f of fs.floats) sum += estimateFloatPixelBytes(f.pixels);
  return sum;
}
function estimateSnapBytes(snap: LayerSnap | null | undefined): number {
  if (!snap) return 0;
  let sum = 0;
  for (const [, h] of snap.pixels.tiles) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}
function estimateSelectionBytes(sel: Selection | null): number {
  if (!sel || sel.disposed) return 0;
  let sum = 0;
  for (const h of sel.tileHandles()) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}

export function cloneFloatMeta(t: FloatTransformMeta): FloatTransformMeta {
  return {
    gizmoBbox: { ...t.gizmoBbox },
    mesh: t.mesh.map((row) => row.map((p) => ({ x: p.x, y: p.y }))),
    meshN: t.meshN,
    mode: t.mode,
    uniformAspect: t.uniformAspect,
  };
}

function leafById(doc: PaintDoc, id: number): Layer | null {
  const n = findNodeById(doc.layers, id);
  return n && !n.isGroup ? (n as Layer) : null;
}

// ============ 像素纯函数（typed-array；node 全测） ============

// leaf ∩ selection → 浮层像素（trim 到非透明内容紧 bbox；不足 2×2 → null，v232 误触级别）。
// sel=null = 隐式整层全选（fallbackFullLayer）。纯读，不动 leaf。
export function extractFloatPixels(leaf: Layer, sel: Selection | null): WorkpieceFloat | null {
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
// 纯函数：调用方经 leaf.putImageData 落层（保 Layer 物化缓存失效）；全透明化的 tile 由
// putRegion 自动回收（dirty 标记 → GL 增量重传，路径同旧 editRegion）。
export function composeCutHole(leaf: Layer, sel: Selection | null, region: FloatRect): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null {
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
export function applyRegionBuf(leaf: Layer, r: { x: number; y: number; w: number; h: number; data: Uint8ClampedArray }): void {
  leaf.putImageData(r.x, r.y, { width: r.w, height: r.h, data: r.data } as unknown as ImageData);
}

// reject 的 identity 写回：float 像素在原 rect 处 source-over 落到 leaf 当前内容之上
// （straight-alpha 合成；stamp 保留、float 在其上；无重采样）。返回合成好的 region 缓冲，
// 调用方负责 leaf.putImageData（保 Layer 物化缓存失效）。
export function composeIdentityWriteback(leaf: Layer, f: WorkpieceFloat): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } {
  const { x, y, w, h } = f.rect;
  const dst = leaf.pixels.getRegion(x, y, w, h);
  const src = f.pixels.getRegion(x, y, w, h);
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
    // straight rgb：加权平均（权 = 各自贡献的覆盖率）
    const wf = fa * 255, wl = la * inv;
    dst[i]     = Math.round((src[i]     * wf + dst[i]     * wl) / (wf + wl));
    dst[i + 1] = Math.round((src[i + 1] * wf + dst[i + 1] * wl) / (wf + wl));
    dst[i + 2] = Math.round((src[i + 2] * wf + dst[i + 2] * wl) / (wf + wl));
    dst[i + 3] = outA;
  }
  return { x, y, w, h, data: dst };
}

// ============ ① LiftFloatOp ============
// lift 整点：(建 float tiles → cut 挖洞 → 清选区 → floatState 入 internals)。
// 对称 swap 三元组 {floatState, 各源层像素快照, selection} 整体换向——undo 回到 lift 前
// （洞复原、选区回来、浮层消失），redo 回到 lift 后。
// ignoreSelection：无视 doc.selection 按整层 lift（导入图片自动变换用——旧选区照样被清进 undo 包）。
export interface LiftFloatArgs { nodeId: number; cut: boolean; fallbackFullLayer: boolean; ignoreSelection?: boolean }
export interface LiftSwapData {
  floats: FloatState | null;
  leafSnaps: { layerId: number; snap: LayerSnap }[];
  selection: { v: Selection | null };
}
export class LiftFloatOp extends DocumentOperator<LiftFloatArgs, LiftSwapData> {
  readonly kind = "liftFloat";
  forward(w: Workpiece, args: LiftFloatArgs, data: LiftSwapData | undefined): OpResult<LiftSwapData> {
    const its = this.mut(w);
    const doc = its.doc;
    if (data === undefined) {                        // 首跑：bake（纯读）→ 全部成功才 mutate（原子）
      if (its.floats) return { ok: false, msg: "float already active" };
      const node = findNodeById(doc.layers, args.nodeId);
      if (!node) return { ok: false, msg: "node gone" };
      const sel = args.ignoreSelection ? null : doc.selection;
      if (!sel && !args.fallbackFullLayer) return { ok: false, msg: "no selection" };
      const leaves: Layer[] = [];
      if (node.isGroup) eachLeaf(node.children, (L) => leaves.push(L));   // 含隐藏叶（整组一起动）
      else leaves.push(node as Layer);
      const baked: { leaf: Layer; float: WorkpieceFloat }[] = [];
      for (const leaf of leaves) {
        const f = extractFloatPixels(leaf, sel);
        if (f) baked.push({ leaf, float: f });
      }
      if (!baked.length) return { ok: false, msg: "no pixels" };
      // mutate：先拍源层快照，再挖洞
      const leafSnaps = baked.map((b) => ({ layerId: b.leaf.id, snap: b.leaf.snapshot() }));
      if (args.cut) {
        for (const b of baked) {
          // 洞区域 = 提取时的 内容∩选区（trim 前的界；trim 掉的边缘本就透明，挖不挖等价——
          //   用 sel bbox ∩ 内容框，与旧 bakeSource 的 editRegion(sel.bbox) 语义一致）
          const content = b.leaf.pixels.contentBounds(true);
          if (!content) continue;
          const x0 = sel ? Math.max(content.x, sel.bboxX) : content.x;
          const y0 = sel ? Math.max(content.y, sel.bboxY) : content.y;
          const x1 = sel ? Math.min(content.x + content.w, sel.bboxX + sel.bboxW) : content.x + content.w;
          const y1 = sel ? Math.min(content.y + content.h, sel.bboxY + sel.bboxH) : content.y + content.h;
          const hole = composeCutHole(b.leaf, sel, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
          if (hole) applyRegionBuf(b.leaf, hole);
        }
      }
      // gizmo 框 = 可见 source rect 并集（隐藏叶随组动但不定框；全隐藏兜底 = 全部）
      const vis = baked.filter((b) => b.leaf.visible);
      const rects = (vis.length ? vis : baked).map((b) => b.float.rect);
      let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
      for (const r of rects) {
        if (r.x < gx0) gx0 = r.x;
        if (r.y < gy0) gy0 = r.y;
        if (r.x + r.w > gx1) gx1 = r.x + r.w;
        if (r.y + r.h > gy1) gy1 = r.y + r.h;
      }
      const gizmoBbox = { x: gx0, y: gy0, w: gx1 - gx0, h: gy1 - gy0 };
      its.floats = {
        floats: baked.map((b) => b.float),
        transform: {
          gizmoBbox,
          mesh: [
            [{ x: gizmoBbox.x, y: gizmoBbox.y }, { x: gizmoBbox.x + gizmoBbox.w, y: gizmoBbox.y }],
            [{ x: gizmoBbox.x, y: gizmoBbox.y + gizmoBbox.h }, { x: gizmoBbox.x + gizmoBbox.w, y: gizmoBbox.y + gizmoBbox.h }],
          ],
          meshN: 2,
          mode: "free",
          uniformAspect: gizmoBbox.w / Math.max(1, gizmoBbox.h),
        },
      };
      const prevSel = doc.selection;                 // 所有权 → undo 包（spec:213 lift 清选区）
      doc.selection = null;
      return { ok: true, replaced: { floats: null, leafSnaps, selection: { v: prevSel } } };
    }
    const swapped = this._swap(its, data);
    return swapped ? { ok: true, replaced: swapped } : { ok: false, msg: "layer gone" };
  }
  backward(w: Workpiece, _args: LiftFloatArgs, data: LiftSwapData): OpResult<LiftSwapData> {
    const swapped = this._swap(this.mut(w), data);
    return swapped ? { ok: true, replaced: swapped } : { ok: false, msg: "layer gone" };
  }
  // 三元组整体换向。先验证所有层还在（半应用 = 不可恢复，宁 fail 整步）。
  private _swap(its: WorkpieceInternals, data: LiftSwapData): LiftSwapData | null {
    const doc = its.doc;
    const leaves: Layer[] = [];
    for (const s of data.leafSnaps) {
      const L = leafById(doc, s.layerId);
      if (!L) return null;
      leaves.push(L);
    }
    const curSnaps = data.leafSnaps.map((s, i) => ({ layerId: s.layerId, snap: leaves[i].snapshot() }));
    data.leafSnaps.forEach((s, i) => {
      leaves[i].restoreFromSnapshot(s.snap);
      disposeLayerSnap(s.snap);                      // 已消费（restore 装 acquire 副本）
    });
    const curFloats = its.floats;
    its.floats = data.floats;
    const curSel = { v: doc.selection };
    doc.selection = data.selection.v;                // 所有权移交 doc
    return { floats: curFloats, leafSnaps: curSnaps, selection: curSel };
  }
  override estimateQuotaBytes(_a: LiftFloatArgs, data: LiftSwapData | undefined): number {
    if (!data) return 512;
    let sum = 512 + estimateFloatStateBytes(data.floats) + estimateSelectionBytes(data.selection.v);
    for (const s of data.leafSnaps) sum += estimateSnapBytes(s.snap);
    return sum;
  }
  override disposeData(_a: LiftFloatArgs, data: LiftSwapData | undefined): void {
    if (!data) return;
    for (const s of data.leafSnaps) disposeLayerSnap(s.snap);
    data.leafSnaps.length = 0;
    if (data.selection.v && !data.selection.v.disposed) data.selection.v.dispose();
    data.selection.v = null;
    if (data.floats) {
      for (const f of data.floats.floats) f.pixels.dispose();
      data.floats = null;
    }
  }
}

// ============ ② FloatTransformOp ============
// 只 swap transform metadata（纯数值，无句柄）。每次拖动手势/模式切换 = 一个整点
// （拖动中引擎只动 live 预览网格，抬手才入栈——同 stroke 的事务型节奏）。
export interface FloatTransformArgs { after: FloatTransformMeta }
export class FloatTransformOp extends DocumentOperator<FloatTransformArgs, { t: FloatTransformMeta }> {
  readonly kind = "floatTransform";
  forward(w: Workpiece, args: FloatTransformArgs, data: { t: FloatTransformMeta } | undefined): OpResult<{ t: FloatTransformMeta }> {
    const its = this.mut(w);
    if (!its.floats) return { ok: false, msg: "no float" };
    const cur = its.floats.transform;
    its.floats.transform = cloneFloatMeta(data ? data.t : args.after);
    return { ok: true, replaced: { t: cur } };
  }
  backward(w: Workpiece, _args: FloatTransformArgs, data: { t: FloatTransformMeta }): OpResult<{ t: FloatTransformMeta }> {
    const its = this.mut(w);
    if (!its.floats) return { ok: false, msg: "no float" };
    const cur = its.floats.transform;
    its.floats.transform = cloneFloatMeta(data.t);
    return { ok: true, replaced: { t: cur } };
  }
}

// ============ ③ DropFloatOp ============
// 收摊浮层：floatState 在 internals ↔ 包 之间整体换向。accept/reject 的收尾微步
// （像素落层已由调用方 pre-applied 经 ops.pixels 入栈，与本步同一个 compound 整点）。
export class DropFloatOp extends DocumentOperator<{ reason?: string }, { fs: FloatState | null }> {
  readonly kind = "dropFloat";
  forward(w: Workpiece, _args: { reason?: string }, data: { fs: FloatState | null } | undefined): OpResult<{ fs: FloatState | null }> {
    const its = this.mut(w);
    if (data === undefined) {
      if (!its.floats) return { ok: false, msg: "no float" };
      const fs = its.floats;
      its.floats = null;
      return { ok: true, replaced: { fs } };
    }
    return { ok: true, replaced: this._swap(its, data) };
  }
  backward(w: Workpiece, _args: { reason?: string }, data: { fs: FloatState | null }): OpResult<{ fs: FloatState | null }> {
    return { ok: true, replaced: this._swap(this.mut(w), data) };
  }
  private _swap(its: WorkpieceInternals, data: { fs: FloatState | null }): { fs: FloatState | null } {
    const cur = its.floats;
    its.floats = data.fs;
    return { fs: cur };
  }
  override estimateQuotaBytes(_a: { reason?: string }, data: { fs: FloatState | null } | undefined): number {
    return 512 + estimateFloatStateBytes(data?.fs ?? null);
  }
  override disposeData(_a: { reason?: string }, data: { fs: FloatState | null } | undefined): void {
    if (data?.fs) {
      for (const f of data.fs.floats) f.pixels.dispose();
      data.fs = null;
    }
  }
}
