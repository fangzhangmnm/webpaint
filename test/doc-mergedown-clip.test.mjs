// v258 剪裁层向下合并验收（v0.6.39 重写：merge-down 改走 GL render tree 字节合成面——
// setDocCompositorBytes 注入。node 无 GL → 本文件注入一个**测试侧参照合成器**（straight 字节
// source-over + clippingMask + opacity；非 source-over 模式直接抛——真混合模式的对拍在 gl-smoke）。
// 守的语义不变：剪裁 dst-in 到基底 alpha / 链内合并仍剪裁 / clipping-under 拒绝 / undo 三元组。
import { describe, it, assert, eq } from "./runner.mjs";

const { PaintDoc } = await import("../src/doc.ts");
const { setDocCompositorBytes } = await import("../src/doc-render.ts");

// 参照合成器：nodes（结构化叶）自底向上 source-over；clippingMask 叶的 as 乘最近非剪裁基底的 alpha。
// ⚠注入是模块单例、后注入者赢（app-boot 测试 import app.ts 会覆盖成 node 下恒 null 的 board 后端）
// → 每个 it 开头经 useStub() 重注入。
const refCompositor = ((nodes, w, h) => {
  const out = new Uint8ClampedArray(w * h * 4);
  let baseA = null;   // 最近非剪裁叶的原始 alpha 平面
  for (const n of nodes) {
    if (!n.visible) continue;
    if ((n.mode || "source-over") !== "source-over") throw new Error("参照合成器只支持 source-over（混合模式对拍归 gl-smoke）");
    const src = n.pixels.getRegion(0, 0, w, h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      let as = (src[o + 3] / 255) * n.opacity;
      if (n.clippingMask) as *= baseA ? baseA[o + 3] / 255 : 0;
      if (as <= 0) continue;
      const ab = out[o + 3] / 255;
      const ao = as + ab * (1 - as);
      for (let k = 0; k < 3; k++) out[o + k] = Math.round((src[o + k] * as + out[o + k] * ab * (1 - as)) / ao);
      out[o + 3] = Math.round(ao * 255);
    }
    if (!n.clippingMask) baseA = src;
  }
  return { data: out, w, h };
});
const useStub = () => setDocCompositorBytes(refCompositor);

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
const _docs = [], _merges = [];
const mkDoc = () => { const d = new PaintDoc({ width: 4, height: 2 }); _docs.push(d); return d; };
const trackMerge = (r) => { _merges.push(r); return r; };

// 填一个 layer 的整块矩形（tile-SoT：putImageData 纯路径），rgba
function fillLayer(L, w, h, r, g, b, a) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  L.putImageData(0, 0, { width: w, height: h, data: d });
}
// 让 under 只有左半 alpha（右半透明），用于验剪裁
function fillLeftHalf(L, w, h, r, g, b) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = (x < w / 2) ? 255 : 0;
  }
  L.putImageData(0, 0, { width: w, height: h, data: d });
}
function px(L, x, y) { return [...L.sampleAt(x, y)]; }

