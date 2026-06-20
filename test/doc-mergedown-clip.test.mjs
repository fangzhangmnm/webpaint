// v258 剪裁层向下合并验收。
// 问题陈述：
//   - active 是剪裁层(clippingMask)，under 是其基底(非剪裁)：合并时 active 像素先 dst-in 裁到
//     under 的 alpha（只在基底不透明处可见），再按 active.mode×opacity 烤进 under；结果 under 非剪裁。
//   - active 与 under 都剪裁（剪裁链内）：合并后结果仍 clippingMask=true。
//   - under 剪裁、active 普通 → reason "clipping-under"，拒绝。
//   - 返回值含 activeSpec.clippingMask + underBeforeClipping + resultClipping（undo/redo 还原用）。
// 用支持 globalAlpha + source-over/destination-in 的 stub canvas 验像素结果。
import { describe, it, assert, eq } from "./runner.mjs";

class StubCtx {
  constructor(cv) {
    this.cv = cv;
    this.fillStyle = "#000";
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "low";
    this._t = [1, 0, 0, 1, 0, 0];
  }
  setTransform(a, b, c, d, e, f) { this._t = [a, b, c, d, e, f]; }
  clearRect(x, y, w, h) {
    const { data, width } = this.cv;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
    }
  }
  fillRect() { throw new Error("fillRect 未在此测试用到"); }
  // 仅支持整数平移 transform（merge-down 全是 drawImage(src, intDx, intDy)）。
  drawImage(src, dx, dy) {
    const [a, b, c, d] = this._t;
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error("stub 只支持平移");
    const ex = this._t[4], ey = this._t[5];
    const ddx = Math.round((dx || 0) + ex), ddy = Math.round((dy || 0) + ey);
    const sw = src.width, sh = src.height;
    const sd = src.getContext("2d").cv.data;
    const { data, width, height } = this.cv;
    const op = this.globalCompositeOperation;
    const ga = this.globalAlpha;
    if (op === "destination-in") {
      // 保留 dst，其 alpha *= src 在该处 alpha/255；src 覆盖不到的 dst → alpha 0
      for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
        const sx = px - ddx, sy = py - ddy;
        let sa = 0;
        if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) sa = sd[(sy * sw + sx) * 4 + 3];
        const di = (py * width + px) * 4;
        data[di + 3] = Math.round(data[di + 3] * (sa / 255));
      }
      return;
    }
    // source-over（含 globalAlpha）
    for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
      const px = sx + ddx, py = sy + ddy;
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const si = (sy * sw + sx) * 4;
      const srcA = (sd[si + 3] / 255) * ga;
      if (srcA <= 0) continue;
      const di = (py * width + px) * 4;
      const dstA = data[di + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) { data[di] = data[di + 1] = data[di + 2] = data[di + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) {
        data[di + k] = Math.round((sd[si + k] * srcA + data[di + k] * dstA * (1 - srcA)) / outA);
      }
      data[di + 3] = Math.round(outA * 255);
    }
  }
  getImageData(x, y, w, h) {
    const { data, width } = this.cv;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * width + (x + xx)) * 4;
      const di = (yy * w + xx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
    return { data: out, width: w, height: h };
  }
  putImageData(img, dx, dy) {
    const { data, width } = this.cv;
    for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
      const si = (yy * img.width + xx) * 4;
      const di = ((dy + yy) * width + (dx + xx)) * 4;
      data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2]; data[di + 3] = img.data[si + 3];
    }
  }
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); this._ctx = new StubCtx(this); }
  getContext() { return this._ctx; }
}
// 本文件 stub 的 fillRect 故意抛错（验证 merge-down 不用 fillRect）。但 globalThis.OffscreenCanvas
// 是跨 test 文件共享的：若让本 stub 在 import 后常驻，别的 test（selection-morph 用 fillRect）会被它毒。
// 解法：import 期不污染全局——记下原 OffscreenCanvas，只在本文件 it() 内 useStub()，跑完不还原也行
// （别的文件 it() 自己 useStub），但为保险：捕获原值供需要时参考。本文件每个 it() 开头 useStub()。
const _prevOSC = globalThis.OffscreenCanvas;
function useStub() { globalThis.OffscreenCanvas = StubCanvas; }
useStub();
const { PaintDoc } = await import("../src/doc.ts");
globalThis.OffscreenCanvas = _prevOSC;   // import 完还原，避免毒到不设 stub 的 test 文件

