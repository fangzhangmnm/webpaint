// v258 逆时针旋转画布 90° 验收。
// 问题陈述：
//   - 输入：doc W×H + 若干 layer（各带 bbox + canvas 像素）+ 可选 selection。
//   - 输出：doc 尺寸 H×W；坐标 (x,y)→(y, W-x)；旋转 4 次 = 恒等（尺寸与 bbox 都回原）。
// 纯数字层验证 bbox 公式 + 尺寸互换 + 4 次恒等；像素层用 stub canvas 验方向（一个角点）。
import { describe, it, assert, eq } from "./runner.mjs";

// ---- stub canvas：支持 setTransform / drawImage（轴对齐 + 90° 旋转矩阵）/ getImageData / putImageData ----
//   仅覆盖 doc.rotate90CCW / flipHorizontal 用到的仿射（无缩放、整数平移、90° 旋转）。
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
  fillRect(x, y, w, h) {
    const { data, width } = this.cv;
    // 测试只用 fillStyle 纯色全填；解析成 RGBA
    const [r, g, b] = parseColor(this.fillStyle);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  // drawImage(src, dx, dy)：把 src 每个像素经当前 transform 映射到本 canvas。
  drawImage(src, dx, dy) {
    const [a, b, c, d, e, f] = this._t;
    const sw = src.width, sh = src.height;
    const sd = src.getContext("2d").cv.data;
    const { data, width, height } = this.cv;
    for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
      // src 像素中心 (sx+0.5, sy+0.5)，先加 (dx,dy) 再过 transform
      const ux = sx + 0.5 + (dx || 0), uy = sy + 0.5 + (dy || 0);
      const tx = a * ux + c * uy + e;
      const ty = b * ux + d * uy + f;
      const px = Math.floor(tx), py = Math.floor(ty);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const si = (sy * sw + sx) * 4;
      const di = (py * width + px) * 4;
      data[di] = sd[si]; data[di + 1] = sd[si + 1]; data[di + 2] = sd[si + 2]; data[di + 3] = sd[si + 3];
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
}
function parseColor(s) {
  if (s === "#fff" || s === "#ffffff") return [255, 255, 255];
  if (s === "#f00" || s === "#ff0000") return [255, 0, 0];
  if (s === "#00f" || s === "#0000ff") return [0, 0, 255];
  return [0, 0, 0];
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); this._ctx = new StubCtx(this); }
  getContext() { return this._ctx; }
}
// 每个 it() 开头重装本文件 stub（避免别的 test 文件在 import 时覆盖 globalThis.OffscreenCanvas）。
// import 完还原原 OffscreenCanvas，不污染不设 stub 的 test 文件（跨文件共享全局）。
const _prevOSC = globalThis.OffscreenCanvas;
function useStub() { globalThis.OffscreenCanvas = StubCanvas; }
useStub();
// doc.js makeBitmap 在无 OffscreenCanvas 时走 document.createElement；这里 OffscreenCanvas 已设，足够。

const { PaintDoc, Layer } = await import("../src/doc.ts");
const { Selection } = await import("../src/selection.js");
globalThis.OffscreenCanvas = _prevOSC;

// 直接验证 bbox 旋转公式（纯数字，不碰像素）
function expectedBbox(b, W) {
  return { x: b.bboxY, y: W - (b.bboxX + b.bboxW), w: b.bboxH, h: b.bboxW };
}

