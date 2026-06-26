// 偏移接缝（环绕）验收 —— doc.offsetWrap / Selection.offsetWrapped。
// 问题陈述：
//   - 输入：doc W×H + layer 像素（+ 可选 selection）；偏移 (dx,dy)，向右/下为正。
//   - 输出：doc 尺寸不变；像素 new(x,y) = old((x-dx) mod W, (y-dy) mod H)（环绕）；
//           偏移整幅 (W,H) = 恒等；偏移 a 再偏移 (W-a) = 恒等。
// 纯像素层用 stub canvas 验环绕映射（角点）+ 恒等性；selection 验 bbox=整幅。
import { describe, it, assert, eq } from "./runner.mjs";

// ---- stub canvas：drawImage(src, dx, dy) 整数平移 + getImageData（同 doc-rotate 的子集）----
class StubCtx {
  constructor(cv) {
    this.cv = cv;
    this.fillStyle = "#fff";
    this.globalAlpha = 1;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "low";
    this._t = [1, 0, 0, 1, 0, 0];
  }
  setTransform(a, b, c, d, e, f) { this._t = [a, b, c, d, e, f]; }
  fillRect(x, y, w, h) {
    // Selection.full 用纯白全填 mask（alpha=255 内）。测试只需 alpha 正确。
    const { data, width } = this.cv;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = 255;
    }
  }
  clearRect(x, y, w, h) {
    const { data, width } = this.cv;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
    }
  }
  drawImage(src, dx, dy) {
    const [a, b, c, d, e, f] = this._t;
    const sw = src.width, sh = src.height;
    const sd = src.getContext("2d").cv.data;
    const { data, width, height } = this.cv;
    for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
      const ux = sx + 0.5 + (dx || 0), uy = sy + 0.5 + (dy || 0);
      const tx = a * ux + c * uy + e, ty = b * ux + d * uy + f;
      const px = Math.floor(tx), py = Math.floor(ty);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const si = (sy * sw + sx) * 4, di = (py * width + px) * 4;
      data[di] = sd[si]; data[di + 1] = sd[si + 1]; data[di + 2] = sd[si + 2]; data[di + 3] = sd[si + 3];
    }
  }
  getImageData(x, y, w, h) {
    const { data, width } = this.cv;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * width + (x + xx)) * 4, di = (yy * w + xx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
    return { data: out, width: w, height: h };
  }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData(img, dx, dy) {
    const { data, width } = this.cv;
    for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
      const si = (yy * img.width + xx) * 4, di = ((dy + yy) * width + (dx + xx)) * 4;
      data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2]; data[di + 3] = img.data[si + 3];
    }
  }
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); this._ctx = new StubCtx(this); }
  getContext() { return this._ctx; }
}
const _prevOSC = globalThis.OffscreenCanvas;
function useStub() { globalThis.OffscreenCanvas = StubCanvas; }
useStub();

const { PaintDoc } = await import("../src/doc.ts");
const { Selection } = await import("../src/selection.ts");
globalThis.OffscreenCanvas = _prevOSC;

// 在满 bbox 层的 (x,y) 放一个唯一标记色（用 alpha 编码身份：每点 alpha=唯一值）
function markPixel(L, x, y, val) {
  const d = L.canvas.getContext("2d").cv.data;
  const i = (y * L.bboxW + x) * 4;
  d[i] = val; d[i + 1] = val; d[i + 2] = val; d[i + 3] = 255;
}
function alphaAt(L, x, y) {
  const cv = L.canvas.getContext("2d").cv;
  return cv.data[(y * cv.width + x) * 4 + 3];
}
function redAt(L, x, y) {
  const cv = L.canvas.getContext("2d").cv;
  return cv.data[(y * cv.width + x) * 4];
}