// 填一个 layer 的整块矩形（doc 坐标 bbox=全块），rgba
function fillLayer(L, w, h, r, g, b, a) {
  L.bboxX = 0; L.bboxY = 0; L.bboxW = w; L.bboxH = h;
  L.canvas = new StubCanvas(w, h);
  L.ctx = L.canvas.getContext("2d");
  const d = L.canvas.data;
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
}
// 让 under 只有左半 alpha（右半透明），用于验剪裁
function fillLeftHalf(L, w, h, r, g, b) {
  L.bboxX = 0; L.bboxY = 0; L.bboxW = w; L.bboxH = h;
  L.canvas = new StubCanvas(w, h);
  L.ctx = L.canvas.getContext("2d");
  const d = L.canvas.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = x < w / 2;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = inside ? 255 : 0;
  }
}
function px(L, x, y) {
  const d = L.canvas.getContext("2d").getImageData(0, 0, L.bboxW, L.bboxH).data;
  const i = ((y - L.bboxY) * L.bboxW + (x - L.bboxX)) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

describe("mergeDownLayer · 剪裁层向下合并到基底", () => {
  it("active 剪裁(满红) + under 基底(左半蓝) → 合并：右半被裁掉(透明)，左半=红覆盖蓝", () => {
    useStub();
    const doc = new PaintDoc({ width: 4, height: 2 });
    const base = doc.layers[0];
    fillLeftHalf(base, 4, 2, 0, 0, 255);   // under 基底：x<2 蓝不透明，x>=2 透明
    const clip = doc.addLayer("剪裁");
    fillLayer(clip, 4, 2, 255, 0, 0, 255); // active 剪裁层：满红
    clip.clippingMask = true;
    doc.activeIndex = doc.layers.indexOf(clip);

    const r = doc.mergeDownLayer(clip);
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
    const doc = new PaintDoc({ width: 4, height: 2 });
    const baseLayer = doc.layers[0];      // 真正基底（非剪裁）
    fillLayer(baseLayer, 4, 2, 0, 255, 0, 255);
    const clipA = doc.addLayer("剪裁A");
    fillLayer(clipA, 4, 2, 0, 0, 255, 255);
    clipA.clippingMask = true;
    const clipB = doc.addLayer("剪裁B");
    fillLayer(clipB, 4, 2, 255, 0, 0, 255);
    clipB.clippingMask = true;
    doc.activeIndex = doc.layers.indexOf(clipB);

    const r = doc.mergeDownLayer(clipB);   // B 合到 A（两者都剪裁）
    assert(r.ok, "链内合并应成功");
    eq(r.resultClipping, true, "链内合并结果仍剪裁");
    const merged = doc.findLayer(r.underId);
    eq(merged.clippingMask, true, "合并后仍 clippingMask=true（仍剪到原基底）");
  });

  it("under 剪裁、active 普通 → reason clipping-under（拒绝）", () => {
    useStub();
    const doc = new PaintDoc({ width: 4, height: 2 });
    const base = doc.layers[0];
    fillLayer(base, 4, 2, 0, 255, 0, 255);
    const clipUnder = doc.addLayer("剪裁");
    fillLayer(clipUnder, 4, 2, 0, 0, 255, 255);
    clipUnder.clippingMask = true;
    const normal = doc.addLayer("普通");
    fillLayer(normal, 4, 2, 255, 0, 0, 255);
    doc.activeIndex = doc.layers.indexOf(normal);

    const r = doc.mergeDownLayer(normal);  // 普通合到剪裁层上
    assert(!r.ok, "应拒绝");
    eq(r.reason, "clipping-under", "reason=clipping-under");
  });

  it("普通向下合并仍工作（回归）", () => {
    useStub();
    const doc = new PaintDoc({ width: 4, height: 2 });
    const base = doc.layers[0];
    fillLayer(base, 4, 2, 0, 255, 0, 255);
    const top = doc.addLayer("上");
    fillLayer(top, 4, 2, 255, 0, 0, 255);
    doc.activeIndex = doc.layers.indexOf(top);
    const r = doc.mergeDownLayer(top);
    assert(r.ok, "普通合并应成功");
    eq(r.resultClipping, false, "普通合并非剪裁");
    const m = doc.findLayer(r.underId);
    const p = px(m, 0, 0);
    assert(p[0] === 255 && p[1] === 0 && p[2] === 0, `上层红盖下层绿，实得 ${p}`);
  });
});
