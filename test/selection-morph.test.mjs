// Selection.morphed 验收（v242）：硬 expand/shrink 选区编辑 op。
// 纯算法 + bbox 放置；用极简 2D-canvas stub 跑端到端（node 无 OffscreenCanvas）。
import { describe, it, assert } from "./runner.mjs";

// ---- 极简 canvas stub（只够 Selection.full / morphed 用）----
class StubCtx {
  constructor(cv) { this.cv = cv; this.fillStyle = "#000"; this.globalCompositeOperation = "source-over"; }
  fillRect(x, y, w, h) {
    const { data, width } = this.cv;
    // 测试只用 fillStyle="#fff" 全填 → 一律白不透明
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
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
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData(img, dx, dy) {
    const { data, width } = this.cv;
    for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
      const si = (yy * img.width + xx) * 4;
      const di = ((dy + yy) * width + (dx + xx)) * 4;
      data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2]; data[di + 3] = img.data[si + 3];
    }
  }
  drawImage() { throw new Error("stub drawImage unused"); }
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); this._ctx = new StubCtx(this); }
  getContext() { return this._ctx; }
}
globalThis.OffscreenCanvas = StubCanvas;

const { Selection } = await import("../src/selection.js");

// mask 局部 (lx,ly) 的 alpha
function maskA(sel, lx, ly) {
  return sel.maskCanvas.getContext("2d").getImageData(0, 0, sel.bboxW, sel.bboxH).data[(ly * sel.bboxW + lx) * 4 + 3];
}
// 数 alpha=255 的像素
function count255(sel) {
  const d = sel.maskCanvas.getContext("2d").getImageData(0, 0, sel.bboxW, sel.bboxH).data;
  let n = 0; for (let i = 0; i < sel.bboxW * sel.bboxH; i++) if (d[i * 4 + 3] === 255) n++;
  return n;
}

describe("Selection.morphed · 硬扩张/收缩", () => {
  it("expand 0 = 原对象不变（同引用）", () => {
    const s = Selection.full(4, 4, 3, 3);
    assert(s.morphed(0, 20, 20) === s, "radius 0 应原样返回");
  });

  it("expand +1：实心 4×4 → bbox 外扩 1，6×6 全实心", () => {
    const s = Selection.full(4, 4, 3, 3);          // (3,3) 处 4×4
    const e = s.morphed(1, 20, 20);
    assert(e.bboxX === 2 && e.bboxY === 2, `bbox 应外扩到 (2,2)，实得 (${e.bboxX},${e.bboxY})`);
    assert(e.bboxW === 6 && e.bboxH === 6, `应 6×6，实得 ${e.bboxW}×${e.bboxH}`);
    assert(count255(e) === 36, `应全 36 实心，实得 ${count255(e)}`);
  });

  it("shrink −1：实心 4×4 → bbox 不变，中心 2×2 留存", () => {
    const s = Selection.full(4, 4, 3, 3);
    const e = s.morphed(-1, 20, 20);
    assert(e.bboxX === 3 && e.bboxY === 3 && e.bboxW === 4 && e.bboxH === 4, "收缩沿用原 bbox");
    assert(count255(e) === 4, `中心 2×2=4 留存，实得 ${count255(e)}`);
    assert(maskA(e, 1, 1) === 255 && maskA(e, 2, 2) === 255, "中心实");
    assert(maskA(e, 0, 0) === 0 && maskA(e, 3, 3) === 0, "四角被腐蚀");
  });

  it("shrink −2：实心 4×4 腐蚀光 → null", () => {
    const s = Selection.full(4, 4, 3, 3);
    assert(s.morphed(-2, 20, 20) === null, "腐蚀到空应返 null");
  });

  it("expand 在 doc 边界 clamp：贴角 2×2 + expand 5 → 不越界", () => {
    const s = Selection.full(2, 2, 0, 0);          // 贴 (0,0)
    const e = s.morphed(5, 3, 3);                   // doc 仅 3×3
    assert(e.bboxX === 0 && e.bboxY === 0, "左上 clamp 到 0");
    assert(e.bboxW === 3 && e.bboxH === 3, `右下 clamp 到 doc 3×3，实得 ${e.bboxW}×${e.bboxH}`);
    assert(count255(e) === 9, "clamp 后全实心 9");
  });
});
