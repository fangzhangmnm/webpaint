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
  constructor({ width, height, name, empty = false } = {}) {
    this.id = _layerIdCounter++;
    this.name = name || `图层 ${this.id}`;
    this.visible = true;
    this.opacity = 1;
    this.mode = "source-over";       // Canvas2D globalCompositeOperation
    this.docW = width;
    this.docH = height;
    if (empty) {
      // 空层：bbox 为 0，canvas 1×1 占位（避免 null ctx 引用爆栈）。
      // 第一颗 stamp 触发 ensureBbox 后才真分配。这样新建图层 ≈ 0 内存。
      this.bboxX = 0;
      this.bboxY = 0;
      this.bboxW = 0;
      this.bboxH = 0;
      this.canvas = makeBitmap(1, 1);
    } else {
      // 老路径（doc 初始层）：bbox = 全 doc，行为同 v32
      this.bboxX = 0;
      this.bboxY = 0;
      this.bboxW = width;
      this.bboxH = height;
      this.canvas = makeBitmap(width, height);
    }
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
  // - empty 层（bboxW/H=0）首次 ensureBbox 时直接按 rect 分配，不和占位
  //   1×1 canvas 求 union（否则 bbox 会无谓延伸到 (0,0)）
  ensureBbox(x0, y0, x1, y1) {
    const isEmpty = this.bboxW <= 0 || this.bboxH <= 0;
    if (!isEmpty &&
        x0 >= this.bboxX && y0 >= this.bboxY &&
        x1 <= this.bboxX + this.bboxW && y1 <= this.bboxY + this.bboxH) return;
    const m = BBOX_GROW_MARGIN;
    let nx, ny, nx1, ny1;
    if (isEmpty) {
      nx = x0 - m; ny = y0 - m;
      nx1 = x1 + m; ny1 = y1 + m;
    } else {
      nx  = Math.min(this.bboxX, x0 - m);
      ny  = Math.min(this.bboxY, y0 - m);
      nx1 = Math.max(this.bboxX + this.bboxW, x1 + m);
      ny1 = Math.max(this.bboxY + this.bboxH, y1 + m);
    }
    nx = Math.floor(nx);
    ny = Math.floor(ny);
    nx1 = Math.ceil(nx1);
    ny1 = Math.ceil(ny1);
    // clamp 到 doc 边界
    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    nx1 = Math.min(this.docW, nx1);
    ny1 = Math.min(this.docH, ny1);
    const nw = nx1 - nx;
    const nh = ny1 - ny;
    if (nw <= 0 || nh <= 0) return;     // 整块在 doc 外
    if (!isEmpty && nw === this.bboxW && nh === this.bboxH && nx === this.bboxX && ny === this.bboxY) return;
    const nc = makeBitmap(nw, nh);
    const nctx = nc.getContext("2d", { willReadFrequently: false });
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "low";
    if (!isEmpty) {
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
    if (this.bboxW <= 0 || this.bboxH <= 0) return [0, 0, 0, 0];
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
  // 会换 canvas + 复位 bbox。empty 层 imageData=null。
  snapshot() {
    if (this.bboxW <= 0 || this.bboxH <= 0) {
      return { bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
    }
    return {
      bboxX: this.bboxX, bboxY: this.bboxY,
      bboxW: this.bboxW, bboxH: this.bboxH,
      imageData: this.ctx.getImageData(0, 0, this.bboxW, this.bboxH),
    };
  }

  // 把快照里的像素 + bbox 还原。必要时 realloc canvas。
  restoreFromSnapshot(snap) {
    const targetW = Math.max(1, snap.bboxW);   // 1×1 占位给 empty
    const targetH = Math.max(1, snap.bboxH);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas = makeBitmap(targetW, targetH);
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
      this.ctx.clearRect(0, 0, targetW, targetH);
      this.ctx.drawImage(snap.bitmap, 0, 0);
    } else {
      // empty snapshot：清空占位 1×1
      this.ctx.clearRect(0, 0, targetW, targetH);
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
    // 选区（一等公民）。null = 没选区 = 所有像素都可作用。详见 docs/lasso-and-selection.md。
    //   { bboxX, bboxY, bboxW, bboxH, maskCanvas } —— maskCanvas alpha = mask（255 内 / 0 外）
    this.selection = null;
  }

  get activeLayer() {
    return this.layers[this.activeIndex] || null;
  }

  get maxLayers() {
    return computeMaxLayers(this.width, this.height);
  }

  setActive(index) {
    if (index < 0 || index >= this.layers.length) return false;
    this.activeIndex = index;
    return true;
  }

  setActiveById(id) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return false;
    this.activeIndex = i;
    return true;
  }

  // 新建 empty 层，插在 active 之上。返回新层 / null（封顶或非法）。
  addLayer(name) {
    if (this.layers.length >= this.maxLayers) return null;
    const L = new Layer({
      width: this.width,
      height: this.height,
      name: name || `图层 ${_layerIdCounter}`,
      empty: true,
    });
    const insertAt = this.activeIndex + 1;
    this.layers.splice(insertAt, 0, L);
    this.activeIndex = insertAt;
    return L;
  }

  // 删除指定层（id）。最后一层不可删（doc 永远至少 1 层）。
  removeLayer(id) {
    if (this.layers.length <= 1) return false;
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    if (this.activeIndex >= this.layers.length) this.activeIndex = this.layers.length - 1;
    if (this.activeIndex < 0) this.activeIndex = 0;
    return true;
  }

  // 按 layerSpec 在 index 处插入一层（**用 spec.id**，不走 auto-increment）。
  // 给 history undo "removeLayer" / redo "addLayer" 用。
  // layerSpec: { id, name, visible, opacity, mode, bboxX, bboxY, bboxW, bboxH,
  //   imageData?, bitmap? }   —— 像素数据走 Layer.restoreFromSnapshot 同形 snap
  insertLayerAt(index, spec) {
    if (this.layers.length >= this.maxLayers) return false;
    const L = new Layer({
      width: this.width,
      height: this.height,
      name: spec.name,
      empty: true,
    });
    L.id = spec.id;         // 关键：保留原 id 让历史上的 stroke entry 仍能引用
    if (typeof spec.visible === "boolean") L.visible = spec.visible;
    if (typeof spec.opacity === "number") L.opacity = spec.opacity;
    if (typeof spec.mode === "string") L.mode = spec.mode;
    L.restoreFromSnapshot({
      bboxX: spec.bboxX | 0, bboxY: spec.bboxY | 0,
      bboxW: spec.bboxW | 0, bboxH: spec.bboxH | 0,
      imageData: spec.imageData || null,
      bitmap: spec.bitmap || null,
    });
    const i = Math.max(0, Math.min(index, this.layers.length));
    this.layers.splice(i, 0, L);
    if (this.activeIndex >= i) this.activeIndex++;
    // 防止 _layerIdCounter 撞到一个 spec.id（避免后续 addLayer 复用 id）
    if (spec.id >= _layerIdCounter) _layerIdCounter = spec.id + 1;
    return true;
  }

  // 给 setLayerProp / renameLayer 用：按 id 查 layer
  findLayer(id) {
    return this.layers.find((l) => l.id === id) || null;
  }

  // 上移 / 下移（toward = +1 上，-1 下）。bottom 是 layers[0]，top 是末尾。
  // 注意：UI 里"图层 1 在最上面"是常见 anime 工作流；但 doc.layers 数组 0 是底，
  // 用 UI 渲染时倒序即可，doc 本身不翻。
  moveLayer(id, toward) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return false;
    const j = i + toward;
    if (j < 0 || j >= this.layers.length) return false;
    const [L] = this.layers.splice(i, 1);
    this.layers.splice(j, 0, L);
    if (this.activeIndex === i) this.activeIndex = j;
    else if (this.activeIndex === j) this.activeIndex = i;
    return true;
  }

  // 清空当前 layer 像素（不删 layer）。bbox 复位为 empty（释放 canvas）。
  clearActiveLayer() {
    const L = this.activeLayer;
    if (!L) return;
    L.bboxX = 0;
    L.bboxY = 0;
    L.bboxW = 0;
    L.bboxH = 0;
    L.canvas = makeBitmap(1, 1);
    L.ctx = L.canvas.getContext("2d", { willReadFrequently: false });
    L.ctx.imageSmoothingEnabled = true;
    L.ctx.imageSmoothingQuality = "low";
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
