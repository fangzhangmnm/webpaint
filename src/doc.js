// PaintDoc = 模型层（无 DOM）。
//
// 一张 doc 由若干 layer 组成。每个 layer 自带一个固定分辨率的 OffscreenCanvas
// （或退化到 <canvas>）。doc 不负责显示 —— 显示是 Board 的事。
//
// 一期约定（手感优先）：
// - 固定分辨率 2048×2048（DEFAULT_DOC_SIZE）。
// - 初始一个 "图层 1"。后续阶段才上多图层 UI。
// - 没有持久化（proposal："甚至没保存的情况下"）。但 doc 的 API 已经按"会被序列化"
//   去设计 —— 后期换 IndexedDB / OneDrive / 自定义文件格式时不需要重构模型。

export const DEFAULT_DOC_SIZE = 2048;

// 兼容 OffscreenCanvas（Safari 16.4+）和回退到 HTMLCanvas
function makeBitmap(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    try { return new OffscreenCanvas(w, h); } catch (_) { /* 某些上下文禁用 */ }
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

let _layerIdCounter = 1;

// 层 bbox 长大时给的边距，防 stamp 进出边界反复 realloc
const BBOX_GROW_MARGIN = 32;

export class Layer {
  constructor({ width, height, name } = {}) {
    this.id = _layerIdCounter++;
    this.name = name || `图层 ${this.id}`;
    this.visible = true;
    this.opacity = 1;
    this.mode = "source-over";       // Canvas2D globalCompositeOperation
    // bbox = layer canvas 在 doc 坐标系下的位置 + 实际 canvas 尺寸。
    // phase 1：bbox = 全 doc，行为和老版一致；future：新建空层时 bbox=0
    // 第一颗 stamp 才分配；擦干净时 lazy shrink。
    this.docW = width;
    this.docH = height;
    this.bboxX = 0;
    this.bboxY = 0;
    this.bboxW = width;
    this.bboxH = height;
    this.canvas = makeBitmap(width, height);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "low";
  }
  // 给 board.drawImage / 旧代码用。返回 canvas 实际尺寸 = bbox 尺寸。
  get width() { return this.bboxW; }
  get height() { return this.bboxH; }

  // 确保 doc 坐标 rect [x0,y0,x1,y1] 落在 bbox 内；不在则 grow canvas。
  // - 加 BBOX_GROW_MARGIN 防 stamp 反复出入边界
  // - clamp 在 doc 边界内（rect 完全在 doc 外 → no-op）
  // - 旧 canvas drawImage 到新 canvas 的对应位置，旧像素保留
  ensureBbox(x0, y0, x1, y1) {
    // 已覆盖
    if (x0 >= this.bboxX && y0 >= this.bboxY &&
        x1 <= this.bboxX + this.bboxW && y1 <= this.bboxY + this.bboxH) return;
    const m = BBOX_GROW_MARGIN;
    let nx  = Math.floor(Math.min(this.bboxX, x0 - m));
    let ny  = Math.floor(Math.min(this.bboxY, y0 - m));
    let nx1 = Math.ceil(Math.max(this.bboxX + this.bboxW, x1 + m));
    let ny1 = Math.ceil(Math.max(this.bboxY + this.bboxH, y1 + m));
    // clamp 到 doc 边界
    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    nx1 = Math.min(this.docW, nx1);
    ny1 = Math.min(this.docH, ny1);
    const nw = nx1 - nx;
    const nh = ny1 - ny;
    if (nw <= 0 || nh <= 0) return;     // 整块在 doc 外
    if (nw === this.bboxW && nh === this.bboxH && nx === this.bboxX && ny === this.bboxY) return;
    const nc = makeBitmap(nw, nh);
    const nctx = nc.getContext("2d", { willReadFrequently: false });
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "low";
    // 把旧 canvas 内容画到新 canvas 的对应位置
    if (this.bboxW > 0 && this.bboxH > 0) {
      nctx.drawImage(this.canvas, this.bboxX - nx, this.bboxY - ny);
    }
    this.canvas = nc;
    this.ctx = nctx;
    this.bboxX = nx;
    this.bboxY = ny;
    this.bboxW = nw;
    this.bboxH = nh;
  }

  // doc 坐标采样（吸色用）。落在 bbox 外 → 透明。
  sampleAt(docX, docY) {
    const lx = docX - this.bboxX;
    const ly = docY - this.bboxY;
    if (lx < 0 || ly < 0 || lx >= this.bboxW || ly >= this.bboxH) {
      return [0, 0, 0, 0];
    }
    try {
      return this.ctx.getImageData(lx, ly, 1, 1).data;
    } catch {
      return [0, 0, 0, 0];
    }
  }

  // 整个 layer 当前像素的快照（给 undo 用）。包含 bbox 信息，restore 时
  // 会换 canvas + 复位 bbox。
  snapshot() {
    return {
      bboxX: this.bboxX, bboxY: this.bboxY,
      bboxW: this.bboxW, bboxH: this.bboxH,
      imageData: this.ctx.getImageData(0, 0, this.bboxW, this.bboxH),
    };
  }

  // 把快照里的像素 + bbox 还原。必要时 realloc canvas。
  restoreFromSnapshot(snap) {
    if (this.bboxW !== snap.bboxW || this.bboxH !== snap.bboxH) {
      this.canvas = makeBitmap(snap.bboxW, snap.bboxH);
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = "low";
    }
    this.bboxX = snap.bboxX;
    this.bboxY = snap.bboxY;
    this.bboxW = snap.bboxW;
    this.bboxH = snap.bboxH;
    if (snap.imageData) {
      this.ctx.putImageData(snap.imageData, 0, 0);
    } else if (snap.bitmap) {
      this.ctx.clearRect(0, 0, this.bboxW, this.bboxH);
      this.ctx.drawImage(snap.bitmap, 0, 0);
    }
  }
}

export class PaintDoc {
  constructor({ width = DEFAULT_DOC_SIZE, height = DEFAULT_DOC_SIZE } = {}) {
    this.width = width;
    this.height = height;
    this.layers = [new Layer({ width, height, name: "图层 1" })];
    this.activeIndex = 0;
    // 背景色：手感期固定白纸。后期开 doc.background 概念时再补。
    this.backgroundColor = "#ffffff";
  }

  get activeLayer() {
    return this.layers[this.activeIndex] || null;
  }

  setActive(index) {
    if (index < 0 || index >= this.layers.length) return;
    this.activeIndex = index;
  }

  // 清空当前 layer 像素（不删 layer）。
  clearActiveLayer() {
    const L = this.activeLayer;
    if (!L) return;
    L.ctx.clearRect(0, 0, L.width, L.height);
  }

  // 整张 doc 的像素 dump（旧 API 兼容；新代码直接用 Layer.snapshot()）。
  snapshotActiveLayer() {
    const L = this.activeLayer;
    if (!L) return null;
    return L.snapshot();
  }
  restoreActiveLayer(snap) {
    const L = this.activeLayer;
    if (!L || !snap) return;
    L.restoreFromSnapshot(snap);
  }
}

// 按设备 RAM + 画布分辨率 算图层数上限。**悲观估计**：每层按占满 doc 算
// （不假设 bbox 省内存），这样即使用户把每一层都画满也不会爆。bbox 实际
// 省的内存是"赚的"，cap 不靠它兜底。
//
// 公式：
//   layerBudgetMB = clamp(deviceMemory × 1024 × 0.15, 64, 192)
//     - 0.15 留 85% 给 OS / 别的 tab / 浏览器开销 / 我们自己的 stroke buffer / undo
//       blob / erase composite / 屏幕 canvas / JS heap
//     - 下限 64 MB（至少 2 层）
//     - 上限 192 MB（不让单 doc 把整个 canvas 池吃光）
//   perLayerMB = canvas_area × 4 / 1e6           // 最坏每层占满
//   max = clamp(budget / per, 2, 64)
//
// `navigator.deviceMemory` 在 Chrome/Edge/Firefox 有，**Safari iOS 没有**，
// fallback 当 4 GB（保守，撑得起入门 iPad）。
export function computeMaxLayers(canvasW, canvasH) {
  const deviceMemoryGB = navigator.deviceMemory ?? 4;
  const deviceMemoryMB = deviceMemoryGB * 1024;
  const budgetMB = Math.max(64, Math.min(192, deviceMemoryMB * 0.15));
  const perLayerMB = (canvasW * canvasH * 4) / 1e6;
  const n = Math.floor(budgetMB / Math.max(1, perLayerMB));
  return Math.max(2, Math.min(64, n));
}
