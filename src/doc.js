// 反煤气灯：硬编码模块版本，app.js 启动时对账。
export const MODULE_VERSION = "v22-2026-05-26";

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

export class Layer {
  constructor({ width, height, name } = {}) {
    this.id = _layerIdCounter++;
    this.name = name || `图层 ${this.id}`;
    this.visible = true;
    this.opacity = 1;
    this.mode = "source-over";       // Canvas2D globalCompositeOperation
    this.canvas = makeBitmap(width, height);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    // PERF: stamp 缩放 drawImage 走 bilinear 足够；high 在某些浏览器是 lanczos
    // 之类的贵活儿，每颗 stamp 都付一次代价没意义
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "low";
    // 像素左上原点，Canvas2D 默认即如此。
  }
  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }
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

  // 整张 doc 的像素 dump（导出 / undo 用 —— 一期 undo 走整图快照，简单粗暴）。
  snapshotActiveLayer() {
    const L = this.activeLayer;
    if (!L) return null;
    return L.ctx.getImageData(0, 0, L.width, L.height);
  }
  restoreActiveLayer(imageData) {
    const L = this.activeLayer;
    if (!L || !imageData) return;
    L.ctx.putImageData(imageData, 0, 0);
  }
}