describe("doc.rotate90CCW · 纯数字 bbox + 尺寸", () => {
  it("尺寸 W↔H 互换", () => {
    useStub();
    const doc = new PaintDoc({ width: 10, height: 4 });
    doc.rotate90CCW();
    eq(doc.width, 4, "新宽=旧高");
    eq(doc.height, 10, "新高=旧宽");
  });

  it("bbox 按公式 newX=bboxY, newY=W-(bboxX+bboxW), newW=bboxH, newH=bboxW", () => {
    useStub();
    const doc = new PaintDoc({ width: 20, height: 12 });
    // 手动放一个非满 bbox 的层
    const L = doc.layers[0];
    L.bboxX = 3; L.bboxY = 2; L.bboxW = 5; L.bboxH = 4;
    L.canvas = new StubCanvas(5, 4); L.ctx = L.canvas.getContext("2d");
    const exp = expectedBbox({ bboxX: 3, bboxY: 2, bboxW: 5, bboxH: 4 }, 20);
    doc.rotate90CCW();
    eq(L.bboxX, exp.x, "newX");
    eq(L.bboxY, exp.y, "newY");
    eq(L.bboxW, exp.w, "newW");
    eq(L.bboxH, exp.h, "newH");
    eq(L.docW, 12, "L.docW 更新为新宽");
    eq(L.docH, 20, "L.docH 更新为新高");
  });

  it("旋转 4 次 = 恒等（尺寸 + bbox 都回原）", () => {
    useStub();
    const doc = new PaintDoc({ width: 20, height: 12 });
    const L = doc.layers[0];
    L.bboxX = 3; L.bboxY = 2; L.bboxW = 5; L.bboxH = 4;
    L.canvas = new StubCanvas(5, 4); L.ctx = L.canvas.getContext("2d");
    const orig = { w: doc.width, h: doc.height, bx: L.bboxX, by: L.bboxY, bw: L.bboxW, bh: L.bboxH };
    for (let k = 0; k < 4; k++) doc.rotate90CCW();
    eq(doc.width, orig.w, "宽回原");
    eq(doc.height, orig.h, "高回原");
    eq(L.bboxX, orig.bx, "bboxX 回原");
    eq(L.bboxY, orig.by, "bboxY 回原");
    eq(L.bboxW, orig.bw, "bboxW 回原");
    eq(L.bboxH, orig.bh, "bboxH 回原");
  });
});

describe("doc.rotate90CCW · 像素方向（一个角点）", () => {
  it("旧 doc 左上角像素 (0,0) → 新 doc 左下角 (0, W-1=H'-1)", () => {
    useStub();
    // W=4, H=2 → 新 doc 2×4。在旧 (0,0) 放红，验证旋转后落到新左下 (0,3)。
    const doc = new PaintDoc({ width: 4, height: 2 });
    const L = doc.layers[0];   // 满 bbox 4×2
    // 整层涂透明，仅 (0,0) = 红
    const d = L.canvas.getContext("2d").cv.data;
    for (let i = 0; i < d.length; i++) d[i] = 0;
    d[0] = 255; d[3] = 255;   // (0,0) 红不透明
    doc.rotate90CCW();
    eq(doc.width, 2, "新宽=2");
    eq(doc.height, 4, "新高=4");
    // 新 doc (x,y) = 旧 (0,0)→(0, W-0)=(0,4)，像素中心落在新局部 → 验证 alpha 出现在底行 y=3
    const nd = L.canvas.getContext("2d").cv;
    const W2 = L.bboxW;   // 新 bbox 宽 = 旧高 2
    // 新左下角 (0, H'-1) = (0,3)
    const idx = (3 * W2 + 0) * 4;
    assert(nd.data[idx + 3] === 255, `左上角应旋到新左下 (0,3)，实测该处 alpha=${nd.data[idx + 3]}`);
    // 新左上 (0,0) 应为空（旧右上 (W,0) 才映射到这）
    assert(nd.data[3] === 0, `新左上 (0,0) 应空，实测 alpha=${nd.data[3]}`);
  });
});

describe("Selection.rotated90CCW · bbox 公式 + 4 次恒等", () => {
  it("bbox 公式与 4 次恒等", () => {
    useStub();
    const s0 = Selection.full(5, 4, 3, 2);   // bbox (3,2) 5×4，doc 取 20×12
    const W = 20;
    const exp = expectedBbox({ bboxX: 3, bboxY: 2, bboxW: 5, bboxH: 4 }, W);
    const s1 = s0.rotated90CCW(20, 12);
    eq(s1.bboxX, exp.x, "selX");
    eq(s1.bboxY, exp.y, "selY");
    eq(s1.bboxW, exp.w, "selW");
    eq(s1.bboxH, exp.h, "selH");
    // 4 次回原：尺寸 20×12 →(旋)→ 12×20 →20×12 →12×20 →20×12
    let s = s0, dims = [[20, 12], [12, 20], [20, 12], [12, 20]];
    for (let k = 0; k < 4; k++) s = s.rotated90CCW(dims[k][0], dims[k][1]);
    eq(s.bboxX, s0.bboxX, "sel bboxX 回原");
    eq(s.bboxY, s0.bboxY, "sel bboxY 回原");
    eq(s.bboxW, s0.bboxW, "sel bboxW 回原");
    eq(s.bboxH, s0.bboxH, "sel bboxH 回原");
  });
});