describe("mergeDownLayer · 剪裁层向下合并到基底", () => {
  it("active 剪裁(满红) + under 基底(左半蓝) → 合并：右半被裁掉(透明)，左半=红覆盖蓝", () => {
    useStub();
    const doc = mkDoc();
    const base = doc.layers[0];
    fillLeftHalf(base, 4, 2, 0, 0, 255);   // under 基底：x<2 蓝不透明，x>=2 透明
    const clip = doc.addLayer("剪裁");
    fillLayer(clip, 4, 2, 255, 0, 0, 255); // active 剪裁层：满红
    clip.clippingMask = true;
    doc.activeIndex = doc.layers.indexOf(clip);

    const r = trackMerge(doc.mergeDownLayer(clip));
    assert(r.ok, `应合并成功，实得 ${JSON.stringify(r)}`);
    eq(r.resultClipping, false, "基底合并结果非剪裁");
    eq(r.underBeforeClipping, false, "under 合并前非剪裁");
    eq(r.activeSpec.clippingMask, true, "activeSpec 记 active 剪裁标志（redo 用）");

    const under = doc.findLayer(r.underId);
    eq(under.clippingMask, false, "合并后 under 保持非剪裁");
    // 左半：红裁进可见 → (255,0,0,255)
    const lp = px(under, 0, 0);
    assert(lp[0] === 255 && lp[1] === 0 && lp[2] === 0 && lp[3] === 255, `左半应红不透明，实得 ${lp}`);
    // 右半：基底透明 → 剪裁层被裁没 → 仍透明
    const rp = px(under, 3, 0);
    assert(rp[3] === 0, `右半应透明（被基底 alpha 裁掉），实得 ${rp}`);
  });

  it("active 与 under 都剪裁（链内）→ 合并结果仍 clippingMask=true", () => {
    useStub();
    const doc = mkDoc();
    const baseLayer = doc.layers[0];      // 真正基底（非剪裁）
    fillLayer(baseLayer, 4, 2, 0, 255, 0, 255);
    const clipA = doc.addLayer("剪裁A");
    fillLayer(clipA, 4, 2, 0, 0, 255, 255);
    clipA.clippingMask = true;
    const clipB = doc.addLayer("剪裁B");
    fillLayer(clipB, 4, 2, 255, 0, 0, 255);
    clipB.clippingMask = true;
    doc.activeIndex = doc.layers.indexOf(clipB);

    const r = trackMerge(doc.mergeDownLayer(clipB));   // B 合到 A（两者都剪裁）
    assert(r.ok, "链内合并应成功");
    eq(r.resultClipping, true, "链内合并结果仍剪裁");
    const merged = doc.findLayer(r.underId);
    eq(merged.clippingMask, true, "合并后仍 clippingMask=true（仍剪到原基底）");
  });

  it("under 剪裁、active 普通 → reason clipping-under（拒绝）", () => {
    useStub();
    const doc = mkDoc();
    const base = doc.layers[0];
    fillLayer(base, 4, 2, 0, 255, 0, 255);
    const clipUnder = doc.addLayer("剪裁");
    fillLayer(clipUnder, 4, 2, 0, 0, 255, 255);
    clipUnder.clippingMask = true;
    const normal = doc.addLayer("普通");
    fillLayer(normal, 4, 2, 255, 0, 0, 255);
    doc.activeIndex = doc.layers.indexOf(normal);

    const r = trackMerge(doc.mergeDownLayer(normal));  // 普通合到剪裁层上
    assert(!r.ok, "应拒绝");
    eq(r.reason, "clipping-under", "reason=clipping-under");
  });

  it("普通向下合并仍工作（回归）", () => {
    useStub();
    const doc = mkDoc();
    const base = doc.layers[0];
    fillLayer(base, 4, 2, 0, 255, 0, 255);
    const top = doc.addLayer("上");
    fillLayer(top, 4, 2, 255, 0, 0, 255);
    doc.activeIndex = doc.layers.indexOf(top);
    const r = trackMerge(doc.mergeDownLayer(top));
    assert(r.ok, "普通合并应成功");
    eq(r.resultClipping, false, "普通合并非剪裁");
    const m = doc.findLayer(r.underId);
    const p = px(m, 0, 0);
    assert(p[0] === 255 && p[1] === 0 && p[2] === 0, `上层红盖下层绿，实得 ${p}`);
  });
});

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
describe("doc-mergedown-clip 收尾", () => {
  it("释放本文件的 doc/merge 快照", async () => {
    const { eachLeaf, disposeLayerSnap, disposeLayerSpec } = await import("../src/doc.ts");
    for (const r of _merges) {
      if (!r || !r.ok) continue;
      disposeLayerSnap(r.underBefore); disposeLayerSnap(r.underAfter); disposeLayerSpec(r.activeSpec);
    }
    for (const d of _docs) { eachLeaf(d.layers, (l) => l.pixels?.dispose?.()); d.selection?.dispose?.(); }
    _docs.length = 0; _merges.length = 0;
    assert(true, "disposed");
  });
});