describe("doc.offsetWrap · 尺寸不变 + 像素环绕映射", () => {
  it("doc 尺寸偏移后不变", () => {
    useStub();
    const doc = new PaintDoc({ width: 10, height: 6 });
    doc.offsetWrap(3, 2);
    eq(doc.width, 10, "宽不变");
    eq(doc.height, 6, "高不变");
    eq(doc.layers[0].bboxW, 10, "层 bbox 设为整幅宽");
    eq(doc.layers[0].bboxH, 6, "层 bbox 设为整幅高");
  });

  it("偏移 (1,1)：每个角点按 (x+1)%W,(y+1)%H 环绕", () => {
    useStub();
    // W=4,H=2 满 bbox。四角放不同灰度 r，验证落点。
    const doc = new PaintDoc({ width: 4, height: 2 });
    const L = doc.layers[0];
    const d = L.canvas.getContext("2d").cv.data;
    for (let i = 0; i < d.length; i++) d[i] = 0;
    markPixel(L, 0, 0, 10);   // 左上 → (1,1)
    markPixel(L, 3, 0, 20);   // 右上 → (0,1)
    markPixel(L, 0, 1, 30);   // 左下 → (1,0)
    markPixel(L, 3, 1, 40);   // 右下 → (0,0)
    doc.offsetWrap(1, 1);
    eq(redAt(L, 1, 1), 10, "左上(0,0)→(1,1)");
    eq(redAt(L, 0, 1), 20, "右上(3,0)→(0,1) 水平环绕");
    eq(redAt(L, 1, 0), 30, "左下(0,1)→(1,0) 垂直环绕");
    eq(redAt(L, 0, 0), 40, "右下(3,1)→(0,0) 双向环绕");
  });

  it("负偏移也环绕：(-1,0) 把左列移到右边", () => {
    useStub();
    const doc = new PaintDoc({ width: 4, height: 1 });
    const L = doc.layers[0];
    const d = L.canvas.getContext("2d").cv.data;
    for (let i = 0; i < d.length; i++) d[i] = 0;
    markPixel(L, 0, 0, 99);   // 左列 → (-1)%4 = 3
    doc.offsetWrap(-1, 0);
    eq(redAt(L, 3, 0), 99, "(0,0) 在 dx=-1 下环绕到 (3,0)");
  });
});

describe("doc.offsetWrap · 恒等性", () => {
  it("偏移整幅 (W,H) = 无变化", () => {
    useStub();
    const doc = new PaintDoc({ width: 4, height: 2 });
    const L = doc.layers[0];
    const d = L.canvas.getContext("2d").cv.data;
    for (let i = 0; i < d.length; i++) d[i] = 0;
    markPixel(L, 2, 1, 77);
    doc.offsetWrap(4, 2);
    eq(redAt(L, 2, 1), 77, "整幅偏移 = 像素不动");
  });

  it("偏移 a 再偏移 (W-a, H-b) 回到原图", () => {
    useStub();
    const doc = new PaintDoc({ width: 4, height: 2 });
    const L = doc.layers[0];
    const d = L.canvas.getContext("2d").cv.data;
    for (let i = 0; i < d.length; i++) d[i] = 0;
    markPixel(L, 0, 0, 12);
    markPixel(L, 2, 1, 34);
    doc.offsetWrap(1, 1);
    doc.offsetWrap(3, 1);   // 总位移 (4,2) ≡ (0,0)
    eq(redAt(L, 0, 0), 12, "(0,0) 回原");
    eq(redAt(L, 2, 1), 34, "(2,1) 回原");
  });
});

describe("Selection.offsetWrapped · bbox=整幅 + 环绕", () => {
  it("bbox 设为整幅 doc", () => {
    useStub();
    const s0 = Selection.full(3, 2, 1, 1);   // bbox (1,1) 3×2
    const s1 = s0.offsetWrapped(1, 1, 8, 6);
    eq(s1.bboxX, 0, "selX=0");
    eq(s1.bboxY, 0, "selY=0");
    eq(s1.bboxW, 8, "selW=docW");
    eq(s1.bboxH, 6, "selH=docH");
  });
});
