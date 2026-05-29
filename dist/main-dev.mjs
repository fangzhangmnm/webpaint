var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/psd.js
var psd_exports = {};
__export(psd_exports, {
  encodeDocToPsd: () => encodeDocToPsd
});
function packBitsEncodeRow(src) {
  const out = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    let runLen = 1;
    while (i + runLen < len && src[i + runLen] === src[i] && runLen < 128) runLen++;
    if (runLen >= 3) {
      out.push(257 - runLen);
      out.push(src[i]);
      i += runLen;
    } else {
      const litStart = i;
      i++;
      while (i < len && i - litStart < 128) {
        if (i + 2 < len && src[i] === src[i + 1] && src[i + 1] === src[i + 2]) break;
        i++;
      }
      const litLen = i - litStart;
      out.push(litLen - 1);
      for (let j = 0; j < litLen; j++) out.push(src[litStart + j]);
    }
  }
  return Uint8Array.from(out);
}
function packBitsEncodeChannel(data, w, h) {
  if (w === 0 || h === 0) {
    return { rowByteCounts: new Uint16Array(0), encoded: new Uint8Array(0) };
  }
  const rowByteCounts = new Uint16Array(h);
  const rows = new Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    const row = data.subarray(y * w, (y + 1) * w);
    const enc = packBitsEncodeRow(row);
    rowByteCounts[y] = enc.length;
    rows[y] = enc;
    total += enc.length;
  }
  const encoded = new Uint8Array(total);
  let off = 0;
  for (const r of rows) {
    encoded.set(r, off);
    off += r.length;
  }
  return { rowByteCounts, encoded };
}
function splitRGBAChannels(rgba, w, h) {
  const n = w * h;
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = rgba[i * 4];
    g[i] = rgba[i * 4 + 1];
    b[i] = rgba[i * 4 + 2];
    a[i] = rgba[i * 4 + 3];
  }
  return { r, g, b, a };
}
function asciiPascalBytes(name) {
  const arr = [];
  for (let i = 0; i < name.length && arr.length < 255; i++) {
    const c = name.charCodeAt(i);
    arr.push(c < 128 ? c : 63);
  }
  return Uint8Array.from(arr);
}
async function encodeDocToPsd(doc2) {
  const w = new BinaryWriter(64 * 1024);
  const docW = doc2.width;
  const docH = doc2.height;
  w.writeAscii("8BPS");
  w.writeUInt16(1);
  for (let i = 0; i < 6; i++) w.writeUInt8(0);
  w.writeUInt16(4);
  w.writeUInt32(docH);
  w.writeUInt32(docW);
  w.writeUInt16(8);
  w.writeUInt16(3);
  w.writeUInt32(0);
  w.writeUInt32(0);
  const layerMaskLenOff = w.offset;
  w.writeUInt32(0);
  const layerInfoLenOff = w.offset;
  w.writeUInt32(0);
  const layers = doc2.layers;
  w.writeInt16(layers.length);
  const encoded = layers.map((layer) => encodeLayerChannels(layer));
  for (let i = 0; i < layers.length; i++) {
    writeLayerRecord(w, layers[i], encoded[i]);
  }
  for (let i = 0; i < layers.length; i++) {
    writeLayerChannelData(w, layers[i], encoded[i]);
  }
  w.padTo(2);
  const layerInfoLen = w.offset - layerInfoLenOff - 4;
  w.fillUInt32(layerInfoLenOff, layerInfoLen);
  w.writeUInt32(0);
  const layerMaskLen = w.offset - layerMaskLenOff - 4;
  w.fillUInt32(layerMaskLenOff, layerMaskLen);
  writeMergedImage(w, doc2, docW, docH);
  return new Blob([w.toUint8Array()], { type: "image/vnd.adobe.photoshop" });
}
function encodeLayerChannels(layer) {
  const lw = layer.bboxW || 0;
  const lh = layer.bboxH || 0;
  let channels;
  if (lw > 0 && lh > 0) {
    const img = layer.ctx.getImageData(0, 0, lw, lh);
    channels = splitRGBAChannels(img.data, lw, lh);
  } else {
    channels = { r: new Uint8Array(0), g: new Uint8Array(0), b: new Uint8Array(0), a: new Uint8Array(0) };
  }
  const order = [
    { id: -1, data: channels.a },
    { id: 0, data: channels.r },
    { id: 1, data: channels.g },
    { id: 2, data: channels.b }
  ];
  return order.map((ch) => {
    const r = packBitsEncodeChannel(ch.data, lw, lh);
    const length = 2 + 2 * lh + r.encoded.length;
    return { id: ch.id, length, rowByteCounts: r.rowByteCounts, encoded: r.encoded };
  });
}
function writeLayerRecord(w, layer, encChannels) {
  const empty = !(layer.bboxW > 0 && layer.bboxH > 0);
  const top = empty ? 0 : layer.bboxY;
  const left = empty ? 0 : layer.bboxX;
  const bottom = empty ? 0 : layer.bboxY + layer.bboxH;
  const right = empty ? 0 : layer.bboxX + layer.bboxW;
  w.writeUInt32(top);
  w.writeUInt32(left);
  w.writeUInt32(bottom);
  w.writeUInt32(right);
  w.writeUInt16(4);
  for (const ch of encChannels) {
    w.writeInt16(ch.id);
    w.writeUInt32(ch.length);
  }
  w.writeAscii("8BIM");
  const key = PSD_BLEND_MODE[layer.mode] || "norm";
  w.writeAscii(key.length === 4 ? key : (key + "    ").slice(0, 4));
  w.writeUInt8(Math.round((layer.opacity ?? 1) * 255));
  w.writeUInt8(0);
  w.writeUInt8(layer.visible === false ? 2 : 0);
  w.writeUInt8(0);
  const extraOff = w.offset;
  w.writeUInt32(0);
  w.writeUInt32(0);
  w.writeUInt32(0);
  const nameBytes = asciiPascalBytes(layer.name || "Layer");
  w.writeUInt8(nameBytes.length);
  w.writeBytes(nameBytes);
  const consumed = 1 + nameBytes.length;
  const padN = (4 - consumed % 4) % 4;
  for (let i = 0; i < padN; i++) w.writeUInt8(0);
  writeLuni(w, layer.name || "Layer");
  const extraLen = w.offset - extraOff - 4;
  w.fillUInt32(extraOff, extraLen);
}
function writeLuni(w, name) {
  w.writeAscii("8BIM");
  w.writeAscii("luni");
  const lenOff = w.offset;
  w.writeUInt32(0);
  const start = w.offset;
  w.writeUInt32(name.length);
  for (let i = 0; i < name.length; i++) w.writeUInt16(name.charCodeAt(i));
  while ((w.offset - start) % 4 !== 0) w.writeUInt8(0);
  const dataLen = w.offset - start;
  w.fillUInt32(lenOff, dataLen);
}
function writeLayerChannelData(w, layer, encChannels) {
  const lh = layer.bboxH || 0;
  for (const ch of encChannels) {
    w.writeUInt16(1);
    for (let y = 0; y < lh; y++) w.writeUInt16(ch.rowByteCounts[y]);
    w.writeBytes(ch.encoded);
  }
}
function writeMergedImage(w, doc2, docW, docH) {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(docW, docH) : (() => {
    const x = document.createElement("canvas");
    x.width = docW;
    x.height = docH;
    return x;
  })();
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, docW, docH);
  for (const layer of doc2.layers) {
    if (!layer.visible) continue;
    if (!(layer.bboxW > 0 && layer.bboxH > 0)) continue;
    const prevAlpha = ctx.globalAlpha;
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.globalCompositeOperation = layer.mode || "source-over";
    ctx.drawImage(layer.canvas, layer.bboxX, layer.bboxY);
    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevComp;
  }
  const img = ctx.getImageData(0, 0, docW, docH);
  const ch = splitRGBAChannels(img.data, docW, docH);
  w.writeUInt16(1);
  const order = [ch.r, ch.g, ch.b, ch.a];
  const enc = order.map((d) => packBitsEncodeChannel(d, docW, docH));
  for (const e of enc) {
    for (let y = 0; y < docH; y++) w.writeUInt16(e.rowByteCounts[y]);
  }
  for (const e of enc) w.writeBytes(e.encoded);
}
var BinaryWriter, PSD_BLEND_MODE;
var init_psd = __esm({
  "src/psd.js"() {
    BinaryWriter = class {
      constructor(initialCap = 1024) {
        this._buf = new Uint8Array(initialCap);
        this._off = 0;
      }
      get offset() {
        return this._off;
      }
      _grow(n) {
        if (this._off + n <= this._buf.length) return;
        let cap = this._buf.length;
        while (cap < this._off + n) cap *= 2;
        const nb = new Uint8Array(cap);
        nb.set(this._buf);
        this._buf = nb;
      }
      writeUInt8(v) {
        this._grow(1);
        this._buf[this._off++] = v & 255;
      }
      writeUInt16(v) {
        this._grow(2);
        this._buf[this._off++] = v >>> 8 & 255;
        this._buf[this._off++] = v & 255;
      }
      writeUInt32(v) {
        this._grow(4);
        this._buf[this._off++] = v >>> 24 & 255;
        this._buf[this._off++] = v >>> 16 & 255;
        this._buf[this._off++] = v >>> 8 & 255;
        this._buf[this._off++] = v & 255;
      }
      writeInt16(v) {
        this.writeUInt16(v & 65535);
      }
      writeAscii(s) {
        this._grow(s.length);
        for (let i = 0; i < s.length; i++) this._buf[this._off++] = s.charCodeAt(i) & 255;
      }
      writeBytes(arr) {
        this._grow(arr.length);
        this._buf.set(arr, this._off);
        this._off += arr.length;
      }
      padTo(multiple) {
        const r = this._off % multiple;
        if (r === 0) return;
        const n = multiple - r;
        this._grow(n);
        for (let i = 0; i < n; i++) this._buf[this._off++] = 0;
      }
      fillUInt32(at, v) {
        this._buf[at] = v >>> 24 & 255;
        this._buf[at + 1] = v >>> 16 & 255;
        this._buf[at + 2] = v >>> 8 & 255;
        this._buf[at + 3] = v & 255;
      }
      toUint8Array() {
        return this._buf.slice(0, this._off);
      }
    };
    PSD_BLEND_MODE = {
      "source-over": "norm",
      "multiply": "mul ",
      "screen": "scrn",
      "overlay": "over",
      "darken": "dark",
      "lighten": "lite",
      "color-dodge": "div ",
      "color-burn": "idiv",
      "hard-light": "hLit",
      "soft-light": "sLit",
      "difference": "diff",
      "exclusion": "smud",
      "hue": "hue ",
      "saturation": "sat ",
      "color": "colr",
      "luminosity": "lum "
    };
  }
});

// src/version.js
var WEBPAINT_VERSION = "v121-2026-05-29";

// src/doc.js
var DEFAULT_DOC_SIZE = 2048;
function makeBitmap(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      return new OffscreenCanvas(w, h);
    } catch (_) {
    }
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
var _layerIdCounter = 1;
var BBOX_GROW_MARGIN = 32;
var Layer = class {
  constructor({ width, height, name, empty = false } = {}) {
    this.id = _layerIdCounter++;
    this.name = name || `\u56FE\u5C42 ${this.id}`;
    this.visible = true;
    this.opacity = 1;
    this.mode = "source-over";
    this.clippingMask = false;
    this.docW = width;
    this.docH = height;
    if (empty) {
      this.bboxX = 0;
      this.bboxY = 0;
      this.bboxW = 0;
      this.bboxH = 0;
      this.canvas = makeBitmap(1, 1);
    } else {
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
  get width() {
    return this.bboxW;
  }
  get height() {
    return this.bboxH;
  }
  // 确保 doc 坐标 rect [x0,y0,x1,y1] 落在 bbox 内；不在则 grow canvas。
  // - 加 BBOX_GROW_MARGIN 防 stamp 反复出入边界
  // - clamp 在 doc 边界内（rect 完全在 doc 外 → no-op）
  // - 旧 canvas drawImage 到新 canvas 的对应位置，旧像素保留
  // - empty 层（bboxW/H=0）首次 ensureBbox 时直接按 rect 分配，不和占位
  //   1×1 canvas 求 union（否则 bbox 会无谓延伸到 (0,0)）
  ensureBbox(x0, y0, x1, y1) {
    const isEmpty = this.bboxW <= 0 || this.bboxH <= 0;
    if (!isEmpty && x0 >= this.bboxX && y0 >= this.bboxY && x1 <= this.bboxX + this.bboxW && y1 <= this.bboxY + this.bboxH) return;
    const m = BBOX_GROW_MARGIN;
    let nx, ny, nx1, ny1;
    if (isEmpty) {
      nx = x0 - m;
      ny = y0 - m;
      nx1 = x1 + m;
      ny1 = y1 + m;
    } else {
      nx = Math.min(this.bboxX, x0 - m);
      ny = Math.min(this.bboxY, y0 - m);
      nx1 = Math.max(this.bboxX + this.bboxW, x1 + m);
      ny1 = Math.max(this.bboxY + this.bboxH, y1 + m);
    }
    nx = Math.floor(nx);
    ny = Math.floor(ny);
    nx1 = Math.ceil(nx1);
    ny1 = Math.ceil(ny1);
    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    nx1 = Math.min(this.docW, nx1);
    ny1 = Math.min(this.docH, ny1);
    const nw = nx1 - nx;
    const nh = ny1 - ny;
    if (nw <= 0 || nh <= 0) return;
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
      bboxX: this.bboxX,
      bboxY: this.bboxY,
      bboxW: this.bboxW,
      bboxH: this.bboxH,
      imageData: this.ctx.getImageData(0, 0, this.bboxW, this.bboxH)
    };
  }
  // 把快照里的像素 + bbox 还原。必要时 realloc canvas。
  restoreFromSnapshot(snap) {
    const targetW = Math.max(1, snap.bboxW);
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
      this.ctx.clearRect(0, 0, targetW, targetH);
    }
  }
};
var PaintDoc = class {
  constructor({ width = DEFAULT_DOC_SIZE, height = DEFAULT_DOC_SIZE } = {}) {
    this.width = width;
    this.height = height;
    this.layers = [new Layer({ width, height, name: "\u56FE\u5C42 1" })];
    this.activeIndex = 0;
    this.backgroundColor = "#ffffff";
    this.selection = null;
    this.referenceLayerId = null;
  }
  // 取参考层 / 没有就返回 null（不是 active；调用方按需 fallback）
  getReferenceLayer() {
    if (this.referenceLayerId == null) return null;
    return this.layers.find((L) => L.id === this.referenceLayerId) || null;
  }
  // 魔棒 / 油漆桶用的 source：reference 优先，否则 active
  getFloodSourceLayer() {
    return this.getReferenceLayer() || this.activeLayer;
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
  // v97 命名 conflict-free（user：「图层和笔重命名数字总是很怪，而且反而会发生冲突」）：
  // 找现有「图层 N」最大 N，新层 = N+1。避免 _layerIdCounter 跨 session 重启导致碰撞
  addLayer(name) {
    if (this.layers.length >= this.maxLayers) return null;
    const finalName = name || this._nextLayerName();
    const L = new Layer({
      width: this.width,
      height: this.height,
      name: finalName,
      empty: true
    });
    const insertAt = this.activeIndex + 1;
    this.layers.splice(insertAt, 0, L);
    this.activeIndex = insertAt;
    return L;
  }
  _nextLayerName() {
    const re = /^图层\s*(\d+)$/;
    let max = 0;
    for (const L of this.layers) {
      const m = re.exec(L.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `\u56FE\u5C42 ${max + 1}`;
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
      empty: true
    });
    L.id = spec.id;
    if (typeof spec.visible === "boolean") L.visible = spec.visible;
    if (typeof spec.opacity === "number") L.opacity = spec.opacity;
    if (typeof spec.mode === "string") L.mode = spec.mode;
    L.restoreFromSnapshot({
      bboxX: spec.bboxX | 0,
      bboxY: spec.bboxY | 0,
      bboxW: spec.bboxW | 0,
      bboxH: spec.bboxH | 0,
      imageData: spec.imageData || null,
      bitmap: spec.bitmap || null
    });
    const i = Math.max(0, Math.min(index, this.layers.length));
    this.layers.splice(i, 0, L);
    if (this.activeIndex >= i) this.activeIndex++;
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
  // v110: doc 整状态 snapshot（给 crop / resample 等 doc-level transform 的 undo 用）
  // 比单层 snapshot 重得多——含每层 imageData + bbox + 元信息 + selection mask 副本
  snapshotAll() {
    return {
      width: this.width,
      height: this.height,
      activeIndex: this.activeIndex,
      referenceLayerId: this.referenceLayerId,
      selection: _cloneSelection(this.selection),
      layers: this.layers.map((L) => ({
        id: L.id,
        name: L.name,
        visible: L.visible,
        opacity: L.opacity,
        mode: L.mode,
        clippingMask: L.clippingMask,
        snap: L.snapshot()
      }))
    };
  }
  restoreSnapshotAll(snap) {
    if (!snap) return;
    this.width = snap.width;
    this.height = snap.height;
    this.activeIndex = snap.activeIndex;
    this.referenceLayerId = snap.referenceLayerId;
    this.selection = _cloneSelection(snap.selection);
    this.layers = snap.layers.map((s) => {
      const L = new Layer({ width: snap.width, height: snap.height, name: s.name, empty: true });
      L.id = s.id;
      L.visible = s.visible;
      L.opacity = s.opacity;
      L.mode = s.mode;
      L.clippingMask = s.clippingMask;
      L.docW = snap.width;
      L.docH = snap.height;
      L.restoreFromSnapshot(s.snap);
      return L;
    });
  }
  // v112: 裁切 doc 到 rect（doc 坐标 {x, y, w, h}）。
  // v110 偷懒只改 bbox 不真裁 canvas，导致裁后旧像素 bbox 偏到 -X 露在 void 上
  // → user 画的东西落在新 doc 外 (实际是落在旧 bbox 区域)。修：真 clip layer canvas。
  cropTo(rect) {
    const dx = rect.x | 0, dy = rect.y | 0, nw = Math.max(1, rect.w | 0), nh = Math.max(1, rect.h | 0);
    for (const L of this.layers) {
      L.docW = nw;
      L.docH = nh;
      if (L.bboxW <= 0 || L.bboxH <= 0) {
        L.bboxX = 0;
        L.bboxY = 0;
        continue;
      }
      const tL = L.bboxX - dx, tT = L.bboxY - dy;
      const tR = tL + L.bboxW, tB = tT + L.bboxH;
      const newL = Math.max(0, tL), newT = Math.max(0, tT);
      const newR = Math.min(nw, tR), newB = Math.min(nh, tB);
      const newW = newR - newL, newH = newB - newT;
      if (newW <= 0 || newH <= 0) {
        L.bboxX = 0;
        L.bboxY = 0;
        L.bboxW = 0;
        L.bboxH = 0;
        L.canvas = makeBitmap(1, 1);
        L.ctx = L.canvas.getContext("2d", { willReadFrequently: false });
        L.ctx.imageSmoothingEnabled = true;
        L.ctx.imageSmoothingQuality = "low";
        continue;
      }
      const srcX = newL - tL;
      const srcY = newT - tT;
      const nc = makeBitmap(newW, newH);
      const nctx = nc.getContext("2d", { willReadFrequently: false });
      nctx.imageSmoothingEnabled = true;
      nctx.imageSmoothingQuality = "low";
      nctx.drawImage(L.canvas, srcX, srcY, newW, newH, 0, 0, newW, newH);
      L.canvas = nc;
      L.ctx = nctx;
      L.bboxX = newL;
      L.bboxY = newT;
      L.bboxW = newW;
      L.bboxH = newH;
    }
    if (this.selection) {
      const tL = this.selection.bboxX - dx, tT = this.selection.bboxY - dy;
      const tR = tL + this.selection.bboxW, tB = tT + this.selection.bboxH;
      const newL = Math.max(0, tL), newT = Math.max(0, tT);
      const newR = Math.min(nw, tR), newB = Math.min(nh, tB);
      const newW = newR - newL, newH = newB - newT;
      if (newW <= 0 || newH <= 0) {
        this.selection = null;
      } else {
        const srcX = newL - tL, srcY = newT - tT;
        const m = document.createElement("canvas");
        m.width = newW;
        m.height = newH;
        m.getContext("2d").drawImage(this.selection.maskCanvas, srcX, srcY, newW, newH, 0, 0, newW, newH);
        this.selection.bboxX = newL;
        this.selection.bboxY = newT;
        this.selection.bboxW = newW;
        this.selection.bboxH = newH;
        this.selection.maskCanvas = m;
        this.selection._chains = null;
        this.selection._outline = null;
      }
    }
    this.width = nw;
    this.height = nh;
  }
  // v110: 重采样 doc 到 newW × newH。mode: "nearest" | "bilinear" | "bicubic"
  // 各 layer canvas 重画 + bbox 缩放；selection mask 同步缩放
  resampleTo(newW, newH, mode = "bilinear") {
    const nw = Math.max(1, newW | 0);
    const nh = Math.max(1, newH | 0);
    const sx = nw / this.width;
    const sy = nh / this.height;
    const smooth = mode !== "nearest";
    const quality = mode === "bicubic" ? "high" : "low";
    for (const L of this.layers) {
      L.docW = nw;
      L.docH = nh;
      if (L.bboxW <= 0 || L.bboxH <= 0) continue;
      const ox = L.canvas;
      const oW = L.bboxW;
      const oH = L.bboxH;
      const nbw = Math.max(1, Math.round(oW * sx));
      const nbh = Math.max(1, Math.round(oH * sy));
      const nbx = Math.round(L.bboxX * sx);
      const nby = Math.round(L.bboxY * sy);
      const nc = makeBitmap(nbw, nbh);
      const nctx = nc.getContext("2d", { willReadFrequently: false });
      nctx.imageSmoothingEnabled = smooth;
      nctx.imageSmoothingQuality = quality;
      nctx.drawImage(ox, 0, 0, oW, oH, 0, 0, nbw, nbh);
      L.canvas = nc;
      L.ctx = nctx;
      L.bboxX = nbx;
      L.bboxY = nby;
      L.bboxW = nbw;
      L.bboxH = nbh;
    }
    if (this.selection) {
      const oW = this.selection.bboxW;
      const oH = this.selection.bboxH;
      const nbw = Math.max(1, Math.round(oW * sx));
      const nbh = Math.max(1, Math.round(oH * sy));
      const nbx = Math.round(this.selection.bboxX * sx);
      const nby = Math.round(this.selection.bboxY * sy);
      const m = document.createElement("canvas");
      m.width = nbw;
      m.height = nbh;
      const mctx = m.getContext("2d");
      mctx.imageSmoothingEnabled = smooth;
      mctx.imageSmoothingQuality = quality;
      mctx.drawImage(this.selection.maskCanvas, 0, 0, oW, oH, 0, 0, nbw, nbh);
      this.selection.bboxX = nbx;
      this.selection.bboxY = nby;
      this.selection.bboxW = nbw;
      this.selection.bboxH = nbh;
      this.selection.maskCanvas = m;
      this.selection._chains = null;
      this.selection._outline = null;
    }
    this.width = nw;
    this.height = nh;
  }
};
function _cloneSelection(sel) {
  if (!sel) return null;
  const m = document.createElement("canvas");
  m.width = Math.max(1, sel.bboxW);
  m.height = Math.max(1, sel.bboxH);
  m.getContext("2d").drawImage(sel.maskCanvas, 0, 0);
  return { bboxX: sel.bboxX, bboxY: sel.bboxY, bboxW: sel.bboxW, bboxH: sel.bboxH, maskCanvas: m };
}
function computeClipBaseFor(layers) {
  const out = new Array(layers.length);
  let currentBase = -1;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (L.clippingMask && currentBase >= 0) {
      out[i] = currentBase;
    } else {
      out[i] = -1;
      if (!L.clippingMask && L.visible && L.bboxW > 0 && L.bboxH > 0) {
        currentBase = i;
      }
    }
  }
  return out;
}
function computeMaxLayers(canvasW, canvasH) {
  const deviceMemoryGB = navigator.deviceMemory ?? 4;
  const deviceMemoryMB = deviceMemoryGB * 1024;
  const budgetMB = Math.max(64, Math.min(192, deviceMemoryMB * 0.15));
  const perLayerMB = canvasW * canvasH * 4 / 1e6;
  const n = Math.floor(budgetMB / Math.max(1, perLayerMB));
  return Math.max(2, Math.min(64, n));
}

// src/lasso.js
var LassoEngine = class {
  constructor() {
    this._state = "idle";
    this._subTool = "freehand";
    this._setOpMode = "new";
    this._constrainSquare = false;
    this._magicThreshold = 20;
    this._sampleMode = "bilinear";
    this._points = [];
    this._rect = null;
    this._magicStart = null;
    this._floating = null;
    this._drag = null;
    this.doc = null;
    this.onChange = () => {
    };
  }
  setDoc(doc2) {
    this.doc = doc2;
  }
  setSubTool(name) {
    if (this._subTool === name) return;
    this._subTool = name;
    this._points = [];
    this._rect = null;
    this._magicStart = null;
    this._state = "idle";
    this.onChange();
  }
  getSubTool() {
    return this._subTool;
  }
  setSetOpMode(mode) {
    this._setOpMode = mode;
    this.onChange();
  }
  getSetOpMode() {
    return this._setOpMode;
  }
  setMagicThreshold(v) {
    this._magicThreshold = Math.max(0, Math.min(100, v));
  }
  getMagicThreshold() {
    return this._magicThreshold;
  }
  setSampleMode(m) {
    if (m === "nearest" || m === "bilinear" || m === "bicubic") {
      this._sampleMode = m;
      if (this._floating) {
        this._floating._renderCache = null;
        this.onChange();
      }
    }
  }
  getSampleMode() {
    return this._sampleMode;
  }
  setConstrainSquare(on) {
    this._constrainSquare = !!on;
    this.onChange();
  }
  getConstrainSquare() {
    return this._constrainSquare;
  }
  // -------- 选区路径（按 subTool 路由）--------
  beginPath(x, y) {
    if (this._floating) return;
    if (this._subTool === "freehand") {
      this._state = "drawing-freehand";
      this._points = [{ x, y }];
    } else if (this._subTool === "rect") {
      this._state = "drawing-rect";
      this._rect = { x0: x, y0: y, x1: x, y1: y };
    } else if (this._subTool === "ellipse") {
      this._state = "drawing-ellipse";
      this._rect = { x0: x, y0: y, x1: x, y1: y };
    } else if (this._subTool === "magic") {
      this._state = "magic-tentative";
      this._magicStart = { x, y };
    }
    this.onChange();
  }
  extendPath(x, y) {
    if (this._state === "drawing-freehand") {
      const p = this._points[this._points.length - 1];
      if (p && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1) return;
      this._points.push({ x, y });
      this.onChange();
    } else if (this._state === "drawing-rect" || this._state === "drawing-ellipse") {
      let nx = x, ny = y;
      if (this._constrainSquare) {
        const dx = x - this._rect.x0, dy = y - this._rect.y0;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        nx = this._rect.x0 + (dx >= 0 ? m : -m);
        ny = this._rect.y0 + (dy >= 0 ? m : -m);
      }
      this._rect.x1 = nx;
      this._rect.y1 = ny;
      this.onChange();
    }
  }
  // 收笔：rasterize → combine with doc.selection per setOpMode → 更新 doc.selection
  // 返回 history entry（caller push）或 null（选区无效 / 没动）
  endPath(sourceLayer) {
    let newSel = null;
    if (this._state === "drawing-freehand") {
      newSel = this._rasterizeFreehandToSelection(this._points);
      this._points = [];
    } else if (this._state === "drawing-rect") {
      newSel = this._rasterizeRectToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "drawing-ellipse") {
      newSel = this._rasterizeEllipseToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "magic-tentative") {
      newSel = this._magicWandToSelection(this._magicStart, sourceLayer);
      this._magicStart = null;
    }
    this._state = "idle";
    if (!newSel) {
      this.onChange();
      return null;
    }
    return this._applySelectionUpdate(newSel);
  }
  // 编程入口（取消选区 / 反选 / 由 history undo 调用恢复）
  setSelection(sel) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    if (oldSel === sel) return null;
    if (sel && !sel._outline) sel._outline = null;
    this.doc.selection = sel;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: sel };
  }
  hasSelection() {
    return !!this.doc?.selection;
  }
  getSelection() {
    return this.doc?.selection || null;
  }
  cancelDrawing() {
    this._state = "idle";
    this._points = [];
    this._rect = null;
    this._magicStart = null;
    this.onChange();
  }
  // 用 doc.selection 作 mask source，把对应 layer 像素 lift 到 floating。
  // 完成后进 floating 状态（transform 子状态）。
  // 默认进入 free 模式（不再走 v56 那种"selected sub-state"）
  liftSelectionForTransform(layer) {
    if (this._floating) return false;
    const sel = this.doc?.selection;
    if (!sel) return false;
    const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
    const x0 = Math.max(lbX, sel.bboxX);
    const y0 = Math.max(lbY, sel.bboxY);
    const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW);
    const y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return false;
    const preSnap = layer.snapshot();
    const floating = makeBitmap2(w, h);
    const fctx = floating.getContext("2d");
    fctx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
    fctx.globalCompositeOperation = "destination-in";
    fctx.drawImage(sel.maskCanvas, sel.bboxX - x0, sel.bboxY - y0);
    fctx.globalCompositeOperation = "source-over";
    const floatingImageData = fctx.getImageData(0, 0, w, h);
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalCompositeOperation = "destination-out";
    lctx.drawImage(sel.maskCanvas, sel.bboxX - lbX, sel.bboxY - lbY);
    lctx.restore();
    this._floating = {
      canvas: floating,
      imageData: floatingImageData,
      srcW: w,
      srcH: h,
      layer,
      preSnap,
      mode: "free",
      // 默认就是 free 模式（不再有 selected sub-state）
      meshN: 2,
      mesh: [
        [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }],
        [{ x: x0, y: y0 + h }, { x: x0 + w, y: y0 + h }]
      ],
      uniformAspect: w / Math.max(1, h),
      _renderCache: null
    };
    this._state = "floating";
    this.onChange();
    return true;
  }
  // ---- rasterize helpers（返回 selection-shaped object 或 null）----
  _rasterizeFreehandToSelection(pts) {
    if (pts.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const x0 = Math.floor(minX), y0 = Math.floor(minY);
    const x1 = Math.ceil(maxX), y1 = Math.ceil(maxY);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap2(w, h);
    const mctx = maskCanvas.getContext("2d");
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x - x0;
      const py = pts[i].y - y0;
      if (i === 0) mctx.moveTo(px, py);
      else mctx.lineTo(px, py);
    }
    mctx.closePath();
    mctx.fill("evenodd");
    return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas };
  }
  _rasterizeRectToSelection(r) {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap2(w, h);
    const mctx = maskCanvas.getContext("2d");
    mctx.fillStyle = "#fff";
    mctx.fillRect(0, 0, w, h);
    return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas };
  }
  _rasterizeEllipseToSelection(r) {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap2(w, h);
    const mctx = maskCanvas.getContext("2d");
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    mctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    mctx.fill();
    return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas };
  }
  // 魔术棒：tap → flood fill 颜色差 ≤ threshold 的相邻像素入选。
  //
  // 经典 bug（v66 + v69 又犯）：iteration 局限在 layer.bbox 内 → 点空白只选到
  // bbox 矩形。修：迭代**整 doc 尺寸**，layer.bbox 外当 (0,0,0,0) 透明像素。
  //
  // 历史「容隙」功能 v71→v79 撤掉：barrier dilate N px 会盖住 user 的 tap 点
  // 让小区域整片不可点。详 docs/lessons-magic-wand-gap-closing.md。
  //
  // 内存（2048² doc）：layerData 16MB + visited buffer 4MB + maskCanvas
  // 仅 bbox 大小。barrier 不再单独 alloc（diff 算在 flood fill 里 inline）。
  _magicWandToSelection(start, sourceLayer) {
    if (!start || !this.doc) return null;
    const docW = this.doc.width, docH = this.doc.height;
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    if (sx < 0 || sx >= docW || sy < 0 || sy >= docH) return null;
    const lbX = sourceLayer?.bboxX ?? 0;
    const lbY = sourceLayer?.bboxY ?? 0;
    const lbW = sourceLayer?.bboxW ?? 0;
    const lbH = sourceLayer?.bboxH ?? 0;
    let layerData = null;
    if (sourceLayer && lbW > 0 && lbH > 0) {
      layerData = sourceLayer.ctx.getImageData(0, 0, lbW, lbH).data;
    }
    let sr = 0, sg = 0, sb = 0, sa = 0;
    if (layerData && sx >= lbX && sx < lbX + lbW && sy >= lbY && sy < lbY + lbH) {
      const idx = ((sy - lbY) * lbW + (sx - lbX)) * 4;
      sr = layerData[idx];
      sg = layerData[idx + 1];
      sb = layerData[idx + 2];
      sa = layerData[idx + 3];
    }
    const tCh = this._magicThreshold * 2.55;
    const total = docW * docH;
    const outsideIsBarrier = Math.max(sr, sg, sb, sa) > tCh;
    const isBarrier = (p) => {
      const py = p / docW | 0;
      const px = p - py * docW;
      if (!layerData || px < lbX || px >= lbX + lbW || py < lbY || py >= lbY + lbH) {
        return outsideIsBarrier;
      }
      const i4 = ((py - lbY) * lbW + (px - lbX)) * 4;
      const dr = Math.abs(layerData[i4] - sr);
      const dg = Math.abs(layerData[i4 + 1] - sg);
      const db = Math.abs(layerData[i4 + 2] - sb);
      const da = Math.abs(layerData[i4 + 3] - sa);
      return Math.max(dr, dg, db, da) > tCh;
    };
    const combined = new Uint8Array(total);
    const startIdx = sx + sy * docW;
    if (isBarrier(startIdx)) return null;
    const stack = [startIdx];
    let mnx = docW, mny = docH, mxx = -1, mxy = -1;
    while (stack.length) {
      const p = stack.pop();
      if (combined[p] !== 0) continue;
      if (isBarrier(p)) {
        combined[p] = 2;
        continue;
      }
      combined[p] = 1;
      const px = p % docW;
      const py = (p - px) / docW;
      if (px < mnx) mnx = px;
      if (px > mxx) mxx = px;
      if (py < mny) mny = py;
      if (py > mxy) mxy = py;
      if (px > 0 && combined[p - 1] === 0) stack.push(p - 1);
      if (px < docW - 1 && combined[p + 1] === 0) stack.push(p + 1);
      if (py > 0 && combined[p - docW] === 0) stack.push(p - docW);
      if (py < docH - 1 && combined[p + docW] === 0) stack.push(p + docW);
    }
    if (mxx < 0) return null;
    const tw = mxx - mnx + 1, th = mxy - mny + 1;
    const maskCanvas = makeBitmap2(tw, th);
    const mctx = maskCanvas.getContext("2d");
    const out = mctx.createImageData(tw, th);
    const odata = out.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const accepted = combined[(mny + y) * docW + (mnx + x)] === 1;
      const o = (y * tw + x) * 4;
      odata[o] = 255;
      odata[o + 1] = 255;
      odata[o + 2] = 255;
      odata[o + 3] = accepted ? 255 : 0;
    }
    mctx.putImageData(out, 0, 0);
    return { bboxX: mnx, bboxY: mny, bboxW: tw, bboxH: th, maskCanvas };
  }
  // 把新 mask 按 setOpMode 合并进 doc.selection，返回 history entry
  _applySelectionUpdate(newSel) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    const merged = combineSelections(oldSel, newSel, this._setOpMode);
    if (oldSel === merged) {
      this.onChange();
      return null;
    }
    this.doc.selection = merged;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: merged };
  }
  // -------- 模式切换 --------
  // mode 可以是 null（selected：只显轮廓 + 拖内 = 平移）
  //         或 "free" | "uniform" | "distort" | "warp"
  setMode(mode) {
    const f = this._floating;
    if (!f) return;
    if (mode === f.mode) return;
    if (mode === "warp" && f.meshN === 2) {
      f.mesh = upsampleMesh2to4(f.mesh);
      f.meshN = 4;
      f._renderCache = null;
    } else if (mode !== "warp" && f.meshN === 4) {
      f.mesh = downsampleMesh4to2(f.mesh);
      f.meshN = 2;
      f._renderCache = null;
    }
    if (f.meshN === 2) {
      const fromDistort = f.mode === "distort";
      const fromFree = f.mode === "free";
      if (mode === "free" && fromDistort) {
        f.mesh = _projectMeshToRectangle(f.mesh);
        f._renderCache = null;
      } else if (mode === "uniform" && (fromDistort || fromFree)) {
        f.mesh = _projectMeshToUniformRect(f.mesh, f.uniformAspect);
        f._renderCache = null;
      }
    }
    f.mode = mode;
    this.onChange();
  }
  getMode() {
    return this._floating?.mode || null;
  }
  // -------- 拖动 --------
  // 鼠标 / 手指 down 时调：判断点击在哪里 → 设 _drag。返回 hit 类型。
  hitTest(x, y, screenScale = 1) {
    const f = this._floating;
    if (!f) return null;
    if (f.mode === null) {
      return this._pointInQuad(x, y) ? { kind: "translate" } : null;
    }
    const r = 10 / screenScale;
    const handles = this._visibleHandles(screenScale);
    for (const h of handles) {
      const dx = x - h.pos.x, dy = y - h.pos.y;
      if (dx * dx + dy * dy < r * r) return h;
    }
    if (f.mode === "warp") {
      const cell = this._findWarpCell(x, y);
      if (cell) return { kind: "warp-soft", ...cell };
    }
    if (this._pointInQuad(x, y)) {
      return { kind: "translate" };
    }
    return null;
  }
  beginDrag(hit, x, y) {
    const f = this._floating;
    if (!f || !hit) return;
    this._drag = {
      ...hit,
      startX: x,
      startY: y,
      meshSnap: f.mesh.map((row) => row.map((p) => ({ x: p.x, y: p.y })))
    };
  }
  extendDrag(x, y) {
    const f = this._floating;
    const d = this._drag;
    if (!f || !d) return;
    const dx = x - d.startX;
    const dy = y - d.startY;
    if (d.kind === "translate") {
      this._applyTranslate(d.meshSnap, dx, dy);
    } else if (d.kind === "corner") {
      this._applyCornerDrag(d.row, d.col, d.meshSnap, x, y);
    } else if (d.kind === "edge") {
      this._applyEdgeDrag(d.edge, d.meshSnap, x, y);
    } else if (d.kind === "rotate") {
      this._applyRotate(d.meshSnap, x, y);
    } else if (d.kind === "warp-point") {
      this._applyWarpPoint(d.row, d.col, d.meshSnap, dx, dy);
    } else if (d.kind === "warp-soft") {
      this._applyWarpSoft(d, dx, dy);
    }
    if (f) f._renderCache = null;
    this.onChange();
  }
  endDrag() {
    this._drag = null;
  }
  // Stamp：当前 float 写入 layer，但 KEEP float 在原状态。
  // 不 push history（stamp 是 float session 内部动作）；最终 commit 时一次性 push。
  // 多次 stamp + commit/cancel：cancel 会 restoreFromSnapshot(preLift) 把所有 stamp 一并撤回。
  stamp() {
    const f = this._floating;
    if (!f) return false;
    const layer = f.layer;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const row of f.mesh) for (const p of row) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    layer.ensureBbox(Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY));
    const lbX = layer.bboxX, lbY = layer.bboxY;
    if (f.meshN === 2) {
      const rendered = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh, this._sampleMode);
      if (rendered) layer.ctx.drawImage(rendered.canvas, rendered.dstX - lbX, rendered.dstY - lbY);
    } else {
      layer.ctx.save();
      layer.ctx.translate(-lbX, -lbY);
      drawMesh(layer.ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: this._sampleMode !== "nearest" });
      layer.ctx.restore();
    }
    this.onChange();
    return true;
  }
  // -------- commit / cancel --------
  commit() {
    const f = this._floating;
    if (!f) return null;
    const layer = f.layer;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const row of f.mesh) for (const p of row) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    layer.ensureBbox(Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY));
    const lbX = layer.bboxX, lbY = layer.bboxY;
    if (f.meshN === 2) {
      const rendered = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh, this._sampleMode);
      if (rendered) {
        layer.ctx.drawImage(rendered.canvas, rendered.dstX - lbX, rendered.dstY - lbY);
      }
    } else {
      layer.ctx.save();
      layer.ctx.translate(-lbX, -lbY);
      drawMesh(layer.ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: this._sampleMode !== "nearest" });
      layer.ctx.restore();
    }
    const after = layer.snapshot();
    const prevSelection = this.doc?.selection || null;
    if (this.doc) this.doc.selection = null;
    const entry = {
      type: "lasso",
      layerId: layer.id,
      before: f.preSnap,
      after,
      beforeBlob: null,
      afterBlob: null,
      prevSelection
      // undo 时还原
    };
    this._floating = null;
    this._state = "idle";
    this._drag = null;
    this.onChange();
    return entry;
  }
  cancel() {
    const f = this._floating;
    if (!f) return null;
    f.layer.restoreFromSnapshot(f.preSnap);
    this._floating = null;
    this._state = "idle";
    this._drag = null;
    this.onChange();
    return f.preSnap;
  }
  // -------- 外部查询 --------
  hasFloating() {
    return this._state === "floating";
  }
  getDrawingPath() {
    return this._state === "drawing-freehand" ? this._points : null;
  }
  getDrawingRect() {
    return this._state === "drawing-rect" ? this._rect : null;
  }
  getDrawingEllipse() {
    return this._state === "drawing-ellipse" ? this._rect : null;
  }
  getFloating() {
    return this._floating;
  }
  state() {
    return this._state;
  }
  // bbox in doc coords（含 mesh 变形后的最大矩形，给 board markDirty 用）
  getFloatingScreenBbox() {
    const f = this._floating;
    if (!f) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const row of f.mesh) for (const p of row) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return [minX, minY, maxX, maxY];
  }
  // 给 board overlay 用：返回当前可拖的 handle 列表（位置 + 类型）
  // v117: 接 screenScale 让 rotate handle 在 doc-px 里按屏幕 px 偏移定位
  visibleHandles(screenScale = 1) {
    return this._visibleHandles(screenScale);
  }
  // 给 board overlay：渲染 floating 用
  // 调 drawMesh(ctx, canvas, srcW, srcH, mesh) 接到 board 里更方便，所以也 export drawMesh
  // ---------- 内部 ----------
  _visibleHandles(screenScale = 1) {
    const f = this._floating;
    if (!f) return [];
    if (f.mode === null) return [];
    const out = [];
    if (f.meshN === 2) {
      const m = f.mesh;
      out.push({ kind: "corner", row: 0, col: 0, pos: m[0][0] });
      out.push({ kind: "corner", row: 0, col: 1, pos: m[0][1] });
      out.push({ kind: "corner", row: 1, col: 0, pos: m[1][0] });
      out.push({ kind: "corner", row: 1, col: 1, pos: m[1][1] });
      out.push({ kind: "edge", edge: "top", pos: mid(m[0][0], m[0][1]) });
      out.push({ kind: "edge", edge: "right", pos: mid(m[0][1], m[1][1]) });
      out.push({ kind: "edge", edge: "bottom", pos: mid(m[1][0], m[1][1]) });
      out.push({ kind: "edge", edge: "left", pos: mid(m[0][0], m[1][0]) });
      if (f.mode === "free" || f.mode === "uniform") {
        const topMid = mid(m[0][0], m[0][1]);
        const ayU = norm(sub(m[1][0], m[0][0]));
        const offset = 28 / Math.max(0.01, screenScale);
        out.push({
          kind: "rotate",
          pos: { x: topMid.x - ayU.x * offset, y: topMid.y - ayU.y * offset },
          anchor: topMid
          // 给 board 画连接线用
        });
      }
    } else {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        out.push({ kind: "warp-point", row: i, col: j, pos: f.mesh[i][j] });
      }
    }
    return out;
  }
  _pointInQuad(x, y) {
    const f = this._floating;
    if (!f) return false;
    const N = f.meshN;
    const m = f.mesh;
    const poly = [m[0][0], m[0][N - 1], m[N - 1][N - 1], m[N - 1][0]];
    return pointInPoly(poly, x, y);
  }
  _applyTranslate(meshSnap, dx, dy) {
    const f = this._floating;
    for (let i = 0; i < f.meshN; i++) for (let j = 0; j < f.meshN; j++) {
      f.mesh[i][j].x = meshSnap[i][j].x + dx;
      f.mesh[i][j].y = meshSnap[i][j].y + dy;
    }
  }
  // 角点拖动：
  //   free / uniform: 平行四边形约束（对角锚定，调整 ax / ay）
  //   distort: 自由四边形（只动这一角）
  _applyCornerDrag(row, col, meshSnap, x, y) {
    const f = this._floating;
    const d = this._drag;
    let targetX = meshSnap[row][col].x + (x - d.startX);
    let targetY = meshSnap[row][col].y + (y - d.startY);
    if (f.mode === "distort") {
      f.mesh[row][col].x = targetX;
      f.mesh[row][col].y = targetY;
      return;
    }
    const opp = { "0,0": [1, 1], "0,1": [1, 0], "1,0": [0, 1], "1,1": [0, 0] };
    const [or, oc] = opp[`${row},${col}`];
    const anchor = meshSnap[or][oc];
    const sameRowCol = col === 0 ? 1 : 0;
    const sameColRow = row === 0 ? 1 : 0;
    const origAx = sub(meshSnap[0][1], meshSnap[0][0]);
    const origAy = sub(meshSnap[1][0], meshSnap[0][0]);
    const sx = col, sy = row;
    const drag = { x: targetX, y: targetY };
    const dragVec = sub(drag, anchor);
    const axU = norm(origAx);
    const ayU = norm(origAy);
    const \u03B1x = 2 * sx - 1;
    const \u03B1y = 2 * sy - 1;
    const M11 = \u03B1x * axU.x, M12 = \u03B1y * ayU.x;
    const M21 = \u03B1x * axU.y, M22 = \u03B1y * ayU.y;
    const det = M11 * M22 - M12 * M21;
    if (Math.abs(det) < 1e-6) return;
    let lenAx = (dragVec.x * M22 - dragVec.y * M12) / det;
    let lenAy = (-dragVec.x * M21 + dragVec.y * M11) / det;
    if (f.mode === "uniform") {
      const origCorner = meshSnap[row][col];
      const Dvec = sub(origCorner, anchor);
      const Dlen2 = Dvec.x * Dvec.x + Dvec.y * Dvec.y;
      if (Dlen2 > 1e-6) {
        const fingerFromAnchor = sub({ x: targetX, y: targetY }, anchor);
        const scale = (fingerFromAnchor.x * Dvec.x + fingerFromAnchor.y * Dvec.y) / Dlen2;
        const origLenAx = Math.hypot(origAx.x, origAx.y);
        const origLenAy = Math.hypot(origAy.x, origAy.y);
        lenAx = scale * origLenAx;
        lenAy = scale * origLenAy;
        targetX = anchor.x + scale * Dvec.x;
        targetY = anchor.y + scale * Dvec.y;
      }
    }
    const newAx = { x: axU.x * lenAx, y: axU.y * lenAx };
    const newAy = { x: ayU.x * lenAy, y: ayU.y * lenAy };
    const origin = { x: targetX - sx * newAx.x - sy * newAy.x, y: targetY - sx * newAx.y - sy * newAy.y };
    f.mesh[0][0] = origin;
    f.mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
    f.mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
    f.mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
  }
  // 边中点拖动（free/uniform）：沿对应轴 1D 缩放，对边锚定
  _applyEdgeDrag(edge, meshSnap, x, y) {
    const f = this._floating;
    const m = meshSnap;
    if (f.mode === "distort") {
      const d2 = this._drag;
      const dx = x - d2.startX, dy = y - d2.startY;
      const idx = {
        top: [[0, 0], [0, 1]],
        bottom: [[1, 0], [1, 1]],
        left: [[0, 0], [1, 0]],
        right: [[0, 1], [1, 1]]
      }[edge];
      for (const [r, c] of idx) {
        f.mesh[r][c] = { x: m[r][c].x + dx, y: m[r][c].y + dy };
      }
      return;
    }
    const origAx = sub(m[0][1], m[0][0]);
    const origAy = sub(m[1][0], m[0][0]);
    const axU = norm(origAx);
    const ayU = norm(origAy);
    let dragMid, oppMidStart, oppMidEnd;
    let axis;
    if (edge === "top") {
      dragMid = mid(m[0][0], m[0][1]);
      oppMidStart = m[1][0];
      oppMidEnd = m[1][1];
      axis = "ay-shrink";
    } else if (edge === "bottom") {
      dragMid = mid(m[1][0], m[1][1]);
      oppMidStart = m[0][0];
      oppMidEnd = m[0][1];
      axis = "ay-grow";
    } else if (edge === "left") {
      dragMid = mid(m[0][0], m[1][0]);
      oppMidStart = m[0][1];
      oppMidEnd = m[1][1];
      axis = "ax-shrink";
    } else {
      dragMid = mid(m[0][1], m[1][1]);
      oppMidStart = m[0][0];
      oppMidEnd = m[1][0];
      axis = "ax-grow";
    }
    const d = this._drag;
    const dragDelta = { x: x - d.startX, y: y - d.startY };
    let lenAx = Math.hypot(origAx.x, origAx.y);
    let lenAy = Math.hypot(origAy.x, origAy.y);
    if (axis.startsWith("ax")) {
      const proj = dragDelta.x * axU.x + dragDelta.y * axU.y;
      lenAx = axis === "ax-grow" ? lenAx + proj : lenAx - proj;
    } else {
      const proj = dragDelta.x * ayU.x + dragDelta.y * ayU.y;
      lenAy = axis === "ay-grow" ? lenAy + proj : lenAy - proj;
    }
    if (f.mode === "uniform") {
      if (axis.startsWith("ax")) lenAy = lenAx / f.uniformAspect;
      else lenAx = lenAy * f.uniformAspect;
    }
    const blAnchor = m[1][0];
    const newAy = { x: ayU.x * lenAy, y: ayU.y * lenAy };
    const newAx = { x: axU.x * lenAx, y: axU.y * lenAx };
    let origin;
    if (axis.startsWith("ay")) {
      if (axis === "ay-grow") {
        origin = { x: m[0][0].x, y: m[0][0].y };
      } else {
        origin = { x: blAnchor.x - newAy.x, y: blAnchor.y - newAy.y };
      }
    } else {
      if (axis === "ax-grow") {
        origin = { x: m[0][0].x, y: m[0][0].y };
      } else {
        origin = { x: m[0][1].x - newAx.x, y: m[0][1].y - newAx.y };
      }
    }
    f.mesh[0][0] = origin;
    f.mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
    f.mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
    f.mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
  }
  // v117: rotate 拖动 —— 绕 centroid 转 dθ
  //   centroid = 4 角平均
  //   dθ = atan2(finger − centroid) − atan2(start − centroid)
  //   每个 meshSnap 角 rotate(p, centroid, dθ) → mesh
  _applyRotate(meshSnap, x, y) {
    const f = this._floating;
    const m = meshSnap;
    const cx = (m[0][0].x + m[0][1].x + m[1][0].x + m[1][1].x) / 4;
    const cy = (m[0][0].y + m[0][1].y + m[1][0].y + m[1][1].y) / 4;
    const d = this._drag;
    const a0 = Math.atan2(d.startY - cy, d.startX - cx);
    const a1 = Math.atan2(y - cy, x - cx);
    const d\u03B8 = a1 - a0;
    const cos = Math.cos(d\u03B8), sin = Math.sin(d\u03B8);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const px = m[i][j].x - cx;
      const py = m[i][j].y - cy;
      f.mesh[i][j] = { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
    }
  }
  // Warp 单点拖：那一个点 += delta
  _applyWarpPoint(row, col, meshSnap, dx, dy) {
    const f = this._floating;
    f.mesh[row][col] = {
      x: meshSnap[row][col].x + dx,
      y: meshSnap[row][col].y + dy
    };
  }
  // Warp 软拖：拖任意点 → 邻近 cell 的 4 角按 bilinear 权重分配 delta
  // (cell.row, cell.col) = 4×4 mesh 中 cell 的 TL 索引（0..2）
  // (u, v) ∈ [0,1] = cell 内部的 bilinear 坐标
  _applyWarpSoft(d, dx, dy) {
    const f = this._floating;
    const r = d.row, c = d.col;
    const u = d.u, v = d.v;
    const wTL = (1 - u) * (1 - v);
    const wTR = u * (1 - v);
    const wBL = (1 - u) * v;
    const wBR = u * v;
    f.mesh[r][c] = { x: d.meshSnap[r][c].x + dx * wTL, y: d.meshSnap[r][c].y + dy * wTL };
    f.mesh[r][c + 1] = { x: d.meshSnap[r][c + 1].x + dx * wTR, y: d.meshSnap[r][c + 1].y + dy * wTR };
    f.mesh[r + 1][c] = { x: d.meshSnap[r + 1][c].x + dx * wBL, y: d.meshSnap[r + 1][c].y + dy * wBL };
    f.mesh[r + 1][c + 1] = { x: d.meshSnap[r + 1][c + 1].x + dx * wBR, y: d.meshSnap[r + 1][c + 1].y + dy * wBR };
  }
  // 给定 doc 坐标 (x, y) 找它落在 4×4 mesh 的哪个 cell + bilinear (u, v)
  _findWarpCell(x, y) {
    const f = this._floating;
    if (!f || f.meshN !== 4) return null;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const tl = f.mesh[r][c], tr = f.mesh[r][c + 1];
        const bl = f.mesh[r + 1][c], br = f.mesh[r + 1][c + 1];
        const uv = inverseBilinear(x, y, tl, tr, bl, br);
        if (uv && uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1) {
          return { row: r, col: c, u: uv.u, v: uv.v };
        }
      }
    }
    return null;
  }
};
function combineSelections(oldSel, newSel, mode) {
  if (!newSel) return oldSel;
  if (mode === "new" || !oldSel) return newSel;
  let x0, y0, x1, y1;
  if (mode === "intersect") {
    x0 = Math.max(oldSel.bboxX, newSel.bboxX);
    y0 = Math.max(oldSel.bboxY, newSel.bboxY);
    x1 = Math.min(oldSel.bboxX + oldSel.bboxW, newSel.bboxX + newSel.bboxW);
    y1 = Math.min(oldSel.bboxY + oldSel.bboxH, newSel.bboxY + newSel.bboxH);
    if (x1 <= x0 || y1 <= y0) return null;
  } else {
    x0 = Math.min(oldSel.bboxX, newSel.bboxX);
    y0 = Math.min(oldSel.bboxY, newSel.bboxY);
    x1 = Math.max(oldSel.bboxX + oldSel.bboxW, newSel.bboxX + newSel.bboxW);
    y1 = Math.max(oldSel.bboxY + oldSel.bboxH, newSel.bboxY + newSel.bboxH);
    if (mode === "subtract") {
      x0 = oldSel.bboxX;
      y0 = oldSel.bboxY;
      x1 = oldSel.bboxX + oldSel.bboxW;
      y1 = oldSel.bboxY + oldSel.bboxH;
    }
  }
  const w = x1 - x0, h = y1 - y0;
  const canvas = makeBitmap2(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(oldSel.maskCanvas, oldSel.bboxX - x0, oldSel.bboxY - y0);
  if (mode === "union") {
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(newSel.maskCanvas, newSel.bboxX - x0, newSel.bboxY - y0);
  } else if (mode === "subtract") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(newSel.maskCanvas, newSel.bboxX - x0, newSel.bboxY - y0);
  } else if (mode === "intersect") {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(newSel.maskCanvas, newSel.bboxX - x0, newSel.bboxY - y0);
  }
  ctx.globalCompositeOperation = "source-over";
  return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas: canvas };
}
function chainMaskOutline(segs) {
  const out = [];
  if (segs.length < 4) return out;
  const n = segs.length / 4;
  const key = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const endpoints = /* @__PURE__ */ new Map();
  for (let i = 0; i < n; i++) {
    const k0 = key(segs[i * 4], segs[i * 4 + 1]);
    const k1 = key(segs[i * 4 + 2], segs[i * 4 + 3]);
    if (!endpoints.has(k0)) endpoints.set(k0, []);
    if (!endpoints.has(k1)) endpoints.set(k1, []);
    endpoints.get(k0).push(i * 2);
    endpoints.get(k1).push(i * 2 + 1);
  }
  const used = new Uint8Array(n);
  const findUnused = (k) => {
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
      const segIdx = slot >> 1;
      used[segIdx] = 1;
      const si = segIdx * 4;
      if (slot & 1) chain.push(segs[si], segs[si + 1]);
      else chain.push(segs[si + 2], segs[si + 3]);
    }
    while (true) {
      const sx = chain[0], sy = chain[1];
      const slot = findUnused(key(sx, sy));
      if (slot < 0) break;
      const segIdx = slot >> 1;
      used[segIdx] = 1;
      const si = segIdx * 4;
      if (slot & 1) chain.unshift(segs[si], segs[si + 1]);
      else chain.unshift(segs[si + 2], segs[si + 3]);
    }
    out.push(new Float32Array(chain));
  }
  return out;
}
function extractMaskOutline(sel) {
  const w = sel.bboxW, h = sel.bboxH;
  if (w <= 1 || h <= 1) return new Float32Array(0);
  const ctx = sel.maskCanvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h).data;
  const segs = [];
  const alpha = (x, y) => x < 0 || x >= w || y < 0 || y >= h ? 0 : data[(y * w + x) * 4 + 3] > 128 ? 1 : 0;
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const a00 = alpha(x, y);
      const a10 = alpha(x + 1, y);
      const a01 = alpha(x, y + 1);
      const a11 = alpha(x + 1, y + 1);
      const idx = a00 | a10 << 1 | a11 << 2 | a01 << 3;
      if (idx === 0 || idx === 15) continue;
      const cxL = Math.max(0, Math.min(w, x)), cxR = Math.max(0, Math.min(w, x + 1));
      const cyT = Math.max(0, Math.min(h, y)), cyB = Math.max(0, Math.min(h, y + 1));
      const xL = sel.bboxX + cxL, xR = sel.bboxX + cxR, xM = (xL + xR) / 2;
      const yT = sel.bboxY + cyT, yB = sel.bboxY + cyB, yM = (yT + yB) / 2;
      switch (idx) {
        case 1:
          segs.push(xM, yT, xL, yM);
          break;
        case 2:
          segs.push(xM, yT, xR, yM);
          break;
        case 3:
          segs.push(xL, yM, xR, yM);
          break;
        case 4:
          segs.push(xR, yM, xM, yB);
          break;
        case 5:
          segs.push(xM, yT, xR, yM);
          segs.push(xM, yB, xL, yM);
          break;
        case 6:
          segs.push(xM, yT, xM, yB);
          break;
        case 7:
          segs.push(xM, yB, xL, yM);
          break;
        case 8:
          segs.push(xL, yM, xM, yB);
          break;
        case 9:
          segs.push(xM, yT, xM, yB);
          break;
        case 10:
          segs.push(xM, yT, xL, yM);
          segs.push(xR, yM, xM, yB);
          break;
        case 11:
          segs.push(xR, yM, xM, yB);
          break;
        case 12:
          segs.push(xL, yM, xR, yM);
          break;
        case 13:
          segs.push(xM, yT, xR, yM);
          break;
        case 14:
          segs.push(xM, yT, xL, yM);
          break;
      }
    }
  }
  return new Float32Array(segs);
}
function invertSelection(sel, docW, docH) {
  const canvas = makeBitmap2(docW, docH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, docW, docH);
  if (sel) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(sel.maskCanvas, sel.bboxX, sel.bboxY);
    ctx.globalCompositeOperation = "source-over";
  }
  return { bboxX: 0, bboxY: 0, bboxW: docW, bboxH: docH, maskCanvas: canvas };
}
function applySelectionMaskPostStroke(layer, preSnap, selection) {
  if (!selection || !preSnap) return;
  const afterSnap = layer.snapshot();
  const px0 = preSnap.bboxX, py0 = preSnap.bboxY;
  const px1 = px0 + preSnap.bboxW, py1 = py0 + preSnap.bboxH;
  const ax0 = afterSnap.bboxX, ay0 = afterSnap.bboxY;
  const ax1 = ax0 + afterSnap.bboxW, ay1 = ay0 + afterSnap.bboxH;
  const ux0 = Math.min(px0, ax0), uy0 = Math.min(py0, ay0);
  const ux1 = Math.max(px1, ax1), uy1 = Math.max(py1, ay1);
  const uw = ux1 - ux0, uh = uy1 - uy0;
  if (uw <= 0 || uh <= 0) return;
  let maskData = null;
  if (selection.bboxW > 0 && selection.bboxH > 0) {
    const mctx = selection.maskCanvas.getContext("2d");
    maskData = mctx.getImageData(0, 0, selection.bboxW, selection.bboxH).data;
  }
  const preData = preSnap.imageData ? preSnap.imageData.data : null;
  const afterData = afterSnap.imageData ? afterSnap.imageData.data : null;
  const out = new ImageData(uw, uh);
  const odata = out.data;
  for (let y = 0; y < uh; y++) {
    for (let x = 0; x < uw; x++) {
      const docX = ux0 + x;
      const docY = uy0 + y;
      let maskAlpha = 0;
      const mx = docX - selection.bboxX;
      const my = docY - selection.bboxY;
      if (maskData && mx >= 0 && mx < selection.bboxW && my >= 0 && my < selection.bboxH) {
        maskAlpha = maskData[(my * selection.bboxW + mx) * 4 + 3];
      }
      const oi = (y * uw + x) * 4;
      const useAfter = maskAlpha > 0;
      if (useAfter && afterData) {
        const aix = docX - ax0, aiy = docY - ay0;
        if (aix >= 0 && aix < afterSnap.bboxW && aiy >= 0 && aiy < afterSnap.bboxH) {
          const i = (aiy * afterSnap.bboxW + aix) * 4;
          odata[oi] = afterData[i];
          odata[oi + 1] = afterData[i + 1];
          odata[oi + 2] = afterData[i + 2];
          odata[oi + 3] = afterData[i + 3];
        }
      } else if (!useAfter && preData) {
        const pix = docX - px0, piy = docY - py0;
        if (pix >= 0 && pix < preSnap.bboxW && piy >= 0 && piy < preSnap.bboxH) {
          const i = (piy * preSnap.bboxW + pix) * 4;
          odata[oi] = preData[i];
          odata[oi + 1] = preData[i + 1];
          odata[oi + 2] = preData[i + 2];
          odata[oi + 3] = preData[i + 3];
        }
      }
    }
  }
  layer.ensureBbox(ux0, uy0, ux1, uy1);
  layer.ctx.putImageData(out, ux0 - layer.bboxX, uy0 - layer.bboxY);
}
function fillSelectionOnLayer(layer, selection, color) {
  if (!selection || !layer) return;
  layer.ensureBbox(
    selection.bboxX,
    selection.bboxY,
    selection.bboxX + selection.bboxW,
    selection.bboxY + selection.bboxH
  );
  const tmp = makeBitmap2(selection.bboxW, selection.bboxH);
  const tctx = tmp.getContext("2d");
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, selection.bboxW, selection.bboxH);
  tctx.globalCompositeOperation = "destination-in";
  tctx.drawImage(selection.maskCanvas, 0, 0);
  tctx.globalCompositeOperation = "source-over";
  layer.ctx.drawImage(
    tmp,
    selection.bboxX - layer.bboxX,
    selection.bboxY - layer.bboxY
  );
}
function clearSelectionOnLayer(layer, selection) {
  if (!selection || !layer) return;
  const lctx = layer.ctx;
  lctx.save();
  lctx.globalCompositeOperation = "destination-out";
  lctx.drawImage(
    selection.maskCanvas,
    selection.bboxX - layer.bboxX,
    selection.bboxY - layer.bboxY
  );
  lctx.restore();
}
function makeBitmap2(w, h) {
  return typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : (() => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  })();
}
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function norm(v) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len } : { x: 1, y: 0 };
}
function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function upsampleMesh2to4(m) {
  const tl = m[0][0], tr = m[0][1], bl = m[1][0], br = m[1][1];
  const out = [];
  for (let i = 0; i < 4; i++) {
    out[i] = [];
    const v = i / 3;
    for (let j = 0; j < 4; j++) {
      const u = j / 3;
      out[i][j] = {
        x: (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x,
        y: (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y
      };
    }
  }
  return out;
}
function downsampleMesh4to2(m) {
  return [
    [{ ...m[0][0] }, { ...m[0][3] }],
    [{ ...m[3][0] }, { ...m[3][3] }]
  ];
}
function _projectMeshToRectangle(mesh) {
  const tl = mesh[0][0], tr = mesh[0][1];
  const bl = mesh[1][0], br = mesh[1][1];
  const cx = (tl.x + tr.x + bl.x + br.x) / 4;
  const cy = (tl.y + tr.y + bl.y + br.y) / 4;
  const ux = (tr.x - tl.x + (br.x - bl.x)) / 2;
  const uy = (tr.y - tl.y + (br.y - bl.y)) / 2;
  const uLen = Math.hypot(ux, uy);
  const uDirX = uLen > 0.01 ? ux / uLen : 1;
  const uDirY = uLen > 0.01 ? uy / uLen : 0;
  const vDirX = -uDirY, vDirY = uDirX;
  const halfU = uLen / 2;
  const vx = (bl.x - tl.x + (br.x - tr.x)) / 2;
  const vy = (bl.y - tl.y + (br.y - tr.y)) / 2;
  const halfV = (vx * vDirX + vy * vDirY) / 2;
  return [
    [
      { x: cx - halfU * uDirX - halfV * vDirX, y: cy - halfU * uDirY - halfV * vDirY },
      { x: cx + halfU * uDirX - halfV * vDirX, y: cy + halfU * uDirY - halfV * vDirY }
    ],
    [
      { x: cx - halfU * uDirX + halfV * vDirX, y: cy - halfU * uDirY + halfV * vDirY },
      { x: cx + halfU * uDirX + halfV * vDirX, y: cy + halfU * uDirY + halfV * vDirY }
    ]
  ];
}
function _projectMeshToUniformRect(mesh, aspect) {
  const tl = mesh[0][0], tr = mesh[0][1];
  const bl = mesh[1][0], br = mesh[1][1];
  const cx = (tl.x + tr.x + bl.x + br.x) / 4;
  const cy = (tl.y + tr.y + bl.y + br.y) / 4;
  const ux = (tr.x - tl.x + (br.x - bl.x)) / 2;
  const uy = (tr.y - tl.y + (br.y - bl.y)) / 2;
  const uLen = Math.hypot(ux, uy);
  const uDirX = uLen > 0.01 ? ux / uLen : 1;
  const uDirY = uLen > 0.01 ? uy / uLen : 0;
  const vDirX = -uDirY, vDirY = uDirX;
  const vx = (bl.x - tl.x + (br.x - tr.x)) / 2;
  const vy = (bl.y - tl.y + (br.y - tr.y)) / 2;
  const vProj = vx * vDirX + vy * vDirY;
  const halfU = uLen / 2;
  const halfV = uLen / Math.max(0.01, aspect) / 2 * (vProj >= 0 ? 1 : -1);
  return [
    [
      { x: cx - halfU * uDirX - halfV * vDirX, y: cy - halfU * uDirY - halfV * vDirY },
      { x: cx + halfU * uDirX - halfV * vDirX, y: cy + halfU * uDirY - halfV * vDirY }
    ],
    [
      { x: cx - halfU * uDirX + halfV * vDirX, y: cy - halfU * uDirY + halfV * vDirY },
      { x: cx + halfU * uDirX + halfV * vDirX, y: cy + halfU * uDirY + halfV * vDirY }
    ]
  ];
}
function inverseBilinear(x, y, tl, tr, bl, br) {
  const ex = tr.x - tl.x, ey = tr.y - tl.y;
  const fx = bl.x - tl.x, fy = bl.y - tl.y;
  const det = ex * fy - ey * fx;
  if (Math.abs(det) < 1e-6) return null;
  const px = x - tl.x, py = y - tl.y;
  let u = (px * fy - py * fx) / det;
  let v = (-px * ey + py * ex) / det;
  for (let k = 0; k < 4; k++) {
    const fx_ = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x - x;
    const fy_ = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y - y;
    if (Math.abs(fx_) < 0.5 && Math.abs(fy_) < 0.5) break;
    const Jux = -(1 - v) * tl.x + (1 - v) * tr.x - v * bl.x + v * br.x;
    const Juy = -(1 - v) * tl.y + (1 - v) * tr.y - v * bl.y + v * br.y;
    const Jvx = -(1 - u) * tl.x - u * tr.x + (1 - u) * bl.x + u * br.x;
    const Jvy = -(1 - u) * tl.y - u * tr.y + (1 - u) * bl.y + u * br.y;
    const jdet = Jux * Jvy - Juy * Jvx;
    if (Math.abs(jdet) < 1e-6) break;
    u -= (fx_ * Jvy - fy_ * Jvx) / jdet;
    v -= (-fx_ * Juy + fy_ * Jux) / jdet;
  }
  return { u, v };
}
var PERSP_SUBDIV = 12;
var SMOOTH_SUBDIV = 6;
function drawMesh(ctx, srcCanvas, srcW, srcH, mesh, opts = {}) {
  let renderMesh;
  let densifySrc = false;
  if (mesh.length === 4 && opts.smooth) {
    renderMesh = subdivideCatmullRom4x4(mesh, SMOOTH_SUBDIV);
    densifySrc = true;
  } else if (mesh.length === 2) {
    renderMesh = subdivideQuadByHomography(mesh, PERSP_SUBDIV);
    densifySrc = true;
  } else {
    renderMesh = mesh;
  }
  const N = renderMesh.length;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const sxL = j * srcW / (N - 1);
      const sxR = (j + 1) * srcW / (N - 1);
      const syT = i * srcH / (N - 1);
      const syB = (i + 1) * srcH / (N - 1);
      const dTL = renderMesh[i][j], dTR = renderMesh[i][j + 1];
      const dBL = renderMesh[i + 1][j], dBR = renderMesh[i + 1][j + 1];
      drawTextureTri(
        ctx,
        srcCanvas,
        sxL,
        syT,
        sxR,
        syT,
        sxL,
        syB,
        dTL.x,
        dTL.y,
        dTR.x,
        dTR.y,
        dBL.x,
        dBL.y
      );
      drawTextureTri(
        ctx,
        srcCanvas,
        sxR,
        syT,
        sxR,
        syB,
        sxL,
        syB,
        dTR.x,
        dTR.y,
        dBR.x,
        dBR.y,
        dBL.x,
        dBL.y
      );
    }
  }
}
function homographyFromUnitSquareToQuad(tl, tr, br, bl) {
  const dx1 = tr.x - br.x, dy1 = tr.y - br.y;
  const dx2 = bl.x - br.x, dy2 = bl.y - br.y;
  const sx = tl.x - tr.x + br.x - bl.x;
  const sy = tl.y - tr.y + br.y - bl.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return {
    a: tr.x - tl.x + g * tr.x,
    b: bl.x - tl.x + h * bl.x,
    c: tl.x,
    d: tr.y - tl.y + g * tr.y,
    e: bl.y - tl.y + h * bl.y,
    f: tl.y,
    g,
    h
  };
}
function homographySample(H, u, v) {
  const w = H.g * u + H.h * v + 1;
  return {
    x: (H.a * u + H.b * v + H.c) / w,
    y: (H.d * u + H.e * v + H.f) / w
  };
}
function subdivideQuadByHomography(m, sub2) {
  const H = homographyFromUnitSquareToQuad(m[0][0], m[0][1], m[1][1], m[1][0]);
  if (!H) return m;
  const N = sub2 + 1;
  const out = [];
  for (let i = 0; i < N; i++) {
    out[i] = new Array(N);
    const v = i / sub2;
    for (let j = 0; j < N; j++) {
      const u = j / sub2;
      out[i][j] = homographySample(H, u, v);
    }
  }
  return out;
}
function subdivideCatmullRom4x4(m, sub2) {
  const rowDense = [];
  for (let i = 0; i < 4; i++) {
    rowDense.push(catmullRomSegments(m[i], sub2));
  }
  const cols = rowDense[0].length;
  const out = [];
  for (let bi = 0; bi < 3 * sub2 + 1; bi++) {
    out[bi] = new Array(cols);
  }
  for (let j = 0; j < cols; j++) {
    const colPts = [rowDense[0][j], rowDense[1][j], rowDense[2][j], rowDense[3][j]];
    const denseCol = catmullRomSegments(colPts, sub2);
    for (let i = 0; i < denseCol.length; i++) {
      out[i][j] = denseCol[i];
    }
  }
  return out;
}
function catmullRomSegments([p0, p1, p2, p3], sub2) {
  const pm1 = { x: 2 * p0.x - p1.x, y: 2 * p0.y - p1.y };
  const pp4 = { x: 2 * p3.x - p2.x, y: 2 * p3.y - p2.y };
  const out = [];
  out.push({ ...p0 });
  for (let s = 1; s <= sub2; s++) {
    out.push(catmullRomPoint(pm1, p0, p1, p2, s / sub2));
  }
  for (let s = 1; s <= sub2; s++) {
    out.push(catmullRomPoint(p0, p1, p2, p3, s / sub2));
  }
  for (let s = 1; s <= sub2; s++) {
    out.push(catmullRomPoint(p1, p2, p3, pp4, s / sub2));
  }
  return out;
}
function catmullRomPoint(P0, P1, P2, P3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2 * P1.x + (-P0.x + P2.x) * t + (2 * P0.x - 5 * P1.x + 4 * P2.x - P3.x) * t2 + (-P0.x + 3 * P1.x - 3 * P2.x + P3.x) * t3),
    y: 0.5 * (2 * P1.y + (-P0.y + P2.y) * t + (2 * P0.y - 5 * P1.y + 4 * P2.y - P3.y) * t2 + (-P0.y + 3 * P1.y - 3 * P2.y + P3.y) * t3)
  };
}
function renderQuadPerPixel(srcImageData, srcW, srcH, mesh, sampleMode = "bilinear") {
  const tl = mesh[0][0], tr = mesh[0][1], bl = mesh[1][0], br = mesh[1][1];
  const minX = Math.floor(Math.min(tl.x, tr.x, bl.x, br.x));
  const minY = Math.floor(Math.min(tl.y, tr.y, bl.y, br.y));
  const maxX = Math.ceil(Math.max(tl.x, tr.x, bl.x, br.x));
  const maxY = Math.ceil(Math.max(tl.y, tr.y, bl.y, br.y));
  const dstW = maxX - minX, dstH = maxY - minY;
  if (dstW <= 0 || dstH <= 0) return null;
  const Hfwd = homographyFromUnitSquareToQuad(tl, tr, br, bl);
  if (!Hfwd) return null;
  const H9 = [Hfwd.a, Hfwd.b, Hfwd.c, Hfwd.d, Hfwd.e, Hfwd.f, Hfwd.g, Hfwd.h, 1];
  const Hinv = invertMat3(H9);
  if (!Hinv) return null;
  const out = new ImageData(dstW, dstH);
  const odata = out.data;
  const sdata = srcImageData.data;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const docX = minX + dx + 0.5;
      const docY = minY + dy + 0.5;
      const w = Hinv[6] * docX + Hinv[7] * docY + Hinv[8];
      if (Math.abs(w) < 1e-9) continue;
      const u = (Hinv[0] * docX + Hinv[1] * docY + Hinv[2]) / w;
      const v = (Hinv[3] * docX + Hinv[4] * docY + Hinv[5]) / w;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sx = u * srcW;
      const sy = v * srcH;
      if (sampleMode === "nearest") {
        nearestSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
      } else if (sampleMode === "bicubic") {
        bicubicSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
      } else {
        bilinearSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
      }
    }
  }
  const canvas = makeBitmap2(dstW, dstH);
  const c = canvas.getContext("2d");
  c.putImageData(out, 0, 0);
  return { canvas, dstX: minX, dstY: minY };
}
function nearestSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return;
  const p = (iy * w + ix) * 4;
  ddat[dstIdx] = sdat[p];
  ddat[dstIdx + 1] = sdat[p + 1];
  ddat[dstIdx + 2] = sdat[p + 2];
  ddat[dstIdx + 3] = sdat[p + 3];
}
function bicubicSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const k = (t) => {
    const a2 = -0.5;
    const at = Math.abs(t);
    if (at < 1) return (a2 + 2) * at * at * at - (a2 + 3) * at * at + 1;
    if (at < 2) return a2 * at * at * at - 5 * a2 * at * at + 8 * a2 * at - 4 * a2;
    return 0;
  };
  const kx = [k(ix - 1 - sx), k(ix - sx), k(ix + 1 - sx), k(ix + 2 - sx)];
  const ky = [k(iy - 1 - sy), k(iy - sy), k(iy + 1 - sy), k(iy + 2 - sy)];
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 4; j++) {
    const yy = iy - 1 + j;
    if (yy < 0 || yy >= h) continue;
    for (let i = 0; i < 4; i++) {
      const xx = ix - 1 + i;
      if (xx < 0 || xx >= w) continue;
      const p = (yy * w + xx) * 4;
      const ww = kx[i] * ky[j];
      r += sdat[p] * ww;
      g += sdat[p + 1] * ww;
      b += sdat[p + 2] * ww;
      a += sdat[p + 3] * ww;
    }
  }
  ddat[dstIdx] = Math.max(0, Math.min(255, r));
  ddat[dstIdx + 1] = Math.max(0, Math.min(255, g));
  ddat[dstIdx + 2] = Math.max(0, Math.min(255, b));
  ddat[dstIdx + 3] = Math.max(0, Math.min(255, a));
}
function bilinearSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const x0 = ix, x1 = ix + 1;
  const y0 = iy, y1 = iy + 1;
  const p00 = x0 >= 0 && x0 < w && y0 >= 0 && y0 < h ? (y0 * w + x0) * 4 : -1;
  const p10 = x1 >= 0 && x1 < w && y0 >= 0 && y0 < h ? (y0 * w + x1) * 4 : -1;
  const p01 = x0 >= 0 && x0 < w && y1 >= 0 && y1 < h ? (y1 * w + x0) * 4 : -1;
  const p11 = x1 >= 0 && x1 < w && y1 >= 0 && y1 < h ? (y1 * w + x1) * 4 : -1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 4; c++) {
    let v = 0;
    if (p00 >= 0) v += sdat[p00 + c] * w00;
    if (p10 >= 0) v += sdat[p10 + c] * w10;
    if (p01 >= 0) v += sdat[p01 + c] * w01;
    if (p11 >= 0) v += sdat[p11 + c] * w11;
    ddat[dstIdx + c] = v;
  }
}
function invertMat3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [
    (e * i - f * h) / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    -(d * i - f * g) / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    (d * h - e * g) / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det
  ];
  if (Math.abs(inv[8]) > 1e-9) {
    const k = 1 / inv[8];
    for (let n = 0; n < 9; n++) inv[n] *= k;
  }
  return inv;
}
function drawTextureTri(ctx, src, sx0, sy0, sx1, sy1, sx2, sy2, dx0, dy0, dx1, dy1, dx2, dy2) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();
  const denom = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
  if (Math.abs(denom) < 1e-9) {
    ctx.restore();
    return;
  }
  const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / denom;
  const c = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / denom;
  const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / denom;
  const d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / denom;
  const e = dx0 - a * sx0 - c * sy0;
  const f = dy0 - b * sx0 - d * sy0;
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}

// src/board.js
var MIN_SCALE = 0.05;
var MAX_SCALE = 32;
var Board = class _Board {
  constructor(canvas, doc2) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.doc = doc2;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.viewport = { tx: 0, ty: 0, scale: 1, rot: 0 };
    this.minScale = MIN_SCALE;
    this.maxScale = MAX_SCALE;
    this._raf = null;
    this._cursor = null;
    this._showCursor = false;
    this._dirtyDocRect = null;
    this._dirtyFull = true;
    this._voidColor = "#e6e2d6";
    this._showCheckerboard = false;
    this._overlayProvider = null;
    this._eraseComposite = null;
    this._eraseCompositeKey = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this.resize());
      window.visualViewport.addEventListener("scroll", () => this.resize());
    }
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas);
    }
    this.fitToScreen();
  }
  setDoc(doc2) {
    this.doc = doc2;
    this._dirtyFull = true;
    this.fitToScreen();
  }
  setShowCheckerboard(on) {
    this._showCheckerboard = !!on;
    this._dirtyFull = true;
  }
  setThemeColors({ voidColor }) {
    if (voidColor) this._voidColor = voidColor;
    this._dirtyFull = true;
    this.requestRender();
  }
  // 由 BrushEngine 报告："这一帧 layer 像素被改在这片 doc-px bbox 里"
  markDocDirty(x0, y0, x1, y1) {
    if (this._dirtyDocRect) {
      const d = this._dirtyDocRect;
      if (x0 < d[0]) d[0] = x0;
      if (y0 < d[1]) d[1] = y0;
      if (x1 > d[2]) d[2] = x1;
      if (y1 > d[3]) d[3] = y1;
    } else {
      this._dirtyDocRect = [x0, y0, x1, y1];
    }
    if (!_Board._dispatchingDirty) {
      _Board._dispatchingDirty = true;
      window.dispatchEvent(new CustomEvent("wp:docpixeldirty"));
      _Board._dispatchingDirty = false;
    }
  }
  // 视口 / 主题 / 光标 / 图层结构改了 → 整张重画
  markFullDirty() {
    this._dirtyFull = true;
  }
  // ---- 坐标 ----
  // 视口变换：
  //   screen = R(rot, doc_center_screen) ∘ scale ∘ translate_by_(tx,ty)
  // 其中 doc_center_screen = (tx + W*scale/2, ty + H*scale/2)（rot=0 时即 doc 中心
  // 在屏幕上的位置）。rotation 围绕 doc center 转 = 用户直观的"原地旋转画布"。
  _docCenterScreen() {
    const { tx, ty, scale } = this.viewport;
    return { cx: tx + this.doc.width * scale / 2, cy: ty + this.doc.height * scale / 2 };
  }
  screenToDoc(sx, sy) {
    const { scale, rot } = this.viewport;
    const { cx, cy } = this._docCenterScreen();
    const dx = sx - cx, dy = sy - cy;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return { x: rx / scale + this.doc.width / 2, y: ry / scale + this.doc.height / 2 };
  }
  docToScreen(dx, dy) {
    const { scale, rot } = this.viewport;
    const { cx, cy } = this._docCenterScreen();
    const x = (dx - this.doc.width / 2) * scale;
    const y = (dy - this.doc.height / 2) * scale;
    const c = Math.cos(rot), s = Math.sin(rot);
    return { x: x * c - y * s + cx, y: x * s + y * c + cy };
  }
  // ---- 视口 ----（任何视口变都是全屏 dirty）
  pan(dx, dy) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._dirtyFull = true;
    this.requestRender();
  }
  // anchor 在 screen 坐标。zoom 时保 anchor 在 screen 上的 doc 点不变。
  zoomAt(anchorX, anchorY, factor) {
    const oldScale = this.viewport.scale;
    const newScale = clamp(oldScale * factor, this.minScale, this.maxScale);
    if (newScale === oldScale) return;
    const docPt = this.screenToDoc(anchorX, anchorY);
    this.viewport.scale = newScale;
    const after = this.docToScreen(docPt.x, docPt.y);
    this.viewport.tx += anchorX - after.x;
    this.viewport.ty += anchorY - after.y;
    this._dirtyFull = true;
    this.requestRender();
  }
  // rotateAt 围绕 screen anchor 旋转视口（delta 是 radian 增量）
  rotateAt(anchorX, anchorY, deltaRot) {
    const docPt = this.screenToDoc(anchorX, anchorY);
    this.viewport.rot += deltaRot;
    const after = this.docToScreen(docPt.x, docPt.y);
    this.viewport.tx += anchorX - after.x;
    this.viewport.ty += anchorY - after.y;
    this._dirtyFull = true;
    this.requestRender();
  }
  setViewport(tx, ty, scale, rot) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    if (typeof rot === "number") this.viewport.rot = rot;
    this._dirtyFull = true;
    this.requestRender();
  }
  // 适配屏幕：让 doc 居中并铺满（留一点边）。同时复位 rotation。
  fitToScreen(padding = 24) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this.doc) return;
    const sx = (w - padding * 2) / this.doc.width;
    const sy = (h - padding * 2) / this.doc.height;
    const s = Math.min(sx, sy);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const tx = (w - this.doc.width * scale) / 2;
    const ty = (h - this.doc.height * scale) / 2;
    this.setViewport(tx, ty, scale, 0);
  }
  // 公共 API：layer 像素被改了（图层结构变 / 切换 / putImageData 等）
  invalidateAll() {
    this._dirtyFull = true;
    this.requestRender();
  }
  setOverlayProvider(fn) {
    this._overlayProvider = fn;
  }
  // 套索 overlay：在 layer 像素之上画一条 polygon (drawing) 或 floating canvas + marching ants
  setLassoProvider(fn) {
    this._lassoProvider = fn;
  }
  // v110: 给某 layer 在 board 渲染时套 ctx.filter（颜色调整 live preview）—— v113 撤
  // ctx.filter on iPad Safari Canvas2D 偶发不渲染 (user：「颜色调整预览，apply 都没用」)
  setActiveLayerFilter() {
  }
  // v113: 颜色调整 live preview 走 surrogate canvas（per-pixel JS BCSH 之后塞进来）
  // (layerId, canvas) 启动；(null, null) 关
  setActiveLayerSurrogate(layerId, canvas) {
    this._activeSurrogateLayerId = layerId;
    this._activeSurrogateCanvas = canvas;
    this.invalidateAll();
  }
  // 复用 erase 临时合成 canvas（同 doc 尺寸；改了重新分配）
  _getEraseComposite(w, h) {
    const key = `${w}x${h}`;
    if (!this._eraseComposite || this._eraseCompositeKey !== key) {
      this._eraseComposite = document.createElement("canvas");
      this._eraseComposite.width = w;
      this._eraseComposite.height = h;
      this._eraseCompositeKey = key;
    }
    return this._eraseComposite;
  }
  // Clipping mask 临时合成 canvas。grow-only：取所有用过的 layer.bbox 最大值。
  // 不和 _eraseComposite 共用（同一帧可能两者都要）。
  _getClipTmp(w, h) {
    if (!this._clipTmp || this._clipTmp.width < w || this._clipTmp.height < h) {
      const nw = Math.max(this._clipTmp?.width || 0, w);
      const nh = Math.max(this._clipTmp?.height || 0, h);
      this._clipTmp = document.createElement("canvas");
      this._clipTmp.width = nw;
      this._clipTmp.height = nh;
    }
    return this._clipTmp;
  }
  // Overlay 选区裁剪临时 canvas。同一帧 ≤ 1 颗 active 层有 overlay，独占用。
  _getOverlayClipTmp(w, h) {
    if (!this._overlayClipTmp || this._overlayClipTmp.width < w || this._overlayClipTmp.height < h) {
      const nw = Math.max(this._overlayClipTmp?.width || 0, w);
      const nh = Math.max(this._overlayClipTmp?.height || 0, h);
      this._overlayClipTmp = document.createElement("canvas");
      this._overlayClipTmp.width = nw;
      this._overlayClipTmp.height = nh;
    }
    return this._overlayClipTmp;
  }
  // 把笔刷 live overlay 按 doc.selection mask 裁一遍，让画中实时看到选区限制。
  // 返回一个**新 overlay 描述**，canvas 指向裁过的临时 canvas；bbox 保持不变（局部坐标不变）。
  // 落笔后 applySelectionMaskPostStroke 会做最终持久化裁；这里只是 preview。
  _clipOverlayToSelection(overlay, selection) {
    const tmp = this._getOverlayClipTmp(overlay.bboxW, overlay.bboxH);
    const tctx = tmp.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, overlay.bboxW, overlay.bboxH);
    tctx.drawImage(overlay.canvas, 0, 0);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(
      selection.maskCanvas,
      selection.bboxX - overlay.bboxX,
      selection.bboxY - overlay.bboxY
    );
    tctx.globalCompositeOperation = "source-over";
    return { ...overlay, canvas: tmp };
  }
  // 给一颗 clipping mask 层做 dst-in 剪裁 + composite 到 ctx。
  // 算法：在 tmp 上先以 layer.bbox 局部坐标渲染 (layer + overlay) → dst-in base alpha
  //       → 把 tmp 当一张 (bboxW × bboxH) image drawImage 到 ctx 的 doc 坐标 bbox 位置。
  // 注意：tmp 复用，先 clearRect(0, 0, bboxW, bboxH) 防上一次脏数据残留。
  _renderLayerClipped(ctx, layer, baseLayer, overlay) {
    const tmp = this._getClipTmp(layer.bboxW, layer.bboxH);
    const tctx = tmp.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, layer.bboxW, layer.bboxH);
    tctx.setTransform(1, 0, 0, 1, -layer.bboxX, -layer.bboxY);
    this._drawLayerWithOverlay(tctx, layer, overlay);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(baseLayer.canvas, baseLayer.bboxX - layer.bboxX, baseLayer.bboxY - layer.bboxY);
    tctx.globalCompositeOperation = "source-over";
    ctx.drawImage(
      tmp,
      0,
      0,
      layer.bboxW,
      layer.bboxH,
      layer.bboxX,
      layer.bboxY,
      layer.bboxW,
      layer.bboxH
    );
  }
  // 把 (layer, overlay) 在 ctx 上 composite。ctx 已经被调用方 setTransform
  // 到 **doc 坐标系**（doc (0,0) = ctx origin，doc (W,H) = (W,H) in ctx）。
  // 所以这里 drawImage 的 dest 直接用 layer.bboxX/Y/W/H（doc 坐标）。
  _drawLayerWithOverlay(ctx, layer, overlay) {
    const sourceCanvas = this._activeSurrogateLayerId === layer.id && this._activeSurrogateCanvas ? this._activeSurrogateCanvas : layer.canvas;
    if (!overlay || overlay.mode !== "erase") {
      ctx.drawImage(
        sourceCanvas,
        0,
        0,
        layer.bboxW,
        layer.bboxH,
        layer.bboxX,
        layer.bboxY,
        layer.bboxW,
        layer.bboxH
      );
      if (overlay) {
        const prevA = ctx.globalAlpha;
        ctx.globalAlpha = ctx.globalAlpha * overlay.opacity;
        ctx.drawImage(
          overlay.canvas,
          0,
          0,
          overlay.bboxW,
          overlay.bboxH,
          overlay.bboxX,
          overlay.bboxY,
          overlay.bboxW,
          overlay.bboxH
        );
        ctx.globalAlpha = prevA;
      }
      return;
    }
    const ec = this._getEraseComposite(layer.bboxW, layer.bboxH);
    const ectx = ec.getContext("2d");
    ectx.clearRect(0, 0, ec.width, ec.height);
    ectx.drawImage(layer.canvas, 0, 0);
    ectx.globalAlpha = overlay.opacity;
    ectx.globalCompositeOperation = "destination-out";
    ectx.drawImage(overlay.canvas, overlay.bboxX - layer.bboxX, overlay.bboxY - layer.bboxY);
    ectx.globalAlpha = 1;
    ectx.globalCompositeOperation = "source-over";
    ctx.drawImage(
      ec,
      0,
      0,
      ec.width,
      ec.height,
      layer.bboxX,
      layer.bboxY,
      ec.width,
      ec.height
    );
  }
  // 把 ctx 设到 "doc 坐标系"：doc (0,0) 映射到 ctx 当前 origin，含 dpr +
  // viewport (tx,ty,scale,rot) 全部。setTransform 接 6 浮点 a,b,c,d,e,f：
  //   screen.x = a*doc.x + c*doc.y + e
  //   screen.y = b*doc.x + d*doc.y + f
  // 我们的视口：先平移 -W/2 (-H/2) → 缩放 scale → 旋转 rot → 平移到屏幕上
  // doc center。dpr 在所有之外（用 setTransform 顶层再乘）。
  _applyDocTransform(ctx) {
    const { scale, rot } = this.viewport;
    const dpr = this.dpr;
    const { cx, cy } = this._docCenterScreen();
    const W = this.doc.width, H = this.doc.height;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const a = scale * cosR;
    const b = scale * sinR;
    const c = -scale * sinR;
    const d = scale * cosR;
    const e = cx - a * (W / 2) - c * (H / 2);
    const f = cy - b * (W / 2) - d * (H / 2);
    ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
  }
  // ---- 渲染 ----
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const tw = Math.round(w * dpr);
    const th = Math.round(h * dpr);
    if (tw === this.canvas.width && th === this.canvas.height && dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = tw;
    this.canvas.height = th;
    this._dirtyFull = true;
    this.requestRender();
  }
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }
  setCursor(c) {
    const wasShown = this._showCursor;
    this._cursor = c;
    this._showCursor = !!c;
    if (wasShown || this._showCursor) this._dirtyFull = true;
    this.requestRender();
  }
  render() {
    if (!this.doc) return;
    if (this._dirtyFull || !this._dirtyDocRect) {
      this._renderFull();
    } else {
      this._renderPartial(this._dirtyDocRect);
    }
    this._dirtyDocRect = null;
    this._dirtyFull = false;
  }
  _renderFull() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(0, 0, W, H);
    this._applyDocTransform(ctx);
    const { scale } = this.viewport;
    if (scale > 1) {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";
    }
    if (this._showCheckerboard) {
      this._drawCheckerboard(ctx, this.doc.width, this.doc.height);
    } else {
      ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }
    this._renderLayers(ctx);
    this._drawLassoOverlay(ctx, scale);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this._showCursor && this._cursor) this._drawCursor();
  }
  // 只重画 docRect 覆盖的区域。**rot != 0 时直接走 full**（旋转 dirty rect
  // 在 screen 上是斜矩形，clip + 算屏幕 bbox 复杂度不值，stamp 路径少见旋转后画）
  _renderPartial(docRect) {
    if (this._lassoProvider) {
      const info = this._lassoProvider();
      if (info && (info.drawingPath?.length || info.floating || info.selection)) {
        this._renderFull();
        return;
      }
    }
    if (this.viewport.rot !== 0) {
      this._renderFull();
      return;
    }
    const ctx = this.ctx;
    const { tx, ty, scale } = this.viewport;
    const pad = Math.max(1, 2 / scale);
    const dx0 = docRect[0] - pad;
    const dy0 = docRect[1] - pad;
    const dx1 = docRect[2] + pad;
    const dy1 = docRect[3] + pad;
    const sx = dx0 * scale + tx;
    const sy = dy0 * scale + ty;
    const sw = (dx1 - dx0) * scale;
    const sh = (dy1 - dy0) * scale;
    const w = this.canvas.clientWidth || this.canvas.width / this.dpr;
    const h = this.canvas.clientHeight || this.canvas.height / this.dpr;
    if (sx + sw < 0 || sy + sh < 0 || sx > w || sy > h) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(sx, sy, sw, sh);
    this._applyDocTransform(ctx);
    if (scale > 1) {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";
    }
    if (this._showCheckerboard) {
      this._drawCheckerboard(ctx, this.doc.width, this.doc.height);
    } else {
      ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }
    this._renderLayers(ctx);
    ctx.restore();
  }
  // 一段逻辑两处用（_renderFull / _renderPartial）。带 clipping mask 处理。
  // ctx 已经在 doc 坐标系（drawImage 的 dest 用 doc 坐标）。
  _renderLayers(ctx) {
    const overlay = this._overlayProvider?.();
    const layers = this.doc.layers;
    const baseFor = computeClipBaseFor(layers);
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible) continue;
      if (layer.bboxW <= 0 || layer.bboxH <= 0) continue;
      const prevAlpha = ctx.globalAlpha;
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.mode || "source-over";
      let lOverlay = overlay && overlay.layer === layer ? overlay : null;
      if (lOverlay && this.doc.selection) {
        lOverlay = this._clipOverlayToSelection(lOverlay, this.doc.selection);
      }
      const baseIdx = baseFor[i];
      if (baseIdx < 0) {
        this._drawLayerWithOverlay(ctx, layer, lOverlay);
      } else {
        this._renderLayerClipped(ctx, layer, layers[baseIdx], lOverlay);
      }
      ctx.globalAlpha = prevAlpha;
      ctx.globalCompositeOperation = prevComp;
    }
  }
  _drawCursor() {
    const ctx = this.ctx;
    const c = this._cursor;
    const { scale } = this.viewport;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(2, c.size * scale / 2), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(2, c.size * scale / 2) + 1, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 套索 overlay：
  //   drawing 期间：画 polyline overlay
  //   floating：用 mesh 三角剖分画浮层；画 mesh 边框 + 内部线 + handles
  // 边框 / mesh 线在 doc 坐标系（随缩放）；handles 在 screen 坐标（恒定像素大小）
  _drawLassoOverlay(ctx, scale) {
    if (!this._lassoProvider) return;
    const info = this._lassoProvider();
    if (!info) return;
    if (info.selection && !info.floating) {
      const s = info.selection;
      if (!s._chains) {
        if (!s._outline) s._outline = extractMaskOutline(s);
        s._chains = chainMaskOutline(s._outline);
      }
      ctx.save();
      const dash = 4 / scale;
      ctx.lineWidth = 1.2 / scale;
      ctx.lineCap = "butt";
      ctx.setLineDash([dash, dash]);
      ctx.beginPath();
      for (const ch of s._chains) {
        ctx.moveTo(ch[0], ch[1]);
        for (let i = 2; i < ch.length; i += 2) ctx.lineTo(ch[i], ch[i + 1]);
      }
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
    }
    if (info.drawingPath && info.drawingPath.length >= 2) {
      const dash = 4 / scale;
      ctx.save();
      ctx.lineWidth = 1.2 / scale;
      ctx.lineCap = "butt";
      ctx.setLineDash([dash, dash]);
      ctx.beginPath();
      const pts = info.drawingPath;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
    }
    const drawShape = info.drawingRect || info.drawingEllipse;
    if (drawShape) {
      const r = drawShape;
      const dash = 4 / scale;
      ctx.save();
      ctx.lineWidth = 1.2 / scale;
      ctx.setLineDash([dash, dash]);
      const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
      const isEllipse = !!info.drawingEllipse;
      const stroke2x = () => {
        ctx.strokeStyle = "#000";
        ctx.lineDashOffset = 0;
        ctx.stroke();
        ctx.strokeStyle = "#fff";
        ctx.lineDashOffset = dash;
        ctx.stroke();
      };
      ctx.beginPath();
      if (isEllipse) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(x, y, w, h);
      stroke2x();
      ctx.restore();
    }
    if (info.floating) {
      const f = info.floating;
      const isWarp = f.mode === "warp";
      ctx.save();
      if (f.meshN === 2) {
        if (!f._renderCache) {
          f._renderCache = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh, info.sampleMode);
        }
        if (f._renderCache) {
          ctx.drawImage(f._renderCache.canvas, f._renderCache.dstX, f._renderCache.dstY);
        }
      } else {
        drawMesh(ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: info.sampleMode !== "nearest" });
      }
      const N = f.meshN;
      ctx.lineWidth = Math.max(1, 1.5 / scale);
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.beginPath();
      ctx.moveTo(f.mesh[0][0].x, f.mesh[0][0].y);
      for (let j = 1; j < N; j++) ctx.lineTo(f.mesh[0][j].x, f.mesh[0][j].y);
      for (let i = 1; i < N; i++) ctx.lineTo(f.mesh[i][N - 1].x, f.mesh[i][N - 1].y);
      for (let j = N - 2; j >= 0; j--) ctx.lineTo(f.mesh[N - 1][j].x, f.mesh[N - 1][j].y);
      for (let i = N - 2; i >= 1; i--) ctx.lineTo(f.mesh[i][0].x, f.mesh[i][0].y);
      ctx.closePath();
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineDashOffset = 5 / scale;
      ctx.stroke();
      if (isWarp && f.mode !== null) {
        ctx.setLineDash([]);
        ctx.lineWidth = Math.max(0.5, 0.75 / scale);
        ctx.strokeStyle = "rgba(128,128,128,0.35)";
        ctx.beginPath();
        for (let i = 1; i < N - 1; i++) {
          ctx.moveTo(f.mesh[i][0].x, f.mesh[i][0].y);
          for (let j = 1; j < N; j++) ctx.lineTo(f.mesh[i][j].x, f.mesh[i][j].y);
        }
        for (let j = 1; j < N - 1; j++) {
          ctx.moveTo(f.mesh[0][j].x, f.mesh[0][j].y);
          for (let i = 1; i < N; i++) ctx.lineTo(f.mesh[i][j].x, f.mesh[i][j].y);
        }
        ctx.stroke();
      }
      ctx.restore();
      if (info.handles && info.handles.length) {
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        for (const h of info.handles) {
          const s = this.docToScreen(h.pos.x, h.pos.y);
          if (h.kind === "warp-point") {
            ctx.beginPath();
            ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,0.8)";
            ctx.lineWidth = 1;
            ctx.stroke();
          } else if (h.kind === "rotate") {
            if (h.anchor) {
              const a = this.docToScreen(h.anchor.x, h.anchor.y);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(s.x, s.y);
              ctx.strokeStyle = "rgba(0,0,0,0.6)";
              ctx.lineWidth = 1;
              ctx.stroke();
            }
            ctx.beginPath();
            ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
  }
  // 画 doc 区半透明灰白格背景。在 doc 坐标系下画（cell = 16 doc-px）。
  _drawCheckerboard(ctx, W, H) {
    const cell = 16;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#c8c8c8";
    for (let y = 0; y < H; y += cell) {
      for (let x = (y / cell | 0) % 2 ? 0 : cell; x < W; x += cell * 2) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
};
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// src/brush.js
var DEFAULT_SETTINGS = {
  type: "round",
  size: 12,
  color: "#1b1b1b",
  // 用户当场调（per-tool 持久）：
  opacity: 1,
  // user.opacity —— 应用在 endStroke composite (Π 外)
  flow: 1,
  // user.flow —— 进 α_dab (Π 内)
  // 压感 dynamics（preset 冻结，−1..1 signed）：
  sizeCoeff: 0.6,
  opaCoeff: 0.6,
  flowCoeff: 0,
  pressureGamma: 1,
  // v102: 压感时间域 LPF (ms，一阶 IIR)
  // 0 = raw，正值 = 平滑（解 "转角顿一下 out-leg 突然细" 的问题）
  pressureLPF: 0,
  // shape：
  hardness: 0.75,
  shapeKind: "round",
  shapeAspect: 1,
  shapeRotation: 0,
  // spacing：
  spacing: 0.12,
  // buffer 合成模式：
  compositeMode: "wash",
  // "wash" = Alpha Darken (JS max), "buildup" = source-over (Canvas2D native)
  // pixel mode：
  pixelMode: false,
  // 位置平滑（input.js 用，不在引擎）：
  streamline: 0.3,
  stabilization: 0,
  pullStabilizer: 0,
  motionFilter: 0,
  // 系统级 anti-spike taper（Apple Pencil 落笔 spike → 萝卜尖补偿）：
  // 这是硬件信号缺陷补偿，跟 brush 风格 taper 分开；preset 的 taper.in/out 是 stylistic 的
  taperIn: 1.5,
  taperFloor: 0.4,
  // smudge：
  smudgeStrength: 0.8,
  smudgeDryness: 0.1,
  // legacy 字段（applyBrushPresetFrozen 老路径可能 reference，no-op）：
  pressureToSize: true,
  pressureToOpacity: true
};
var BrushSettings = class _BrushSettings {
  constructor(overrides) {
    Object.assign(this, DEFAULT_SETTINGS, overrides || {});
  }
  clone(over) {
    return new _BrushSettings({ ...this, ...over });
  }
};
function signedLerp(coeff, p) {
  const amp = 1 - Math.abs(coeff);
  return coeff >= 0 ? amp + (1 - amp) * p : 1 + (amp - 1) * p;
}
var BrushEngine = class {
  constructor() {
    this._stampCache = null;
    this._stroke = null;
  }
  // 预渲染 colored stamp（Build-Up native path 用，drawImage 当 texture）。
  // PERF：cache key 不含 size —— stamp 按 baseSize 烤一次，每颗 drawImage 缩到目标 size。
  // v107: 撤 createRadialGradient（linear interp，dα/dr 在 boundary 非 0 → C0 不连续），
  // 改 putImageData 用 JS per-pixel 真值 smoothstep 烤。bake 一次的开销换 stamp 完全无 banding。
  _getStamp(size, hardness, color, mode) {
    const useColor = mode === "erase" ? "#000" : color;
    const key = `${useColor}|${hardness.toFixed(3)}|${mode}`;
    if (this._stampCache && this._stampCache.key === key && this._stampCache.baseSize >= size) {
      return this._stampCache;
    }
    const baseSize = Math.max(64, Math.ceil(size));
    const d = baseSize + 2;
    const r = d / 2;
    const stamp = document.createElement("canvas");
    stamp.width = d;
    stamp.height = d;
    const sctx = stamp.getContext("2d");
    const hd = Math.max(0, Math.min(0.999, hardness));
    const innerR = hd * r;
    const decayLen = r - innerR;
    const col = hexToRgbObj(useColor);
    const img = sctx.createImageData(d, d);
    const data = img.data;
    for (let py = 0; py < d; py++) {
      const dy = py + 0.5 - r;
      for (let px = 0; px < d; px++) {
        const dx = px + 0.5 - r;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let alpha;
        if (dist >= r) alpha = 0;
        else if (decayLen === 0 || dist <= innerR) alpha = 1;
        else {
          const u = (dist - innerR) / decayLen;
          alpha = 1 - u * u * (3 - 2 * u);
        }
        const idx = (py * d + px) * 4;
        data[idx] = col.r;
        data[idx + 1] = col.g;
        data[idx + 2] = col.b;
        data[idx + 3] = Math.round(alpha * 255);
      }
    }
    sctx.putImageData(img, 0, 0);
    this._stampCache = { key, canvas: stamp, baseSize, radius: r };
    return this._stampCache;
  }
  invalidateStamp() {
    this._stampCache = null;
  }
  setColor(color) {
    if (this._stroke) {
      this._stroke.settings.color = color;
      this._stroke.overlayDirty = true;
    }
    this.invalidateStamp();
  }
  // step = size_eff × spacing；低压感 size 小 → step 小，不会出豆豆链
  _stepFor(s, pressure) {
    const p = Math.max(0, Math.min(1, pressure));
    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1));
    const sizeMul = signedLerp(s.sizeCoeff || 0, pCurve);
    const effSize = s.size * sizeMul;
    return Math.max(0.5, effSize * s.spacing);
  }
  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    let loaded = null;
    if (mode === "smudge") loaded = this._sampleLayerColor(layer, x, y);
    const isBuildup = (settings.compositeMode || "wash") === "buildup";
    const pLPF0 = pressure;
    this._stroke = {
      layer,
      settings,
      mode,
      lastX: x,
      lastY: y,
      lastP: pLPF0,
      pLPF: pLPF0,
      // 当前 LPF 态
      lastEventTime: performance.now(),
      accumDist: 0,
      strokeDist: 0,
      dirty: null,
      // Build-Up path：bufferCanvas (RGBA Canvas2D, native source-over)
      // Wash path：bufferData (Uint8ClampedArray, JS per-pixel max)
      isBuildup,
      bufferCanvas: null,
      bufferCtx: null,
      // Build-Up only
      bufferData: null,
      // Wash only
      bufBboxX: layer.bboxX,
      bufBboxY: layer.bboxY,
      bufBboxW: 0,
      bufBboxH: 0,
      overlayCanvas: null,
      // Wash only（Build-Up 直接用 bufferCanvas）
      overlayDirty: false,
      loaded
    };
    this._stampOne(x, y, pressure);
  }
  _ensureBufferBbox(x0, y0, x1, y1) {
    const st = this._stroke;
    const m = 32;
    let nx, ny, nx1, ny1;
    if (st.bufBboxW === 0) {
      nx = Math.floor(x0 - m);
      ny = Math.floor(y0 - m);
      nx1 = Math.ceil(x1 + m);
      ny1 = Math.ceil(y1 + m);
    } else {
      if (x0 >= st.bufBboxX && y0 >= st.bufBboxY && x1 <= st.bufBboxX + st.bufBboxW && y1 <= st.bufBboxY + st.bufBboxH) return;
      nx = Math.floor(Math.min(st.bufBboxX, x0 - m));
      ny = Math.floor(Math.min(st.bufBboxY, y0 - m));
      nx1 = Math.ceil(Math.max(st.bufBboxX + st.bufBboxW, x1 + m));
      ny1 = Math.ceil(Math.max(st.bufBboxY + st.bufBboxH, y1 + m));
    }
    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    nx1 = Math.min(st.layer.docW, nx1);
    ny1 = Math.min(st.layer.docH, ny1);
    const nw = nx1 - nx;
    const nh = ny1 - ny;
    if (nw <= 0 || nh <= 0) return;
    if (st.isBuildup) {
      const newCanvas = document.createElement("canvas");
      newCanvas.width = nw;
      newCanvas.height = nh;
      const newCtx = newCanvas.getContext("2d");
      if (st.bufferCanvas && st.bufBboxW > 0 && st.bufBboxH > 0) {
        newCtx.drawImage(st.bufferCanvas, st.bufBboxX - nx, st.bufBboxY - ny);
      }
      st.bufferCanvas = newCanvas;
      st.bufferCtx = newCtx;
    } else {
      const newBuf = new Uint8ClampedArray(nw * nh);
      if (st.bufferData && st.bufBboxW > 0 && st.bufBboxH > 0) {
        const dx = st.bufBboxX - nx;
        const dy = st.bufBboxY - ny;
        const oldW = st.bufBboxW;
        const oldH = st.bufBboxH;
        for (let y = 0; y < oldH; y++) {
          const oldOff = y * oldW;
          const newOff = (y + dy) * nw + dx;
          for (let x = 0; x < oldW; x++) {
            newBuf[newOff + x] = st.bufferData[oldOff + x];
          }
        }
      }
      st.bufferData = newBuf;
      st.overlayCanvas = null;
    }
    st.bufBboxX = nx;
    st.bufBboxY = ny;
    st.bufBboxW = nw;
    st.bufBboxH = nh;
  }
  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const tau = st.settings.pressureLPF || 0;
    const now = performance.now();
    const dt = Math.max(1, now - st.lastEventTime);
    st.lastEventTime = now;
    let pEff;
    if (tau > 0) {
      const alpha = dt / (dt + tau);
      st.pLPF += alpha * (pressure - st.pLPF);
      pEff = st.pLPF;
    } else {
      pEff = pressure;
      st.pLPF = pressure;
    }
    const dx = x - st.lastX;
    const dy = y - st.lastY;
    const L = Math.hypot(dx, dy);
    if (L === 0) return;
    let pos = 0;
    while (true) {
      const step = this._stepFor(st.settings, pEff);
      if (st.accumDist + (L - pos) < step) break;
      const need = step - st.accumDist;
      pos += need;
      st.strokeDist += step;
      const t = pos / L;
      const sx = st.lastX + dx * t;
      const sy = st.lastY + dy * t;
      const sp = st.lastP + (pEff - st.lastP) * t;
      this._stampOne(sx, sy, sp);
      st.accumDist = 0;
    }
    st.accumDist += L - pos;
    st.lastX = x;
    st.lastY = y;
    st.lastP = pEff;
  }
  endStroke() {
    const st = this._stroke;
    if (st && (st.bufferCanvas || st.bufferData)) this._compositeBufferToLayer();
    this._stroke = null;
  }
  cancelStroke() {
    this._stroke = null;
  }
  _compositeBufferToLayer() {
    const st = this._stroke;
    const layer = st.layer;
    const ctx = layer.ctx;
    const composeCanvas = st.isBuildup ? st.bufferCanvas : this._renderWashToCanvas();
    if (!composeCanvas) return;
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = Math.max(0, Math.min(1, st.settings.opacity ?? 1));
    ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";
    ctx.drawImage(composeCanvas, st.bufBboxX - layer.bboxX, st.bufBboxY - layer.bboxY);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  // Wash：把 Uint8 buffer 转 RGBA canvas（color × α）。用于 endStroke 合成 + live overlay。
  _renderWashToCanvas(targetCanvas = null) {
    const st = this._stroke;
    if (!st || !st.bufferData) return null;
    const w = st.bufBboxW, h = st.bufBboxH;
    let canvas = targetCanvas;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
    } else if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const cctx = canvas.getContext("2d");
    const out = cctx.createImageData(w, h);
    const color = st.mode === "erase" ? { r: 0, g: 0, b: 0 } : hexToRgbObj(st.settings.color);
    const buf = st.bufferData;
    const n = buf.length;
    const r = color.r, g = color.g, b = color.b;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = buf[i];
    }
    cctx.putImageData(out, 0, 0);
    return canvas;
  }
  // board 每帧调；返回 {canvas, bboxX/Y/W/H, layer, opacity, mode}。
  // opacity 是 user.opacity（Π 外那一层）；board 渲染时会 globalAlpha *= opacity
  getLiveOverlay() {
    const st = this._stroke;
    if (!st) return null;
    let canvas;
    if (st.isBuildup) {
      if (!st.bufferCanvas) return null;
      canvas = st.bufferCanvas;
    } else {
      if (!st.bufferData) return null;
      if (!st.overlayCanvas) {
        st.overlayCanvas = document.createElement("canvas");
        st.overlayCanvas.width = st.bufBboxW;
        st.overlayCanvas.height = st.bufBboxH;
        st.overlayDirty = true;
      }
      if (st.overlayDirty) {
        this._renderWashToCanvas(st.overlayCanvas);
        st.overlayDirty = false;
      }
      canvas = st.overlayCanvas;
    }
    return {
      canvas,
      bboxX: st.bufBboxX,
      bboxY: st.bufBboxY,
      bboxW: st.bufBboxW,
      bboxH: st.bufBboxH,
      layer: st.layer,
      opacity: Math.max(0, Math.min(1, st.settings.opacity ?? 1)),
      mode: st.mode
    };
  }
  flushDirty() {
    const st = this._stroke;
    if (!st || !st.dirty) return null;
    const d = st.dirty;
    st.dirty = null;
    return d;
  }
  _sampleLayerColor(layer, x, y) {
    const ix = Math.floor(x - layer.bboxX);
    const iy = Math.floor(y - layer.bboxY);
    if (ix < 0 || iy < 0 || ix >= layer.bboxW || iy >= layer.bboxH) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    try {
      const d = layer.ctx.getImageData(ix, iy, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    } catch (_) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
  }
  _stampOne(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    let p = Math.max(0, Math.min(1, pressure));
    if (s.taperIn > 0) {
      const taperLen = s.size * s.taperIn;
      const t = Math.min(1, st.strokeDist / taperLen);
      const env = s.taperFloor + (1 - s.taperFloor) * t;
      p *= env;
    }
    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1));
    const sizeMul = signedLerp(s.sizeCoeff || 0, pCurve);
    const flowMul = signedLerp(s.flowCoeff || 0, pCurve);
    const opaMul = signedLerp(s.opaCoeff || 0, pCurve);
    const size = Math.max(0.5, s.size * sizeMul);
    const effFlow = Math.max(0, Math.min(1, s.flow * flowMul));
    const stampAlpha = effFlow * opaMul;
    if (stampAlpha < 1e-3) return;
    const radius = size / 2;
    const x0 = x - radius - 1;
    const y0 = y - radius - 1;
    const x1 = x + radius + 1;
    const y1 = y + radius + 1;
    st.layer.ensureBbox(x0, y0, x1, y1);
    if (st.mode === "smudge" && st.loaded) {
      this._smudgeStampDirect(x, y, size, stampAlpha);
      this._markDirty(x0, y0, x1, y1);
      return;
    }
    if (s.pixelMode) {
      this._pixelStampDirect(x, y, size, stampAlpha);
      this._markDirty(x0, y0, x1, y1);
      return;
    }
    this._ensureBufferBbox(x0, y0, x1, y1);
    if (st.isBuildup) {
      this._stampToBufferBuildup(x, y, size, stampAlpha);
    } else {
      this._stampToBufferWash(x, y, size, stampAlpha);
      st.overlayDirty = true;
    }
    this._markDirty(x0, y0, x1, y1);
  }
  // Build-Up: Canvas2D 原生 source-over。drawImage cached colored stamp，globalAlpha = stamp_α
  _stampToBufferBuildup(x, y, size, stampAlpha) {
    const st = this._stroke;
    const s = st.settings;
    const stamp = this._getStamp(s.size, s.hardness, s.color, st.mode);
    const drawD = size + 2 * (size / stamp.baseSize);
    const drawR = drawD / 2;
    const lx = x - st.bufBboxX;
    const ly = y - st.bufBboxY;
    const ctx = st.bufferCtx;
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = stampAlpha;
    ctx.globalCompositeOperation = "source-over";
    const useEllipse = s.shapeKind === "ellipse" && (s.shapeAspect !== 1 || s.shapeRotation !== 0);
    if (useEllipse) {
      ctx.save();
      ctx.translate(lx, ly);
      if (s.shapeRotation) ctx.rotate(s.shapeRotation);
      if (s.shapeAspect !== 1) ctx.scale(1, s.shapeAspect);
      ctx.drawImage(stamp.canvas, -drawR, -drawR, drawD, drawD);
      ctx.restore();
    } else {
      ctx.drawImage(stamp.canvas, lx - drawR, ly - drawR, drawD, drawD);
    }
    ctx.globalAlpha = prevA;
  }
  // Wash: JS per-pixel max blend，shape α 解析公式 (round / ellipse)
  _stampToBufferWash(x, y, size, stampAlpha) {
    const st = this._stroke;
    const s = st.settings;
    const buf = st.bufferData;
    const bufW = st.bufBboxW;
    const bufH = st.bufBboxH;
    const cx = x - st.bufBboxX;
    const cy = y - st.bufBboxY;
    const radius = size / 2;
    const hardness = Math.max(0, Math.min(0.999, s.hardness));
    const innerR = hardness * radius;
    const decayLen = radius - innerR;
    const stampA255 = stampAlpha * 255;
    const useEllipse = s.shapeKind === "ellipse" && (s.shapeAspect !== 1 || s.shapeRotation !== 0);
    const cosR = useEllipse ? Math.cos(s.shapeRotation) : 1;
    const sinR = useEllipse ? Math.sin(s.shapeRotation) : 0;
    const invAspect = useEllipse ? 1 / Math.max(0.01, s.shapeAspect) : 1;
    const px0 = Math.max(0, Math.floor(cx - radius));
    const py0 = Math.max(0, Math.floor(cy - radius));
    const px1 = Math.min(bufW, Math.ceil(cx + radius));
    const py1 = Math.min(bufH, Math.ceil(cy + radius));
    for (let py = py0; py < py1; py++) {
      const dy = py + 0.5 - cy;
      const rowOff = py * bufW;
      for (let px = px0; px < px1; px++) {
        const dx = px + 0.5 - cx;
        let dist;
        if (useEllipse) {
          const dxR = cosR * dx + sinR * dy;
          const dyR = (-sinR * dx + cosR * dy) * invAspect;
          dist = Math.sqrt(dxR * dxR + dyR * dyR);
        } else {
          dist = Math.sqrt(dx * dx + dy * dy);
        }
        if (dist >= radius) continue;
        let shapeA;
        if (decayLen === 0 || dist <= innerR) shapeA = 1;
        else {
          const u = (dist - innerR) / decayLen;
          shapeA = 1 - u * u * (3 - 2 * u);
        }
        const dabA = stampA255 * shapeA;
        const idx = rowOff + px;
        if (dabA > buf[idx]) buf[idx] = dabA;
      }
    }
  }
  _smudgeStampDirect(x, y, size, stampAlpha) {
    const st = this._stroke;
    const s = st.settings;
    const cur = this._sampleLayerColor(st.layer, x, y);
    const strength = s.smudgeStrength ?? 0.8;
    const dryness = s.smudgeDryness ?? 0.1;
    const outCol = {
      r: st.loaded.r * strength + cur.r * (1 - strength),
      g: st.loaded.g * strength + cur.g * (1 - strength),
      b: st.loaded.b * strength + cur.b * (1 - strength),
      a: Math.max(st.loaded.a, cur.a)
    };
    const hex = "#" + [outCol.r, outCol.g, outCol.b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");
    st.loaded = {
      r: st.loaded.r * (1 - dryness) + cur.r * dryness,
      g: st.loaded.g * (1 - dryness) + cur.g * dryness,
      b: st.loaded.b * (1 - dryness) + cur.b * dryness,
      a: st.loaded.a * (1 - dryness) + cur.a * dryness
    };
    const stamp = makeRadialStamp(size, s.hardness, hex);
    const drawD = stamp.size;
    const drawR = drawD / 2;
    const layer = st.layer;
    const ctx = layer.ctx;
    const lx = x - layer.bboxX;
    const ly = y - layer.bboxY;
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = stampAlpha * Math.max(0, Math.min(1, s.opacity ?? 1));
    ctx.drawImage(stamp.canvas, lx - drawR, ly - drawR, drawD, drawD);
    ctx.globalAlpha = prevA;
  }
  _pixelStampDirect(x, y, size, stampAlpha) {
    const st = this._stroke;
    const s = st.settings;
    const layer = st.layer;
    const ctx = layer.ctx;
    const lx = x - layer.bboxX;
    const ly = y - layer.bboxY;
    const intSize = Math.max(1, Math.round(size));
    const ix = Math.floor(lx - (intSize - 1) / 2);
    const iy = Math.floor(ly - (intSize - 1) / 2);
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = stampAlpha * Math.max(0, Math.min(1, s.opacity ?? 1));
    ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";
    ctx.fillStyle = st.mode === "erase" ? "#000" : s.color || "#000";
    ctx.imageSmoothingEnabled = false;
    ctx.fillRect(ix, iy, intSize, intSize);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  _markDirty(x0, y0, x1, y1) {
    const st = this._stroke;
    const d = st.dirty;
    if (d) {
      if (x0 < d[0]) d[0] = x0;
      if (y0 < d[1]) d[1] = y0;
      if (x1 > d[2]) d[2] = x1;
      if (y1 > d[3]) d[3] = y1;
    } else {
      st.dirty = [x0, y0, x1, y1];
    }
  }
};
function makeRadialStamp(size, hardness, color) {
  const d = Math.max(4, Math.ceil(size + 2));
  const r = d / 2;
  const c = document.createElement("canvas");
  c.width = d;
  c.height = d;
  const cx = c.getContext("2d");
  const hd = Math.max(0, Math.min(0.999, hardness));
  const g = cx.createRadialGradient(r, r, hd * r, r, r, r);
  g.addColorStop(0, color);
  g.addColorStop(1, hexToRgba(color, 0));
  cx.fillStyle = g;
  cx.fillRect(0, 0, d, d);
  return { canvas: c, size: d };
}
function hexToRgbObj(hex) {
  if (!hex || hex[0] !== "#") return { r: 0, g: 0, b: 0 };
  if (hex.length === 7) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[1] + hex[1], 16),
      g: parseInt(hex[2] + hex[2], 16),
      b: parseInt(hex[3] + hex[3], 16)
    };
  }
  return { r: 0, g: 0, b: 0 };
}
function hexToRgba(hex, a = 1) {
  const c = hexToRgbObj(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

// src/liquify.js
var LiquifyEngine = class {
  constructor() {
    this._stroke = null;
  }
  beginStroke(layer, settings, x, y) {
    const lbW = Math.max(1, layer.bboxW);
    const lbH = Math.max(1, layer.bboxH);
    this._stroke = {
      layer,
      settings,
      lastX: x,
      lastY: y,
      dirty: null,
      // startSnap = layer 当前像素的快照（笔触全程只读源头）
      startSnap: layer.snapshot(),
      // dispField 和 layer bbox 对齐；空层 bbox=0 时占位 1×1 全 0
      dispField: {
        bboxX: layer.bboxX,
        bboxY: layer.bboxY,
        bboxW: lbW,
        bboxH: lbH,
        data: new Float32Array(2 * lbW * lbH)
      }
    };
  }
  // 每个 event 一次。x, y 已经是 input.js 处理过的 doc 坐标。
  extendStroke(x, y) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    const R = Math.max(2, s.size);
    const strength = Math.max(0, Math.min(2, s.strength));
    const cx = x, cy = y;
    const layer = st.layer;
    const fx0 = Math.floor(cx - R), fy0 = Math.floor(cy - R);
    const fx1 = Math.ceil(cx + R), fy1 = Math.ceil(cy + R);
    layer.ensureBbox(fx0, fy0, fx1, fy1);
    if (layer.bboxW <= 0 || layer.bboxH <= 0) {
      st.lastX = x;
      st.lastY = y;
      return;
    }
    this._syncDispFieldToLayer();
    const lbX = layer.bboxX, lbY = layer.bboxY;
    const lbW = layer.bboxW, lbH = layer.bboxH;
    const x0 = Math.max(lbX, fx0);
    const y0 = Math.max(lbY, fy0);
    const x1 = Math.min(lbX + lbW, fx1);
    const y1 = Math.min(lbY + lbH, fy1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) {
      st.lastX = x;
      st.lastY = y;
      return;
    }
    const vx = x - st.lastX;
    const vy = y - st.lastY;
    const mode = s.mode;
    const R2 = R * R;
    const f = st.dispField;
    const fdata = f.data;
    const fw = f.bboxW;
    const fbX = f.bboxX, fbY = f.bboxY;
    const ss = st.startSnap;
    const ssX = ss.bboxX, ssY = ss.bboxY;
    const ssW = ss.bboxW, ssH = ss.bboxH;
    const ssData = ss.imageData ? ss.imageData.data : null;
    const dst = new ImageData(w, h);
    const ddat = dst.data;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const wx = x0 + px, wy = y0 + py;
        const dxc = wx - cx, dyc = wy - cy;
        const r2 = dxc * dxc + dyc * dyc;
        const fIdx = ((wy - fbY) * fw + (wx - fbX)) * 2;
        if (r2 < R2) {
          const r = Math.sqrt(r2);
          const t = 1 - r / R;
          const ff = t * t * (3 - 2 * t);
          if (mode === "reconstruct") {
            const alpha = Math.min(1, ff * strength);
            fdata[fIdx] *= 1 - alpha;
            fdata[fIdx + 1] *= 1 - alpha;
          } else {
            let ddx, ddy;
            switch (mode) {
              case "pinch":
                ddx = -dxc * ff * strength;
                ddy = -dyc * ff * strength;
                break;
              case "bloat":
                ddx = dxc * ff * strength;
                ddy = dyc * ff * strength;
                break;
              case "twirl":
                ddx = -dyc * ff * strength;
                ddy = dxc * ff * strength;
                break;
              case "push":
              default:
                ddx = vx * ff * strength;
                ddy = vy * ff * strength;
            }
            fdata[fIdx] += ddx;
            fdata[fIdx + 1] += ddy;
          }
        }
        const tdx = fdata[fIdx];
        const tdy = fdata[fIdx + 1];
        const idx = (py * w + px) * 4;
        if (ssData) {
          const sx = wx - tdx - ssX;
          const sy = wy - tdy - ssY;
          bilinearSample2(ssData, ssW, ssH, sx, sy, ddat, idx);
        }
      }
    }
    layer.ctx.putImageData(dst, x0 - lbX, y0 - lbY);
    if (st.dirty) {
      if (x0 < st.dirty[0]) st.dirty[0] = x0;
      if (y0 < st.dirty[1]) st.dirty[1] = y0;
      if (x1 > st.dirty[2]) st.dirty[2] = x1;
      if (y1 > st.dirty[3]) st.dirty[3] = y1;
    } else {
      st.dirty = [x0, y0, x1, y1];
    }
    st.lastX = x;
    st.lastY = y;
  }
  endStroke() {
    this._stroke = null;
  }
  cancelStroke() {
    this._stroke = null;
  }
  flushDirty() {
    const st = this._stroke;
    if (!st || !st.dirty) return null;
    const d = st.dirty;
    st.dirty = null;
    return d;
  }
  // dispField 必须始终 = layer bbox（resample 时按 layer 像素位置查）
  _syncDispFieldToLayer() {
    const st = this._stroke;
    const f = st.dispField;
    const layer = st.layer;
    if (f.bboxX === layer.bboxX && f.bboxY === layer.bboxY && f.bboxW === layer.bboxW && f.bboxH === layer.bboxH) return;
    const nx = layer.bboxX, ny = layer.bboxY;
    const nw = layer.bboxW, nh = layer.bboxH;
    const newData = new Float32Array(2 * nw * nh);
    if (f.bboxW > 0 && f.bboxH > 0) {
      const dx = f.bboxX - nx;
      const dy = f.bboxY - ny;
      for (let yy = 0; yy < f.bboxH; yy++) {
        const srcOff = yy * f.bboxW * 2;
        const dstOff = ((yy + dy) * nw + dx) * 2;
        newData.set(f.data.subarray(srcOff, srcOff + f.bboxW * 2), dstOff);
      }
    }
    st.dispField = {
      bboxX: nx,
      bboxY: ny,
      bboxW: nw,
      bboxH: nh,
      data: newData
    };
  }
};
function bilinearSample2(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const x0 = ix, x1 = ix + 1;
  const y0 = iy, y1 = iy + 1;
  const p00 = x0 >= 0 && x0 < w && y0 >= 0 && y0 < h ? (y0 * w + x0) * 4 : -1;
  const p10 = x1 >= 0 && x1 < w && y0 >= 0 && y0 < h ? (y0 * w + x1) * 4 : -1;
  const p01 = x0 >= 0 && x0 < w && y1 >= 0 && y1 < h ? (y1 * w + x0) * 4 : -1;
  const p11 = x1 >= 0 && x1 < w && y1 >= 0 && y1 < h ? (y1 * w + x1) * 4 : -1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 4; c++) {
    let v = 0;
    if (p00 >= 0) v += sdat[p00 + c] * w00;
    if (p10 >= 0) v += sdat[p10 + c] * w10;
    if (p01 >= 0) v += sdat[p01 + c] * w01;
    if (p11 >= 0) v += sdat[p11 + c] * w11;
    ddat[dstIdx + c] = v;
  }
}

// src/shapes.js
var ShapesEngine = class {
  constructor() {
    this._subtool = "rect";
    this._equalAspect = false;
    this._alignAxis = false;
    this._state = null;
  }
  setSubtool(s) {
    if (s === "rect" || s === "ellipse" || s === "line") this._subtool = s;
  }
  getSubtool() {
    return this._subtool;
  }
  setEqualAspect(v) {
    this._equalAspect = !!v;
  }
  getEqualAspect() {
    return this._equalAspect;
  }
  setAlignAxis(v) {
    this._alignAxis = !!v;
  }
  getAlignAxis() {
    return this._alignAxis;
  }
  isActive() {
    return !!this._state;
  }
  // begin：起点 + 当前 layer
  begin(layer, x, y) {
    this._state = { layer, x0: x, y0: y, x1: x, y1: y };
  }
  // extend：更新终点，按 modifier 修正
  extend(x, y) {
    const st = this._state;
    if (!st) return;
    let nx = x, ny = y;
    if (this._equalAspect && (this._subtool === "rect" || this._subtool === "ellipse")) {
      const dx = x - st.x0, dy = y - st.y0;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      nx = st.x0 + (dx >= 0 ? m : -m);
      ny = st.y0 + (dy >= 0 ? m : -m);
    } else if (this._alignAxis && this._subtool === "line") {
      const dx = x - st.x0, dy = y - st.y0;
      if (Math.abs(dx) >= Math.abs(dy)) ny = st.y0;
      else nx = st.x0;
    }
    st.x1 = nx;
    st.y1 = ny;
  }
  // end：在 layer 上 commit。返回 doc-rect 给 dirty
  end({ color, size, selection }) {
    const st = this._state;
    if (!st) return null;
    const { layer, x0, y0, x1, y1 } = st;
    this._state = null;
    let bbox;
    if (this._subtool === "rect") {
      const x = Math.min(x0, x1), y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (w < 1 || h < 1) return null;
      bbox = [x, y, x + w, y + h];
      layer.ensureBbox(...bbox);
      const ctx = layer.ctx;
      ctx.save();
      this._maybeClipSelection(ctx, layer, selection);
      ctx.fillStyle = color;
      ctx.fillRect(x - layer.bboxX, y - layer.bboxY, w, h);
      ctx.restore();
    } else if (this._subtool === "ellipse") {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      if (rx < 1 || ry < 1) return null;
      bbox = [cx - rx, cy - ry, cx + rx, cy + ry];
      layer.ensureBbox(...bbox);
      const ctx = layer.ctx;
      ctx.save();
      this._maybeClipSelection(ctx, layer, selection);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(cx - layer.bboxX, cy - layer.bboxY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (this._subtool === "line") {
      const lw = Math.max(1, size);
      const minX = Math.min(x0, x1) - lw, maxX = Math.max(x0, x1) + lw;
      const minY = Math.min(y0, y1) - lw, maxY = Math.max(y0, y1) + lw;
      bbox = [minX, minY, maxX, maxY];
      layer.ensureBbox(...bbox);
      const ctx = layer.ctx;
      ctx.save();
      this._maybeClipSelection(ctx, layer, selection);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x0 - layer.bboxX, y0 - layer.bboxY);
      ctx.lineTo(x1 - layer.bboxX, y1 - layer.bboxY);
      ctx.stroke();
      ctx.restore();
    }
    return bbox;
  }
  cancel() {
    this._state = null;
  }
  // 给 board 用来 preview
  getPreview() {
    return this._state ? { subtool: this._subtool, ...this._state } : null;
  }
  getState() {
    return this._state;
  }
  resetState() {
    this._state = null;
  }
  // 受 doc.selection 限制（user 要求：直线吃选区）
  _maybeClipSelection(ctx, layer, selection) {
    if (!selection) return;
  }
};

// src/input.js
var TAP_MAX_DURATION = 220;
var TAP_MAX_MOVE = 16;
var DOUBLETAP_WINDOW = 500;
var DOUBLETAP_MAX_GAP = 80;
var RAW_STATIC_SCREEN_SQ = 5e-3;
var PRESSURE_SMOOTH_ALPHA = 0.4;
var GESTURE_TAP_MAX_MS = 250;
var GESTURE_TAP_MAX_MOVE_SQ = 256;
var LONG_PRESS_MS = 450;
var LONG_PRESS_CANCEL_SQ = 64;
var InputController = class {
  constructor(board2, doc2, opts = {}) {
    this.board = board2;
    this.doc = doc2;
    this.canvas = board2.canvas;
    this.brush = new BrushEngine();
    this.shapes = new ShapesEngine();
    this.liquify = new LiquifyEngine();
    this.lasso = new LassoEngine();
    this.lasso.onChange = () => {
      this.board.requestRender();
      window.dispatchEvent(new CustomEvent("wp:lassochange"));
    };
    this.getTool = opts.getTool || (() => "brush");
    this.getBrushSettings = opts.getBrushSettings || (() => null);
    this.getLiquifySettings = opts.getLiquifySettings || (() => ({ mode: "push", size: 50, strength: 0.5 }));
    this.getLongPressPickEnabled = opts.getLongPressPickEnabled || (() => false);
    this.onColorSampled = opts.onColorSampled || (() => {
    });
    this.status = opts.status || (() => {
    });
    this.pointers = /* @__PURE__ */ new Map();
    this.penEverSeen = false;
    this.spaceDown = false;
    this.altDown = false;
    this.gestureStart = null;
    this._gestureTap = null;
    this._lastTap = null;
    this.history = opts.history || null;
    if (this.history) {
      this.history.registerHandler("stroke", {
        undo: (e) => applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board),
        redo: (e) => applyPixelSnap(this.doc, e.layerId, e.after, e.afterBlob, this.board),
        refsLayer: (e, id) => e.layerId === id
      });
      this.history.registerHandler("liquify", {
        undo: (e) => applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board),
        redo: (e) => applyPixelSnap(this.doc, e.layerId, e.after, e.afterBlob, this.board),
        refsLayer: (e, id) => e.layerId === id
      });
      this.history.registerHandler("lasso", {
        undo: (e) => {
          applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board);
          if (e.prevSelection !== void 0) {
            this.doc.selection = e.prevSelection;
            this.board.invalidateAll();
          }
        },
        redo: (e) => {
          applyPixelSnap(this.doc, e.layerId, e.after, e.afterBlob, this.board);
          if (e.prevSelection !== void 0) {
            this.doc.selection = null;
            this.board.invalidateAll();
          }
        },
        refsLayer: (e, id) => e.layerId === id
      });
      this.history.registerHandler("selectionChange", {
        undo: (e) => {
          this.doc.selection = e.before;
          this.board.invalidateAll();
        },
        redo: (e) => {
          this.doc.selection = e.after;
          this.board.invalidateAll();
        },
        // 选区不属于某一 layer；refsLayer 永远 false（删图层不影响选区 entry）
        refsLayer: () => false
      });
    }
    this.lasso.setDoc(this.doc);
    this._bind();
  }
  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e, true));
    c.addEventListener("pointerleave", (e) => this._up(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this._keydown(e));
    window.addEventListener("keyup", (e) => this._keyup(e));
  }
  // -- pen tip hover preview（iPad Pro M2+ 有 pen hover；mouse 模式也利用）
  _updateCursorPreview(e) {
    const tool = this.getTool();
    if (tool === "hand") {
      this.board.setCursor(null);
      return;
    }
    let size;
    if (tool === "liquify") {
      const q = this.getLiquifySettings();
      size = q && q.size ? q.size * 2 : 100;
    } else {
      const settings = this.getBrushSettings();
      size = settings ? settings.size : 12;
    }
    this.board.setCursor({ x: e.clientX, y: e.clientY, size });
  }
  _down(e) {
    this._purgeStalePointers();
    if (e.pointerType === "pen") {
      this._purgeAllTouches();
      this.penEverSeen = true;
      this._lastTap = null;
    }
    this.canvas.setPointerCapture?.(e.pointerId);
    const tool = this.getTool();
    const effectiveTool = this.altDown && tool === "brush" ? "picker" : tool;
    const x = e.clientX, y = e.clientY;
    const penDrawing = [...this.pointers.values()].some(
      (p) => p.pointerType === "pen" && (p.role === "draw" || p.role === "erase")
    );
    if (e.pointerType === "touch" && penDrawing) {
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "ignore", x, y, lastUpdateTs: performance.now() });
      e.preventDefault();
      return;
    }
    const activeTouches = [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore"
    );
    if (e.pointerType === "touch" && activeTouches.length >= 1) {
      for (const [, p] of this.pointers) {
        if (p.longPressTimer) {
          clearTimeout(p.longPressTimer);
          p.longPressTimer = null;
        }
      }
      for (const [pid, p] of this.pointers) {
        if (p.role === "draw" || p.role === "erase") {
          this._abortStroke();
        } else if (p.role === "liquify") {
          this._abortLiquify();
        } else if (p.role === "lasso") {
          this._abortLasso();
        }
        if (p.pointerType === "touch" && p.role !== "ignore") {
          p.role = "gesture";
        }
      }
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "gesture", x, y, startX: x, startY: y, downTime: performance.now(), lastUpdateTs: performance.now() });
      this._beginGesture();
      this._updateGestureTapSnapshot();
      e.preventDefault();
      return;
    }
    let role = null;
    if (tool === "hand" || this.spaceDown) {
      role = "pan";
    } else if (e.pointerType === "mouse") {
      if (e.button === 0) role = effectiveTool === "eraser" ? "erase" : effectiveTool === "picker" ? "pick" : effectiveTool === "liquify" ? "liquify" : effectiveTool === "lasso" ? "lasso" : effectiveTool === "smudge" ? "draw" : "draw";
      else role = "pan";
    } else if (e.pointerType === "pen") {
      if (e.button === 2 || e.buttons & 2) role = "erase";
      else if (effectiveTool === "picker") role = "pick";
      else if (effectiveTool === "eraser") role = "erase";
      else if (effectiveTool === "liquify") role = "liquify";
      else if (effectiveTool === "lasso") role = "lasso";
      else if (effectiveTool === "smudge") role = "draw";
      else role = "draw";
    } else if (e.pointerType === "touch") {
      if (this.penEverSeen) {
        role = "pan";
      } else {
        if (effectiveTool === "picker") role = "pick";
        else if (effectiveTool === "eraser") role = "erase";
        else if (effectiveTool === "liquify") role = "liquify";
        else if (effectiveTool === "lasso") role = "lasso";
        else if (effectiveTool === "smudge") role = "draw";
        else role = "draw";
      }
    }
    const now = performance.now();
    const rec = {
      pointerType: e.pointerType,
      role,
      x,
      y,
      startX: x,
      startY: y,
      smX: x,
      smY: y,
      downTime: now,
      lastUpdateTs: now
    };
    this.pointers.set(e.pointerId, rec);
    if (role === "draw" || role === "erase" || role === "liquify") {
      this.board.setCursor(null);
      rec.lastRawX = x;
      rec.lastRawY = y;
      rec.lastP = null;
      rec.smP = -1;
      rec.lastEventTs = -Infinity;
      rec.stabBuf = [];
      rec.pullX = x;
      rec.pullY = y;
      rec.lastDirX = 0;
      rec.lastDirY = 0;
      rec.filtX = x;
      rec.filtY = y;
      if (role === "liquify") this._beginLiquify(rec);
      else {
        const tool2 = this.getTool();
        const mode = role === "erase" ? "erase" : tool2 === "smudge" ? "smudge" : "brush";
        this._beginStroke(e, rec, mode);
      }
    } else if (role === "lasso") {
      this.board.setCursor(null);
      this._beginLasso(rec);
    } else if (role === "shapes") {
      this.board.setCursor(null);
      this._beginShapes(rec);
    } else if (role === "pick") {
      this._doPick(x, y);
    } else if (role === "pan") {
      document.body.dataset.panning = "1";
    }
    const wantLongPress = e.pointerType === "touch" && tool !== "hand" && (role === "draw" || role === "erase" || role === "pan") && this.getLongPressPickEnabled();
    if (wantLongPress) {
      rec.longPressTimer = setTimeout(() => {
        rec.longPressTimer = null;
        if (rec.role === "draw" || rec.role === "erase") {
          this._abortStroke();
        } else if (rec.role === "pan") {
          if (![...this.pointers.values()].some((p) => p !== rec && p.role === "pan")) {
            delete document.body.dataset.panning;
          }
        }
        rec.role = "pick";
        this._doPick(rec.x, rec.y);
        this.status("\u5438\u8272\uFF08\u957F\u6309\uFF09");
      }, LONG_PRESS_MS);
    }
    e.preventDefault();
  }
  _move(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) {
      if (e.pointerType !== "touch") this._updateCursorPreview(e);
      return;
    }
    rec.x = e.clientX;
    rec.y = e.clientY;
    rec.lastUpdateTs = performance.now();
    if (rec.longPressTimer) {
      const dx = e.clientX - rec.startX;
      const dy = e.clientY - rec.startY;
      if (dx * dx + dy * dy > LONG_PRESS_CANCEL_SQ) {
        clearTimeout(rec.longPressTimer);
        rec.longPressTimer = null;
      }
    }
    if (this.gestureStart) {
      this._updateGesture();
      if (this._gestureTap && this._gestureTap.isTap) {
        for (const [pid, p] of this.pointers) {
          if (p.role !== "gesture") continue;
          const start = this._gestureTap.startPositions[pid];
          if (!start) continue;
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          if (dx * dx + dy * dy > GESTURE_TAP_MAX_MOVE_SQ) {
            this._gestureTap.isTap = false;
            break;
          }
        }
      }
      e.preventDefault();
      return;
    }
    if (rec.role === "draw" || rec.role === "erase" || rec.role === "liquify") {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      let list = events && events.length ? events : [e];
      if (rec.role === "liquify" && list.length > 1) list = [list[list.length - 1]];
      const settings = rec.role === "liquify" ? null : this.getBrushSettings();
      for (const ev of list) {
        if (ev.timeStamp <= rec.lastEventTs) continue;
        rec.lastEventTs = ev.timeStamp;
        const drx = ev.clientX - rec.lastRawX;
        const dry = ev.clientY - rec.lastRawY;
        rec.lastRawX = ev.clientX;
        rec.lastRawY = ev.clientY;
        if (drx * drx + dry * dry < RAW_STATIC_SCREEN_SQ) continue;
        const sl = settings?.streamline ?? 0;
        const stab = settings?.stabilization ?? 0;
        const pull = settings?.pullStabilizer ?? 0;
        const mf = settings?.motionFilter ?? 0;
        let fdx = drx, fdy = dry;
        if (mf > 0) {
          const nLen = Math.hypot(fdx, fdy);
          const oLen = Math.hypot(rec.lastDirX, rec.lastDirY);
          if (nLen > 0 && oLen > 0) {
            const dot = (fdx * rec.lastDirX + fdy * rec.lastDirY) / (nLen * oLen);
            const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
            const maxAng = (1 - mf) * Math.PI;
            if (ang > maxAng && maxAng > 1e-3) {
              const cross = fdx * rec.lastDirY - fdy * rec.lastDirX;
              const sign = cross < 0 ? 1 : -1;
              const ca = Math.cos(maxAng), sa = sign * Math.sin(maxAng);
              const ux = rec.lastDirX / oLen, uy = rec.lastDirY / oLen;
              fdx = (ux * ca - uy * sa) * nLen;
              fdy = (ux * sa + uy * ca) * nLen;
            }
          }
        }
        rec.lastDirX = fdx;
        rec.lastDirY = fdy;
        rec.filtX += fdx;
        rec.filtY += fdy;
        let rx = rec.filtX, ry = rec.filtY;
        let sx = rx, sy = ry;
        if (stab > 0) {
          const cap = 1 + Math.round(stab * 16);
          rec.stabBuf.push([rx, ry]);
          if (rec.stabBuf.length > cap) rec.stabBuf.shift();
          let mx = 0, my = 0;
          for (const p of rec.stabBuf) {
            mx += p[0];
            my += p[1];
          }
          sx = mx / rec.stabBuf.length;
          sy = my / rec.stabBuf.length;
        } else if (rec.stabBuf.length) {
          rec.stabBuf.length = 0;
        }
        if (pull > 0) {
          const maxStep = Math.max(0.5, (1 - pull) * 64);
          const ddx = sx - rec.pullX, ddy = sy - rec.pullY;
          const d = Math.hypot(ddx, ddy);
          if (d > maxStep) {
            rec.pullX += ddx * maxStep / d;
            rec.pullY += ddy * maxStep / d;
          } else {
            rec.pullX = sx;
            rec.pullY = sy;
          }
        } else {
          rec.pullX = sx;
          rec.pullY = sy;
        }
        const alphaPos = Math.max(0.05, 1 - sl);
        rec.smX = rec.smX + alphaPos * (rec.pullX - rec.smX);
        rec.smY = rec.smY + alphaPos * (rec.pullY - rec.smY);
        const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
        if (rec.role === "liquify") {
          this.liquify.extendStroke(dx, dy);
        } else {
          const pressure = effectivePressureFor(rec, ev);
          this.brush.extendStroke(dx, dy, pressure);
        }
      }
      const bbox = rec.role === "liquify" ? this.liquify.flushDirty() : this.brush.flushDirty();
      if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
      this.board.requestRender();
    } else if (rec.role === "lasso") {
      const { x: dx, y: dy } = this.board.screenToDoc(e.clientX, e.clientY);
      if (rec._lassoMode === "tentative") {
        if (this.lasso.getSubTool() === "magic") return;
        const ddx = dx - rec._lassoStartDocX;
        const ddy = dy - rec._lassoStartDocY;
        if (ddx * ddx + ddy * ddy > 4) {
          rec._lassoMode = "drawing";
          this.lasso.beginPath(rec._lassoStartDocX, rec._lassoStartDocY);
          this.lasso.extendPath(dx, dy);
        }
      } else if (rec._lassoMode === "drawing") {
        this.lasso.extendPath(dx, dy);
      } else if (rec._lassoMode === "transform") {
        this.lasso.extendDrag(dx, dy);
        const bb = this.lasso.getFloatingScreenBbox();
        if (bb) this.board.markDocDirty(bb[0], bb[1], bb[2], bb[3]);
        this.board.requestRender();
      }
    } else if (rec.role === "shapes") {
      const { x: dx, y: dy } = this.board.screenToDoc(e.clientX, e.clientY);
      this.shapes.extend(dx, dy);
      this.board.invalidateAll();
      this.board.requestRender();
    } else if (rec.role === "pick") {
      this._doPick(e.clientX, e.clientY);
    } else if (rec.role === "pan") {
      const dx = e.movementX || e.clientX - (rec._lastX ?? e.clientX);
      const dy = e.movementY || e.clientY - (rec._lastY ?? e.clientY);
      rec._lastX = e.clientX;
      rec._lastY = e.clientY;
      this.board.pan(dx, dy);
    }
    e.preventDefault();
  }
  _up(e, cancelled = false) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    rec.x = e.clientX;
    rec.y = e.clientY;
    if (rec.longPressTimer) {
      clearTimeout(rec.longPressTimer);
      rec.longPressTimer = null;
    }
    if (rec.role === "gesture") {
      const remaining = this._gestureTouches().length;
      if (remaining < 2) {
        this._endGesture();
        if (remaining === 0 && this._gestureTap) {
          const tap = this._gestureTap;
          this._gestureTap = null;
          const elapsed = performance.now() - tap.startTime;
          if (tap.isTap && elapsed < GESTURE_TAP_MAX_MS) {
            if (tap.maxCount === 2) {
              this.undo();
              this.status("\u53CC\u6307 \xB7 \u64A4\u9500");
            } else if (tap.maxCount >= 3) {
              this.redo();
              this.status("\u4E09\u6307 \xB7 \u91CD\u505A");
            }
          }
        }
      } else {
        this._beginGesture();
      }
      return;
    }
    const tapEligible = !cancelled && rec.downTime && e.pointerType === "touch" && this.penEverSeen && rec.role !== "gesture" && rec.role !== "ignore";
    if (tapEligible) {
      const now = performance.now();
      const dur = now - rec.downTime;
      const dist = Math.hypot(rec.x - rec.startX, rec.y - rec.startY);
      const isTap = dur < TAP_MAX_DURATION && dist < TAP_MAX_MOVE;
      if (isTap) {
        const lt = this._lastTap;
        const isDouble = lt && now - lt.time < DOUBLETAP_WINDOW && Math.hypot(rec.startX - lt.x, rec.startY - lt.y) < DOUBLETAP_MAX_GAP;
        if (isDouble) {
          this._lastTap = null;
          window.dispatchEvent(new CustomEvent("wp:doubletap"));
          return;
        }
        this._lastTap = { time: now, x: rec.startX, y: rec.startY };
      } else {
        this._lastTap = null;
      }
    }
    if (rec.role === "draw" || rec.role === "erase") {
      if (cancelled) this._abortStroke();
      else this._endStroke();
    } else if (rec.role === "liquify") {
      if (cancelled) this._abortLiquify();
      else this._endLiquify();
    } else if (rec.role === "lasso") {
      if (cancelled) this._abortLasso();
      else this._endLasso(rec);
    } else if (rec.role === "shapes") {
      if (cancelled) this.shapes.cancel();
      else this._endShapes();
    } else if (rec.role === "pan") {
      if (![...this.pointers.values()].some((p) => p.role === "pan")) {
        delete document.body.dataset.panning;
      }
    }
  }
  // ---- 笔画 ----
  // 笔触 = 一个 "stroke" type 的 history entry。endStroke 时 push。
  // entry shape：{ type: "stroke", layerId, before, after, beforeBlob, afterBlob }
  // - before/after = Layer.snapshot()（bboxX/Y/W/H + imageData）
  // - blob 字段 push 后异步 toBlob 填，填好后释放 imageData
  // 详见 docs/undo-architecture.md。
  _beginStroke(e, rec, mode) {
    const settings = this.getBrushSettings();
    if (!settings || !this.doc.activeLayer) return;
    const layer = this.doc.activeLayer;
    this._strokeLayerId = layer.id;
    this._strokePreSnap = layer.snapshot();
    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    const pressure = effectivePressureFor(rec, e);
    this.brush.beginStroke(layer, settings, dx, dy, pressure, mode);
    const bbox = this.brush.flushDirty();
    if (bbox) this.board.markDocDirty(bbox[0], bbox[1], bbox[2], bbox[3]);
    this.board.requestRender();
  }
  _endStroke() {
    this.brush.endStroke();
    if (this._strokeLayerId == null) return;
    const layer = this.doc.layers.find((l) => l.id === this._strokeLayerId);
    const preSnap = this._strokePreSnap;
    this._strokeLayerId = null;
    this._strokePreSnap = null;
    if (!layer || !preSnap) return;
    if (this.doc.selection) {
      applySelectionMaskPostStroke(layer, preSnap, this.doc.selection);
      this.board.invalidateAll();
    }
    const postSnap = layer.snapshot();
    const entry = {
      type: "stroke",
      layerId: layer.id,
      before: preSnap,
      after: postSnap,
      beforeBlob: null,
      afterBlob: null
    };
    if (this.history) this.history.push(entry);
    this.board.requestRender();
    compressPixelSnap(entry.before, (blob) => {
      entry.beforeBlob = blob;
    });
    compressPixelSnap(entry.after, (blob) => {
      entry.afterBlob = blob;
    });
  }
  _abortStroke() {
    this.brush.cancelStroke();
    if (this._strokeLayerId != null && this._strokePreSnap) {
      const layer = this.doc.layers.find((l) => l.id === this._strokeLayerId);
      if (layer) layer.restoreFromSnapshot(this._strokePreSnap);
      this.board.invalidateAll();
    }
    this._strokeLayerId = null;
    this._strokePreSnap = null;
  }
  // ---- 液化 ----
  // 一次"按-拖-抬"= 一个 "liquify" history entry。schema 同 stroke。
  _beginLiquify(rec) {
    const settings = this.getLiquifySettings();
    if (!settings || !this.doc.activeLayer) {
      rec.role = null;
      return;
    }
    const layer = this.doc.activeLayer;
    this._liquifyLayerId = layer.id;
    this._liquifyPreSnap = layer.snapshot();
    const { x: dx, y: dy } = this.board.screenToDoc(rec.smX, rec.smY);
    this.liquify.beginStroke(layer, settings, dx, dy);
    this.board.requestRender();
  }
  _endLiquify() {
    this.liquify.endStroke();
    if (this._liquifyLayerId == null) return;
    const layer = this.doc.layers.find((l) => l.id === this._liquifyLayerId);
    const preSnap = this._liquifyPreSnap;
    this._liquifyLayerId = null;
    this._liquifyPreSnap = null;
    if (!layer || !preSnap) return;
    if (this.doc.selection) {
      applySelectionMaskPostStroke(layer, preSnap, this.doc.selection);
      this.board.invalidateAll();
    }
    const postSnap = layer.snapshot();
    const entry = {
      type: "liquify",
      layerId: layer.id,
      before: preSnap,
      after: postSnap,
      beforeBlob: null,
      afterBlob: null
    };
    if (this.history) this.history.push(entry);
    this.board.requestRender();
    compressPixelSnap(entry.before, (blob) => {
      entry.beforeBlob = blob;
    });
    compressPixelSnap(entry.after, (blob) => {
      entry.afterBlob = blob;
    });
  }
  _abortLiquify() {
    this.liquify.cancelStroke();
    if (this._liquifyLayerId != null && this._liquifyPreSnap) {
      const layer = this.doc.layers.find((l) => l.id === this._liquifyLayerId);
      if (layer) layer.restoreFromSnapshot(this._liquifyPreSnap);
      this.board.invalidateAll();
    }
    this._liquifyLayerId = null;
    this._liquifyPreSnap = null;
  }
  // ---- 套索 ----（v65 重构：lasso 只编辑选区 doc.selection；变换是显式按钮）
  //   floating 状态（transform 中）：hit-test handle / 内部拖；空白无操作（必须走应用/取消）
  //   非 floating：pointerdown 进 tentative；超阈值后按 subTool 分支：
  //     freehand → drawing-freehand
  //     rect     → drawing-rect
  //     magic    → magic-tentative（pointerup 时立即 flood fill）
  // ---- shapes ----
  _beginShapes(rec) {
    if (!this.doc.activeLayer) {
      rec.role = null;
      return;
    }
    const { x, y } = this.board.screenToDoc(rec.x, rec.y);
    this.shapes.begin(this.doc.activeLayer, x, y);
  }
  _endShapes() {
    const layer = this.doc.activeLayer;
    if (!layer) return;
    const settings = this.getBrushSettings();
    const before = layer.snapshot();
    try {
      const subtool = this.shapes.getSubtool();
      if (subtool === "line" && this.shapes.getState()) {
        const st = this.shapes.getState();
        this.brush.beginStroke(layer, settings, st.x0, st.y0, 1, "brush");
        this.brush.extendStroke(st.x1, st.y1, 1);
        this.brush.endStroke();
        this.shapes.resetState();
      } else {
        const bbox = this.shapes.end({
          color: settings && settings.color || "#000",
          size: settings && settings.size || 4,
          selection: this.doc.selection
        });
        if (!bbox) return;
      }
      const after = layer.snapshot();
      if (this.history) {
        const entry = {
          type: "stroke",
          layerId: layer.id,
          before,
          after,
          beforeBlob: null,
          afterBlob: null
        };
        this.history.push(entry);
        compressPixelSnap(before, (blob) => {
          entry.beforeBlob = blob;
        });
        compressPixelSnap(after, (blob) => {
          entry.afterBlob = blob;
        });
      }
      this.board.invalidateAll();
    } catch (e) {
      console.error("[shapes]", e);
      this.status("\u5F62\u72B6\u51FA\u9519\uFF1A" + (e.message || e));
    }
  }
  _beginLasso(rec) {
    if (!this.doc.activeLayer) {
      rec.role = null;
      return;
    }
    const { x: dx, y: dy } = this.board.screenToDoc(rec.x, rec.y);
    if (this.lasso.state() === "floating") {
      const hit = this.lasso.hitTest(dx, dy, this.board.viewport.scale);
      if (hit) {
        rec._lassoMode = "transform";
        this.lasso.beginDrag(hit, dx, dy);
        return;
      }
      rec.role = null;
      return;
    }
    rec._lassoMode = "tentative";
    rec._lassoStartDocX = dx;
    rec._lassoStartDocY = dy;
  }
  _endLasso(rec) {
    if (rec._lassoMode === "drawing") {
      try {
        const entry = this.lasso.endPath(this.doc.getFloodSourceLayer());
        if (entry) {
          if (this.history) this.history.push(entry);
          this.board.invalidateAll();
        } else {
          this.lasso.cancelDrawing();
        }
      } catch (e) {
        console.error("[lasso end]", e);
        this.status("\u9009\u533A\u64CD\u4F5C\u51FA\u9519\uFF1A" + (e.message || e));
        this.lasso.cancelDrawing();
      }
    } else if (rec._lassoMode === "transform") {
      this.lasso.endDrag();
    } else if (rec._lassoMode === "tentative") {
      if (this.lasso.getSubTool() === "magic") {
        try {
          const { x: dx, y: dy } = this.board.screenToDoc(rec.x, rec.y);
          this.lasso.beginPath(dx, dy);
          const entry = this.lasso.endPath(this.doc.getFloodSourceLayer());
          if (entry) {
            if (this.history) this.history.push(entry);
            this.board.invalidateAll();
          } else {
            this.status("\u9B54\u672F\u68D2\uFF1Atap \u5728\u7EBF / \u8FB9\u754C\u4E0A\uFF0C\u6CA1\u9009\u5230");
          }
        } catch (e) {
          console.error("[magic-wand]", e);
          this.status("\u9B54\u672F\u68D2\u51FA\u9519\uFF1A" + (e.message || e));
        }
      }
    }
  }
  _commitLasso() {
    const entry = this.lasso.commit();
    if (!entry) return;
    if (this.history) this.history.push(entry);
    this.board.invalidateAll();
    compressPixelSnap(entry.before, (blob) => {
      entry.beforeBlob = blob;
    });
    compressPixelSnap(entry.after, (blob) => {
      entry.afterBlob = blob;
    });
  }
  _abortLasso() {
    if (this.lasso.state() === "floating") {
      this.lasso.cancel();
      this.board.invalidateAll();
    } else {
      this.lasso.cancelDrawing();
    }
  }
  // 给外部（tool 切换、Esc）用：commit 当前 floating（如果有）。
  commitLassoIfFloating() {
    if (this.lasso.state() === "floating") this._commitLasso();
  }
  // ---- 吸色 ----
  _doPick(sx, sy) {
    const { x: dx, y: dy } = this.board.screenToDoc(sx, sy);
    const ix = Math.floor(dx), iy = Math.floor(dy);
    if (!this.doc.activeLayer) return;
    if (ix < 0 || iy < 0 || ix >= this.doc.width || iy >= this.doc.height) return;
    let r = 0, g = 0, b = 0, a = 0;
    const bg = parseHex(this.doc.backgroundColor || "#ffffff");
    r = bg.r;
    g = bg.g;
    b = bg.b;
    a = 1;
    for (const layer of this.doc.layers) {
      if (!layer.visible) continue;
      const px = layer.sampleAt(ix, iy);
      const la = px[3] / 255 * layer.opacity;
      if (la <= 0) continue;
      const inv = 1 - la;
      r = px[0] * la + r * inv;
      g = px[1] * la + g * inv;
      b = px[2] * la + b * inv;
      a = la + a * inv;
    }
    const hex = "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    this.onColorSampled(hex);
    this.status(`\u5438\u8272 ${hex}`);
  }
  // ---- gesture ----
  _gestureTouches() {
    return [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore"
    );
  }
  // 进 / 升级 gesture 时刷一遍 tap 快照
  _updateGestureTapSnapshot() {
    const touches = this._gestureTouches();
    if (!this._gestureTap) {
      this._gestureTap = {
        startTime: performance.now(),
        isTap: true,
        maxCount: 0,
        startPositions: {}
      };
    }
    for (const [pid, p] of this.pointers) {
      if (p.role === "gesture" && !(pid in this._gestureTap.startPositions)) {
        this._gestureTap.startPositions[pid] = { x: p.x, y: p.y };
      }
    }
    if (touches.length > this._gestureTap.maxCount) {
      this._gestureTap.maxCount = touches.length;
    }
  }
  _beginGesture() {
    const t = this._gestureTouches();
    if (t.length < 2) return;
    const [a, b] = t;
    const dx = b.x - a.x, dy = b.y - a.y;
    this.gestureStart = {
      dist: Math.hypot(dx, dy) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      angle: Math.atan2(dy, dx),
      // 起手两指连线角度
      vp: { ...this.board.viewport }
    };
    document.body.dataset.panning = "1";
  }
  _updateGesture() {
    const t = this._gestureTouches();
    if (t.length < 2 || !this.gestureStart) return;
    const [a, b] = t;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const angle = Math.atan2(dy, dx);
    const g = this.gestureStart;
    const k = dist / g.dist;
    let newScale = g.vp.scale * k;
    newScale = Math.max(this.board.minScale, Math.min(this.board.maxScale, newScale));
    let dRot = angle - g.angle;
    if (dRot > Math.PI) dRot -= 2 * Math.PI;
    if (dRot < -Math.PI) dRot += 2 * Math.PI;
    let newRot = g.vp.rot + dRot;
    const W = this.board.doc.width, H = this.board.doc.height;
    const startDocCenterX = g.vp.tx + W * g.vp.scale / 2;
    const startDocCenterY = g.vp.ty + H * g.vp.scale / 2;
    const sdx = g.midX - startDocCenterX, sdy = g.midY - startDocCenterY;
    const sc = Math.cos(-g.vp.rot), ss = Math.sin(-g.vp.rot);
    const dpX = (sdx * sc - sdy * ss) / g.vp.scale + W / 2;
    const dpY = (sdx * ss + sdy * sc) / g.vp.scale + H / 2;
    const c = Math.cos(newRot), s = Math.sin(newRot);
    const rx = (dpX - W / 2) * newScale;
    const ry = (dpY - H / 2) * newScale;
    const newCx = midX - (rx * c - ry * s);
    const newCy = midY - (rx * s + ry * c);
    const newTx = newCx - W * newScale / 2;
    const newTy = newCy - H * newScale / 2;
    this.board.setViewport(newTx, newTy, newScale, newRot);
  }
  _endGesture() {
    this.gestureStart = null;
    delete document.body.dataset.panning;
    const SNAP_DEG = 5;
    const snapStep = Math.PI / 2;
    const cur = this.board.viewport.rot;
    const n = Math.round(cur / snapStep);
    const snapped = n * snapStep;
    if (cur !== snapped && Math.abs(cur - snapped) < SNAP_DEG * Math.PI / 180) {
      const W = this.board.doc.width, H = this.board.doc.height;
      const vp = this.board.viewport;
      const cxScreen = vp.tx + W * vp.scale / 2;
      const cyScreen = vp.ty + H * vp.scale / 2;
      this.board.setViewport(
        cxScreen - W * vp.scale / 2,
        cyScreen - H * vp.scale / 2,
        vp.scale,
        snapped
      );
    }
  }
  // ---- wheel ----
  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const dy = e.deltaY;
      let factor;
      if (Math.abs(dy) >= 50) {
        const step = Math.sign(dy);
        factor = Math.exp(-step * 0.1);
      } else {
        factor = Math.exp(-dy * 5e-3);
      }
      this.board.zoomAt(e.clientX, e.clientY, factor);
    } else {
      let dx = -e.deltaX, dy = -e.deltaY;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      this.board.pan(dx, dy);
    }
  }
  // ---- 键盘 ----
  _keydown(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.code === "Space" && !this.spaceDown) {
      this.spaceDown = true;
      document.body.dataset.spacePan = "1";
      e.preventDefault();
      return;
    }
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      this.altDown = true;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ") {
      if (e.shiftKey) this.redo();
      else this.undo();
      e.preventDefault();
      return;
    }
    if (ctrl && e.code === "KeyY") {
      this.redo();
      e.preventDefault();
      return;
    }
    if (e.key === "b" || e.key === "B") this._emitTool("brush");
    else if (e.key === "e" || e.key === "E") this._emitTool("eraser");
    else if (e.key === "i" || e.key === "I") this._emitTool("picker");
    else if (e.key === "h" || e.key === "H") this._emitTool("hand");
    else if (e.key === "l" || e.key === "L") this._emitTool("lasso");
    else if (e.key === "Enter" && this.lasso.state() === "floating") {
      this._commitLasso();
      e.preventDefault();
    } else if (e.key === "Escape" && this.lasso.state() === "floating") {
      this._abortLasso();
      e.preventDefault();
    } else if (e.key === "Escape" && this.lasso.hasSelection() && this.lasso.state() === "idle") {
      const entry = this.lasso.setSelection(null);
      if (entry && this.history) this.history.push(entry);
      this.board.invalidateAll();
      e.preventDefault();
    } else if (e.key === "0") this.board.fitToScreen();
    else if (e.key === "=" || e.key === "+") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2);
    else if (e.key === "-" || e.key === "_") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2);
    else if (e.key === "[") this._adjustSize(-2);
    else if (e.key === "]") this._adjustSize(2);
  }
  _keyup(e) {
    if (e.code === "Space") {
      this.spaceDown = false;
      delete document.body.dataset.spacePan;
    }
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      this.altDown = false;
    }
  }
  _emitTool(tool) {
    window.dispatchEvent(new CustomEvent("wp:settool", { detail: tool }));
  }
  _adjustSize(delta) {
    window.dispatchEvent(new CustomEvent("wp:adjsize", { detail: delta }));
  }
  // undo / redo / canUndo / canRedo 现在都走共享 history（v44 起）。
  // 留这几个 wrapper 给绑了快捷键 / 老 listener 用，**不**自己保存状态。
  canUndo() {
    if (this.lasso.hasFloating()) return true;
    return !!this.history && this.history.canUndo();
  }
  canRedo() {
    if (this.lasso.hasFloating()) return false;
    return !!this.history && this.history.canRedo();
  }
  // floating 状态下 undo = 取消变换（user 反馈：transform 时撤销应是 cancel 语义）
  // redo 在 floating 下被禁；切回去 history 自然续上
  undo() {
    if (this.lasso.hasFloating()) {
      this._abortLasso();
      this.status?.("\u5DF2\u53D6\u6D88\u53D8\u6362");
      return;
    }
    if (this.history) this.history.undo();
  }
  redo() {
    if (this.lasso.hasFloating()) return;
    if (this.history) this.history.redo();
  }
  clearHistory() {
    if (this.history) this.history.clear();
  }
  // ---- 防误触 / ghost pointer 清理 ----
  // iOS 在 PalmRejection / 系统 gesture 抢断 / 应用切换时偶尔不发 pointerup。
  // ghost pointer 留在 map 里会让单指 → 误判为双指 gesture，画布一直转。
  // user 反馈 2026-05-28：长画时容易遇到。
  _purgeStalePointers() {
    const now = performance.now();
    const STALE_MS = 1500;
    const stale = [];
    for (const [pid, p] of this.pointers) {
      if (p.lastUpdateTs != null && now - p.lastUpdateTs > STALE_MS) {
        stale.push(pid);
      }
    }
    for (const pid of stale) this._discardPointer(pid);
    if (stale.length) this._maybeEndGesture();
  }
  // 笔尖落下时把所有 touch 当掌触清掉（含可能没收 up 的 ghost）
  _purgeAllTouches() {
    const dead = [];
    for (const [pid, p] of this.pointers) {
      if (p.pointerType === "touch") dead.push(pid);
    }
    for (const pid of dead) this._discardPointer(pid);
    if (dead.length) this._maybeEndGesture();
  }
  _discardPointer(pid) {
    const p = this.pointers.get(pid);
    if (!p) return;
    if (p.longPressTimer) {
      clearTimeout(p.longPressTimer);
      p.longPressTimer = null;
    }
    if (p.role === "draw" || p.role === "erase") this._abortStroke();
    else if (p.role === "liquify") this._abortLiquify();
    else if (p.role === "lasso") this._abortLasso();
    try {
      this.canvas.releasePointerCapture?.(pid);
    } catch {
    }
    this.pointers.delete(pid);
  }
  _maybeEndGesture() {
    if (this.gestureStart && this._gestureTouches().length < 2) {
      this._endGesture();
    }
  }
  // v111: blanket reset 用于 iPad PWA 系统手势抢断 / 双击误触 window drag 后
  //       app.js 全局监听 window pointercancel / visibilitychange / blur 都调它
  cancelAllPointers() {
    const all = [...this.pointers.keys()];
    for (const pid of all) this._discardPointer(pid);
    this._maybeEndGesture();
  }
};
function compressPixelSnap(snap, onBlob) {
  if (!snap || !snap.imageData) {
    onBlob(null);
    return;
  }
  if (snap.bboxW <= 0 || snap.bboxH <= 0) {
    snap.imageData = null;
    onBlob(null);
    return;
  }
  const c = document.createElement("canvas");
  c.width = snap.bboxW;
  c.height = snap.bboxH;
  c.getContext("2d").putImageData(snap.imageData, 0, 0);
  c.toBlob((blob) => {
    if (!blob) {
      onBlob(null);
      return;
    }
    snap.imageData = null;
    onBlob(blob);
  }, "image/png");
}
function applyPixelSnap(doc2, layerId, snap, blob, board2) {
  const layer = doc2.layers.find((l) => l.id === layerId);
  if (!layer) return Promise.resolve();
  if (snap && snap.imageData) {
    layer.restoreFromSnapshot(snap);
    board2?.invalidateAll();
    return Promise.resolve();
  }
  if (!blob) {
    if (snap) layer.restoreFromSnapshot({ ...snap, imageData: null });
    board2?.invalidateAll();
    return Promise.resolve();
  }
  return createImageBitmap(blob).then((bitmap) => {
    layer.restoreFromSnapshot({ ...snap, bitmap });
    bitmap.close?.();
    board2?.invalidateAll();
  });
}
function effectivePressureFor(rec, ev) {
  let raw;
  if (ev.pointerType === "mouse") {
    raw = 0.5;
  } else {
    const r = typeof ev.pressure === "number" ? ev.pressure : null;
    if (r == null || r === 0) {
      raw = rec.lastP != null ? rec.lastP : 0.2;
    } else {
      raw = Math.max(0.05, Math.min(1, r));
      rec.lastP = raw;
    }
  }
  if (rec.smP < 0) rec.smP = raw;
  else rec.smP += PRESSURE_SMOOTH_ALPHA * (raw - rec.smP);
  return rec.smP;
}
function parseHex(hex) {
  if (!hex || hex[0] !== "#") return { r: 255, g: 255, b: 255 };
  if (hex.length === 7) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[1] + hex[1], 16),
      g: parseInt(hex[2] + hex[2], 16),
      b: parseInt(hex[3] + hex[3], 16)
    };
  }
  return { r: 255, g: 255, b: 255 };
}

// src/default-brushes.json
var default_brushes_default = [
  {
    id: "default-brush-pencil",
    name: "\u94C5\u7B14",
    tool: "brush",
    args: {
      size: 6,
      sizeBaseMax: 80,
      hardness: 0.75,
      sizeCoeff: 0.5,
      opaCoeff: 0.35,
      flowCoeff: 0.3,
      spacingValue: 0.06,
      compositeMode: "wash"
    }
  },
  {
    id: "default-brush-ink",
    name: "\u52FE\u7EBF",
    tool: "brush",
    args: {
      size: 8,
      sizeBaseMax: 60,
      hardness: 0.5,
      sizeCoeff: 0.8,
      opaCoeff: 0,
      flowCoeff: 0,
      pressureLPF: 100,
      spacingValue: 0.06,
      compositeMode: "wash",
      taperIn: 0.3,
      taperOut: 0.3,
      streamline: 0.8,
      stabilization: 0.75,
      motionFilter: 0.2
    }
  },
  {
    id: "default-brush-fill",
    name: "\u5E73\u6D82",
    tool: "brush",
    args: {
      size: 50,
      sizeBaseMax: 800,
      hardness: 0.9,
      sizeCoeff: 1,
      opaCoeff: 0,
      flowCoeff: 0,
      pressureGamma: 1.2,
      pressureLPF: 100,
      spacingValue: 0.06,
      compositeMode: "wash",
      taperIn: 0.3,
      taperOut: 0.3,
      stabilization: 0.1,
      motionFilter: 0.1
    }
  },
  {
    id: "default-airbrush-big",
    name: "\u5927\u55B7\u67AA",
    tool: "brush",
    args: {
      size: 300,
      sizeBaseMax: 800,
      hardness: 0,
      sizeCoeff: 0,
      opaCoeff: 0,
      flowCoeff: 1,
      spacingValue: 0.1,
      compositeMode: "buildup"
    }
  },
  {
    id: "default-airbrush-small",
    name: "\u5C0F\u55B7\u67AA",
    tool: "brush",
    args: {
      size: 32,
      sizeBaseMax: 200,
      hardness: 0.15,
      sizeCoeff: 0.4,
      opaCoeff: 0,
      flowCoeff: 1,
      spacingValue: 0.1,
      compositeMode: "buildup"
    }
  },
  {
    id: "default-smudge-soft",
    name: "\u6D82\u62B9",
    tool: "smudge",
    args: {
      size: 16,
      sizeBaseMax: 80,
      hardness: 0.6,
      sizeCoeff: 0.2,
      opaCoeff: 0,
      flowCoeff: 1,
      spacingValue: 0.06,
      compositeMode: "buildup",
      smudge: { strength: 0.8, dryness: 0.1 }
    }
  },
  {
    id: "default-eraser-hard",
    name: "\u786C\u6A61\u76AE",
    tool: "eraser",
    args: {
      size: 50,
      sizeBaseMax: 100,
      hardness: 0.75,
      sizeCoeff: 0.8,
      opaCoeff: 0,
      flowCoeff: 0,
      pressureLPF: 100,
      spacingValue: 0.04,
      compositeMode: "wash",
      stabilization: 0.15,
      motionFilter: 0.05
    }
  },
  {
    id: "default-eraser-soft",
    name: "\u8F6F\u6A61\u76AE",
    tool: "eraser",
    args: {
      size: 125,
      sizeBaseMax: 800,
      hardness: 0,
      sizeCoeff: 0,
      opaCoeff: 0,
      flowCoeff: 1,
      spacingValue: 0.1,
      compositeMode: "buildup"
    }
  },
  {
    id: "default-brush-pixel",
    name: "\u50CF\u7D20\u7B14",
    tool: "brush",
    args: {
      size: 1,
      sizeBaseMax: 64,
      hardness: 1,
      sizeCoeff: 0,
      opaCoeff: 0,
      flowCoeff: 0,
      spacingValue: 0.5,
      compositeMode: "wash",
      pixelMode: true,
      streamline: 0
    }
  }
];

// src/brushes.js
var RACK_VERSION = 1;
var DEFAULT_FOLDER = "\u6211\u7684\u5E38\u7528";
function newBrushId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "b-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function makeBrush({
  id = newBrushId(),
  name,
  tool,
  folder = DEFAULT_FOLDER,
  size = 12,
  sizeBaseMax = 200,
  sizeCoeff = 0.6,
  opaCoeff = 0.6,
  flowCoeff = 0,
  pressureGamma = 1,
  // v102+: pressure low-pass filter（ms，时间域 IIR）
  // 解 "勾线转角顿一下 out-leg 变细" —— LPF 让落点过去几十毫秒的高 pressure 仍留尾巴
  pressureLPF = 0,
  compositeMode = "wash",
  shapeKind = "round",
  aspect = 1,
  rotation = 0,
  hardness = 1,
  textureB64 = null,
  spacingValue = 0.06,
  pixelMode = false,
  taperIn = 0,
  taperOut = 0,
  smudge = null,
  // 位置平滑（per-brush，v99 起从 system 挪进 preset）
  streamline = 0.3,
  stabilization = 0,
  pullStabilizer = 0,
  motionFilter = 0,
  // v99r2：defaultOpa 留着，默认 1.0；user 编辑笔可以改成 0.6 当 sketch 默认
  defaultOpa = 1
}) {
  return {
    id,
    name,
    tool,
    folder,
    shape: { kind: shapeKind, aspect, rotation, hardness, textureB64 },
    size: { base: size, max: sizeBaseMax },
    sizeCoeff,
    opaCoeff,
    flowCoeff,
    pressureGamma,
    pressureLPF,
    defaultOpa,
    compositeMode,
    spacing: spacingValue,
    pixelMode,
    taper: { in: taperIn, out: taperOut },
    smudge,
    smooth: { streamline, stabilization, pullStabilizer, motionFilter }
  };
}
function migrateBrush(b) {
  if (!b) return b;
  if (b.spacing && typeof b.spacing === "object") {
    b.spacing = b.spacing.kind === "time" ? 0.05 : b.spacing.value || 0.06;
  }
  if (b.sizeCoeff == null) {
    const sm = b.size?.min;
    if (sm != null) b.sizeCoeff = Math.max(-1, Math.min(1, 1 - sm));
    else {
      const pc = b.size?.pressureCurve;
      b.sizeCoeff = pc == null || pc > 0 ? 0.6 : 0;
    }
  }
  if (b.size) {
    delete b.size.min;
    delete b.size.pressureCurve;
  }
  if (b.flowCoeff == null) {
    const fm = b.flow?.min;
    if (fm != null) b.flowCoeff = Math.max(-1, Math.min(1, 1 - fm));
    else {
      const pc = b.flow?.pressureCurve;
      b.flowCoeff = pc != null && pc > 0 ? 1 : 0;
    }
  }
  delete b.flow;
  if (b.opaCoeff == null) {
    b.opaCoeff = b.airbrush ? 0 : 0.6;
  }
  delete b.opacity;
  if (b.defaultOpa == null) b.defaultOpa = 1;
  delete b.defaultFlow;
  if (b.pressureGamma == null) b.pressureGamma = 1;
  if (b.pressureLPF == null) b.pressureLPF = 0;
  delete b.flowScale;
  delete b.spacingFlowMul;
  if (b.compositeMode == null) {
    b.compositeMode = b.airbrush ? "buildup" : "wash";
  }
  delete b.airbrush;
  delete b.bufferMode;
  if (!b.smooth) {
    b.smooth = { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 };
  }
  return b;
}
function specToBrush(spec) {
  return makeBrush({ id: spec.id, name: spec.name, tool: spec.tool, ...spec.args });
}
function makeDefaultRack() {
  const brushes = default_brushes_default.map(specToBrush);
  const activeByTool = {};
  for (const b of brushes) {
    if (!activeByTool[b.tool]) activeByTool[b.tool] = b.id;
  }
  return { version: RACK_VERSION, brushes, activeByTool };
}
function mergeMissingDefaults(rack) {
  if (!rack || !Array.isArray(rack.brushes)) return false;
  const ids = new Set(rack.brushes.map((b) => b.id));
  let changed = false;
  for (const spec of default_brushes_default) {
    if (!ids.has(spec.id)) {
      rack.brushes.push(specToBrush(spec));
      changed = true;
    }
  }
  if (!rack.activeByTool) {
    rack.activeByTool = {};
    changed = true;
  }
  for (const spec of default_brushes_default) {
    if (!rack.activeByTool[spec.tool]) {
      rack.activeByTool[spec.tool] = spec.id;
      changed = true;
    }
  }
  return changed;
}
function brushToJSON(brush) {
  return JSON.stringify(brush, null, 2);
}
function brushFromJSON(text) {
  const obj = JSON.parse(text);
  if (!obj.id || !obj.name || !obj.tool) throw new Error("brush JSON \u7F3A\u5FC5\u586B\u5B57\u6BB5");
  obj.id = newBrushId();
  migrateBrush(obj);
  return obj;
}
function findBrush(rack, id) {
  return rack.brushes.find((b) => b.id === id) || null;
}
var BRUSH_GROUP = ["brush", "airbrush", "shapes"];
function brushesByTool(rack, tool) {
  if (tool === "brush") {
    return rack.brushes.filter((b) => BRUSH_GROUP.includes(b.tool));
  }
  return rack.brushes.filter((b) => b.tool === tool);
}
function getActiveBrush(rack, tool) {
  const id = rack.activeByTool?.[tool];
  return id ? findBrush(rack, id) : null;
}

// src/panel-state.js
var handlers = /* @__PURE__ */ new Map();
var currentOpen = null;
var listeners = /* @__PURE__ */ new Set();
var PANELS = {
  RACK_BRUSH: "rack-brush",
  RACK_SMUDGE: "rack-smudge",
  RACK_ERASER: "rack-eraser",
  RACK_SHAPES: "rack-shapes",
  RACK_AIRBRUSH: "rack-airbrush",
  LAYERS: "layers",
  BRUSH_SETTINGS: "brush-settings",
  ADJUST: "adjust",
  MENU: "menu"
};
function registerPanel(id, { show, hide }) {
  handlers.set(id, { show, hide });
}
function openExclusive(id) {
  if (currentOpen === id) {
    closeExclusive();
    return;
  }
  if (currentOpen) {
    const h2 = handlers.get(currentOpen);
    if (h2?.hide) h2.hide();
  }
  currentOpen = id;
  const h = handlers.get(id);
  if (h?.show) h.show();
  notifyListeners();
}
function closeExclusive() {
  if (!currentOpen) return;
  const h = handlers.get(currentOpen);
  if (h?.hide) h.hide();
  currentOpen = null;
  notifyListeners();
}
function getCurrentExclusive() {
  return currentOpen;
}
function notifyListeners() {
  for (const l of listeners) {
    try {
      l(currentOpen);
    } catch (e) {
      console.warn("[panel-state] listener err:", e);
    }
  }
}

// src/storage.js
var DB_NAME = "webpaint";
var DB_VERSION = 2;
var STORE_SESSIONS = "sessions";
var STORE_META = "meta";
var _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}
async function getSession(id = "current") {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function putSession(id, pkg) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).put(pkg, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function deleteSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function listSessionIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readonly");
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function setMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// src/history.js
var UndoStack = class {
  constructor({ max = 50 } = {}) {
    this.entries = [];
    this.index = -1;
    this.max = max;
    this.handlers = /* @__PURE__ */ new Map();
  }
  registerHandler(type, handler) {
    if (!handler || typeof handler.undo !== "function" || typeof handler.redo !== "function") {
      throw new Error(`UndoStack handler for "${type}" must have undo + redo`);
    }
    this.handlers.set(type, handler);
  }
  canUndo() {
    return this.index >= 0;
  }
  canRedo() {
    return this.index < this.entries.length - 1;
  }
  // 把一条新 entry 入栈（也代表"已经发生过"——push 前 caller 已经把效果应用到 doc 了）。
  // truncate redo segment（如果之前 undo 过然后又有新动作）。dispose 被裁掉的 entry。
  push(entry) {
    if (!entry || typeof entry.type !== "string") {
      throw new Error("UndoStack.push: entry must have type:string");
    }
    if (this.index < this.entries.length - 1) {
      const dropped = this.entries.splice(this.index + 1);
      for (const e of dropped) this._dispose(e);
    }
    this.entries.push(entry);
    this.index++;
    while (this.entries.length > this.max) {
      const evicted = this.entries.shift();
      this._dispose(evicted);
      this.index--;
    }
    this._emit();
  }
  async undo() {
    if (!this.canUndo()) return;
    const e = this.entries[this.index];
    this.index--;
    const h = this.handlers.get(e.type);
    if (h) {
      try {
        await h.undo(e);
      } catch (err) {
        console.warn(`[history] undo handler "${e.type}" failed:`, err);
      }
    } else {
      console.warn(`[history] no handler for "${e.type}"`);
    }
    this._emit();
  }
  async redo() {
    if (!this.canRedo()) return;
    this.index++;
    const e = this.entries[this.index];
    const h = this.handlers.get(e.type);
    if (h) {
      try {
        await h.redo(e);
      } catch (err) {
        console.warn(`[history] redo handler "${e.type}" failed:`, err);
      }
    } else {
      console.warn(`[history] no handler for "${e.type}"`);
    }
    this._emit();
  }
  clear() {
    for (const e of this.entries) this._dispose(e);
    this.entries.length = 0;
    this.index = -1;
    this._emit();
  }
  _dispose(entry) {
    const h = this.handlers.get(entry.type);
    if (h && typeof h.dispose === "function") {
      try {
        h.dispose(entry);
      } catch (err) {
        console.warn(`[history] dispose failed:`, err);
      }
    }
  }
  _emit() {
    window.dispatchEvent(new CustomEvent("wp:histchange", {
      detail: { canUndo: this.canUndo(), canRedo: this.canRedo() }
    }));
  }
};

// src/reference.js
var LS_POS = "webpaint.refPanel.pos";
var LS_VP = "webpaint.refPanel.vp";
var ReferenceWindow = class {
  constructor(opts) {
    this.panel = opts.panel;
    this.head = opts.head;
    this.body = opts.body;
    this.canvas = opts.canvas;
    this.closeBtn = opts.closeBtn;
    this.emptyHint = opts.emptyHint;
    this.status = opts.status || (() => {
    });
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    this.bitmap = null;
    this._liveDoc = null;
    this._composeCanvas = null;
    this._liveDirty = false;
    this.vp = { tx: 0, ty: 0, scale: 1, rot: 0 };
    this._raf = null;
    this._panelDrag = null;
    this._resizeDrag = null;
    this._pointers = /* @__PURE__ */ new Map();
    this._gestureStart = null;
    this._bind();
    this._loadPos();
    this._loadVp();
  }
  // ---- 外部 API ----
  setBitmap(bitmap, opts = {}) {
    this._stopLive();
    if (this.bitmap && this.bitmap !== bitmap) this.bitmap.close?.();
    this.bitmap = bitmap;
    this._bitmapBlob = opts.persistBlob || null;
    if (bitmap) this.fitToPanel();
    this._updateEmptyHint();
    this._invalidate();
  }
  // 给 saveSession 用：拿当前静态 ref 的原始 Blob（live 模式返 null）
  getPersistBlob() {
    return this._liveDoc ? null : this._bitmapBlob;
  }
  // 没图时清空
  clearBitmap() {
    if (this.bitmap) this.bitmap.close?.();
    this.bitmap = null;
    this._bitmapBlob = null;
    this._updateEmptyHint();
    this._invalidate();
  }
  // 跟着 .ora 进 / 出 webpaint/state.json（painting-scoped 状态）。
  // 不带 panel 位置 / 大小（那是 device-scoped，留 localStorage）。
  getSerializedState() {
    return {
      open: this.isOpen(),
      viewport: { ...this.vp }
    };
  }
  applySerializedState(state2) {
    if (!state2 || typeof state2 !== "object") return;
    if (state2.viewport) {
      if (Number.isFinite(state2.viewport.tx)) this.vp.tx = state2.viewport.tx;
      if (Number.isFinite(state2.viewport.ty)) this.vp.ty = state2.viewport.ty;
      if (Number.isFinite(state2.viewport.scale)) this.vp.scale = state2.viewport.scale;
      if (Number.isFinite(state2.viewport.rot)) this.vp.rot = state2.viewport.rot;
    }
    if (state2.open) this.open();
    else this.close();
    this._invalidate();
  }
  // 实时镜像主画布：board.markDocDirty 触发 wp:docpixeldirty → markLiveDirty
  setLiveSource(doc2) {
    if (this.bitmap) {
      this.bitmap.close?.();
      this.bitmap = null;
    }
    this._liveDoc = doc2;
    if (!this._composeCanvas) this._composeCanvas = document.createElement("canvas");
    this._liveDirty = true;
    this.fitToPanel();
    this._updateEmptyHint();
    this._invalidate();
  }
  isLive() {
    return !!this._liveDoc;
  }
  toggleLive(doc2) {
    if (this.isLive()) {
      this._stopLive();
      this._updateEmptyHint();
      this._invalidate();
    } else {
      this.setLiveSource(doc2);
    }
  }
  _stopLive() {
    this._liveDoc = null;
    this._liveDirty = false;
  }
  // 外部（board.markDocDirty / wp:histchange）调用：标脏 + 触发渲染。
  // 真合成发生在 _render 里，且只在 _liveDirty=true 时合成。
  markLiveDirty() {
    if (!this._liveDoc) return;
    this._liveDirty = true;
    this._invalidate();
  }
  _recomposeLive() {
    const doc2 = this._liveDoc;
    if (!doc2) return;
    const W = doc2.width, H = doc2.height;
    if (this._composeCanvas.width !== W || this._composeCanvas.height !== H) {
      this._composeCanvas.width = W;
      this._composeCanvas.height = H;
    }
    const cx = this._composeCanvas.getContext("2d");
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = doc2.backgroundColor || "#ffffff";
    cx.fillRect(0, 0, W, H);
    for (const layer of doc2.layers) {
      if (!layer.visible) continue;
      if (!(layer.bboxW > 0 && layer.bboxH > 0)) continue;
      cx.globalAlpha = layer.opacity ?? 1;
      cx.globalCompositeOperation = layer.mode || "source-over";
      cx.drawImage(layer.canvas, layer.bboxX, layer.bboxY);
    }
    cx.globalAlpha = 1;
    cx.globalCompositeOperation = "source-over";
  }
  open() {
    this.panel.classList.remove("hidden");
    if (!this.panel.style.left || !this.panel.style.top) {
      const topbarH = 56;
      const sidebarW = 80;
      this.panel.style.left = sidebarW + 16 + "px";
      this.panel.style.top = topbarH + 24 + "px";
    }
    this._resizeCanvasToBody();
    this._updateEmptyHint();
    if (this._liveDoc) this._liveDirty = true;
    this._invalidate();
  }
  close() {
    this.panel.classList.add("hidden");
  }
  isOpen() {
    return !this.panel.classList.contains("hidden");
  }
  toggle() {
    this.isOpen() ? this.close() : this.open();
  }
  fitToPanel() {
    const src = this._sourceSize();
    if (!src) return;
    const bw = this.canvas.width / (window.devicePixelRatio || 1);
    const bh = this.canvas.height / (window.devicePixelRatio || 1);
    if (src.w <= 0 || src.h <= 0 || bw <= 0 || bh <= 0) return;
    const s = Math.min(bw / src.w, bh / src.h) * 0.95;
    this.vp = { tx: bw / 2, ty: bh / 2, scale: s, rot: 0 };
    this._saveVp();
    this._invalidate();
  }
  _sourceSize() {
    if (this._liveDoc) return { w: this._liveDoc.width, h: this._liveDoc.height };
    if (this.bitmap) return { w: this.bitmap.width, h: this.bitmap.height };
    return null;
  }
  // ---- 内部 ----
  _bind() {
    this.closeBtn.addEventListener("click", () => this.close());
    window.addEventListener("wp:docpixeldirty", () => this.markLiveDirty());
    window.addEventListener("wp:histchange", () => this.markLiveDirty());
    this.head.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".float-panel-close")) return;
      const r = this.panel.getBoundingClientRect();
      this._panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
      this.head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.head.addEventListener("pointermove", (e) => {
      if (!this._panelDrag || e.pointerId !== this._panelDrag.id) return;
      const w = this.panel.offsetWidth, h = this.panel.offsetHeight;
      const left = clamp2(this._panelDrag.ol + (e.clientX - this._panelDrag.sx), 0, window.innerWidth - w);
      const top = clamp2(this._panelDrag.ot + (e.clientY - this._panelDrag.sy), 0, window.innerHeight - h);
      this.panel.style.left = left + "px";
      this.panel.style.top = top + "px";
      this._savePos();
    });
    this.head.addEventListener("pointerup", (e) => {
      if (this._panelDrag && e.pointerId === this._panelDrag.id) {
        try {
          this.head.releasePointerCapture(e.pointerId);
        } catch {
        }
        this._panelDrag = null;
      }
    });
    this.canvas.addEventListener("pointerdown", (e) => this._onDown(e), { passive: false });
    this.canvas.addEventListener("pointermove", (e) => this._onMove(e), { passive: false });
    this.canvas.addEventListener("pointerup", (e) => this._onUp(e), { passive: false });
    this.canvas.addEventListener("pointercancel", (e) => this._onUp(e), { passive: false });
    this.canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener("dblclick", () => this.fitToPanel());
    const ro = new ResizeObserver(() => {
      this._resizeCanvasToBody();
      this._invalidate();
      this._savePos();
    });
    ro.observe(this.body);
  }
  _onDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) {
      const arr = [...this._pointers.values()];
      const dx = arr[1].x - arr[0].x, dy = arr[1].y - arr[0].y;
      this._gestureStart = {
        midX: (arr[0].x + arr[1].x) / 2,
        midY: (arr[0].y + arr[1].y) / 2,
        dist: Math.hypot(dx, dy) || 1,
        angle: Math.atan2(dy, dx),
        vp: { ...this.vp }
      };
    }
    e.preventDefault();
  }
  _onMove(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this._pointers.size === 1) {
      this.vp.tx += e.clientX - px;
      this.vp.ty += e.clientY - py;
      this._saveVp();
      this._invalidate();
    } else if (this._pointers.size >= 2 && this._gestureStart) {
      const arr = [...this._pointers.values()];
      const dx = arr[1].x - arr[0].x, dy = arr[1].y - arr[0].y;
      const dist = Math.hypot(dx, dy) || 1;
      const midX = (arr[0].x + arr[1].x) / 2;
      const midY = (arr[0].y + arr[1].y) / 2;
      const angle = Math.atan2(dy, dx);
      const g = this._gestureStart;
      const k = dist / g.dist;
      let dRot = angle - g.angle;
      if (dRot > Math.PI) dRot -= 2 * Math.PI;
      if (dRot < -Math.PI) dRot += 2 * Math.PI;
      const newScale = clamp2(g.vp.scale * k, 0.02, 50);
      const newRot = g.vp.rot + dRot;
      const rect = this.canvas.getBoundingClientRect();
      const sm0 = g.midX - rect.left;
      const sm1 = g.midY - rect.top;
      const sx = midX - rect.left;
      const sy = midY - rect.top;
      const ip = screenToImg(sm0, sm1, g.vp);
      const c = Math.cos(newRot), si = Math.sin(newRot);
      const newTx = sx - (ip.x * newScale * c - ip.y * newScale * si);
      const newTy = sy - (ip.x * newScale * si + ip.y * newScale * c);
      this.vp = { tx: newTx, ty: newTy, scale: newScale, rot: newRot };
      this._saveVp();
      this._invalidate();
    }
    e.preventDefault();
  }
  _onUp(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._gestureStart = null;
    if (this._pointers.size === 1) {
      this._gestureStart = null;
    }
    e.preventDefault?.();
  }
  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const ip = screenToImg(sx, sy, this.vp);
    const factor = e.ctrlKey || e.metaKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-e.deltaY * 5e-3);
    const newScale = clamp2(this.vp.scale * factor, 0.02, 50);
    const c = Math.cos(this.vp.rot), si = Math.sin(this.vp.rot);
    this.vp.tx = sx - (ip.x * newScale * c - ip.y * newScale * si);
    this.vp.ty = sy - (ip.x * newScale * si + ip.y * newScale * c);
    this.vp.scale = newScale;
    this._saveVp();
    this._invalidate();
  }
  _resizeCanvasToBody() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.body.clientWidth;
    const h = this.body.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
  }
  _invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }
  _render() {
    if (this._liveDoc && this._liveDirty) {
      this._recomposeLive();
      this._liveDirty = false;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const source = this._liveDoc ? this._composeCanvas : this.bitmap;
    if (!source) return;
    const cell = 8 * dpr;
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#3a3a3a";
    for (let y = 0; y < H; y += cell) {
      for (let x = (y / cell | 0) % 2 ? 0 : cell; x < W; x += cell * 2) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
    const v = this.vp;
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    ctx.setTransform(
      v.scale * c * dpr,
      v.scale * s * dpr,
      -v.scale * s * dpr,
      v.scale * c * dpr,
      v.tx * dpr,
      v.ty * dpr
    );
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
  }
  _updateEmptyHint() {
    if (!this.emptyHint) return;
    const has = !!(this.bitmap || this._liveDoc);
    this.emptyHint.classList.toggle("hidden", has);
  }
  _savePos() {
    try {
      const r = this.panel.getBoundingClientRect();
      localStorage.setItem(LS_POS, JSON.stringify({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height
      }));
    } catch {
    }
  }
  _loadPos() {
    try {
      const s = localStorage.getItem(LS_POS);
      if (!s) return;
      const o = JSON.parse(s);
      if (o.left != null) this.panel.style.left = o.left + "px";
      if (o.top != null) this.panel.style.top = o.top + "px";
      if (o.width) this.panel.style.width = o.width + "px";
      if (o.height) this.panel.style.height = o.height + "px";
    } catch {
    }
  }
  _saveVp() {
    try {
      localStorage.setItem(LS_VP, JSON.stringify(this.vp));
    } catch {
    }
  }
  _loadVp() {
    try {
      const s = localStorage.getItem(LS_VP);
      if (!s) return;
      const o = JSON.parse(s);
      if (Number.isFinite(o.tx)) this.vp.tx = o.tx;
      if (Number.isFinite(o.ty)) this.vp.ty = o.ty;
      if (Number.isFinite(o.scale)) this.vp.scale = o.scale;
      if (Number.isFinite(o.rot)) this.vp.rot = o.rot;
    } catch {
    }
  }
};
function clamp2(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
function screenToImg(sx, sy, vp) {
  const c = Math.cos(-vp.rot), s = Math.sin(-vp.rot);
  const dx = sx - vp.tx, dy = sy - vp.ty;
  return { x: (dx * c - dy * s) / vp.scale, y: (dx * s + dy * c) / vp.scale };
}

// src/palette.js
var CANVAS_SIZE = 256;
var PaletteWindow = class {
  constructor({ root, onColorSampled, getCurrentColor }) {
    this.root = root;
    this.onColorSampled = onColorSampled;
    this.getCurrentColor = getCurrentColor || (() => "#000");
    this.canvas = root.querySelector(".palette-canvas");
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext("2d");
    this._fillBackground();
    this.mode = "brush";
    this._open = root.classList.contains("hidden") ? false : true;
    this._wireEvents();
    this._wireToolButtons();
    this._wireDrag();
  }
  _fillBackground() {
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }
  clear() {
    this._fillBackground();
  }
  open() {
    this.root.classList.remove("hidden");
    this._open = true;
  }
  close() {
    this.root.classList.add("hidden");
    this._open = false;
  }
  toggle() {
    this._open ? this.close() : this.open();
  }
  isOpen() {
    return this._open;
  }
  setMode(m) {
    if (m !== "brush" && m !== "smudge" && m !== "picker") return;
    this.mode = m;
    this._refreshToolButtons();
  }
  _refreshToolButtons() {
    for (const b of this.root.querySelectorAll(".palette-tool")) {
      b.setAttribute("aria-pressed", b.dataset.paletteTool === this.mode ? "true" : "false");
    }
  }
  _wireToolButtons() {
    for (const b of this.root.querySelectorAll(".palette-tool")) {
      b.addEventListener("click", () => this.setMode(b.dataset.paletteTool));
    }
    const clearBtn = this.root.querySelector(".palette-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => this.clear());
    const closeBtn = this.root.querySelector(".palette-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this.close());
    this._refreshToolButtons();
  }
  _toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * CANVAS_SIZE,
      y: (e.clientY - r.top) / r.height * CANVAS_SIZE
    };
  }
  _sample(x, y) {
    const ix = Math.max(0, Math.min(CANVAS_SIZE - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(CANVAS_SIZE - 1, Math.floor(y)));
    const d = this.ctx.getImageData(ix, iy, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }
  _toHex({ r, g, b }) {
    return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");
  }
  _wireEvents() {
    let active = false, lastX = 0, lastY = 0, loaded = null;
    const onDown = (e) => {
      e.stopPropagation();
      this.canvas.setPointerCapture(e.pointerId);
      const { x, y } = this._toLocal(e);
      if (this.mode === "picker") {
        this.onColorSampled(this._toHex(this._sample(x, y)));
        return;
      }
      active = true;
      lastX = x;
      lastY = y;
      if (this.mode === "smudge") loaded = this._sample(x, y);
      this._paint(x, y, loaded);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!active) return;
      const { x, y } = this._toLocal(e);
      const dx = x - lastX, dy = y - lastY;
      const L = Math.hypot(dx, dy);
      const step = 3;
      if (L > step) {
        const n = Math.ceil(L / step);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          this._paint(lastX + dx * t, lastY + dy * t, loaded);
        }
        lastX = x;
        lastY = y;
      } else {
        this._paint(x, y, loaded);
        lastX = x;
        lastY = y;
      }
    };
    const onUp = (e) => {
      active = false;
      loaded = null;
      e?.stopPropagation?.();
    };
    this.canvas.addEventListener("pointerdown", onDown);
    this.canvas.addEventListener("pointermove", onMove);
    this.canvas.addEventListener("pointerup", onUp);
    this.canvas.addEventListener("pointercancel", onUp);
    this.canvas.addEventListener("pointerleave", () => {
    });
  }
  _paint(x, y, loaded) {
    const ctx = this.ctx;
    if (this.mode === "brush") {
      ctx.fillStyle = this.getCurrentColor();
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.mode === "smudge" && loaded) {
      const cur = this._sample(x, y);
      const strength = 0.85, dryness = 0.05;
      const out = {
        r: loaded.r * strength + cur.r * (1 - strength),
        g: loaded.g * strength + cur.g * (1 - strength),
        b: loaded.b * strength + cur.b * (1 - strength)
      };
      ctx.fillStyle = `rgb(${out.r | 0},${out.g | 0},${out.b | 0})`;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      loaded.r = loaded.r * (1 - dryness) + cur.r * dryness;
      loaded.g = loaded.g * (1 - dryness) + cur.g * dryness;
      loaded.b = loaded.b * (1 - dryness) + cur.b * dryness;
    }
  }
  _wireDrag() {
    const head = this.root.querySelector(".palette-head");
    if (!head) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = this.root.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.root.style.left = ox + (e.clientX - sx) + "px";
      this.root.style.top = oy + (e.clientY - sy) + "px";
      this.root.style.right = "auto";
      this.root.style.bottom = "auto";
    });
    head.addEventListener("pointerup", () => {
      dragging = false;
    });
  }
  // serialize：保存 canvas 内容（toDataURL b64）+ 窗口位置
  getSerializedState() {
    try {
      return {
        open: this._open,
        mode: this.mode,
        imageB64: this.canvas.toDataURL("image/png"),
        position: this.root.style.left ? { left: this.root.style.left, top: this.root.style.top } : null
      };
    } catch (_) {
      return null;
    }
  }
  applySerializedState(s) {
    if (!s) return;
    if (s.mode) this.setMode(s.mode);
    if (s.position) {
      this.root.style.left = s.position.left;
      this.root.style.top = s.position.top;
      this.root.style.right = "auto";
      this.root.style.bottom = "auto";
    }
    if (s.imageB64) {
      const img = new Image();
      img.onload = () => {
        this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        this.ctx.drawImage(img, 0, 0);
      };
      img.src = s.imageB64;
    }
    if (s.open) this.open();
    else this.close();
  }
};

// src/zip.js
function Z() {
  if (typeof window === "undefined" || !window.zip) {
    throw new Error("zip.js \u672A\u52A0\u8F7D\uFF08\u5E94\u5728 app.js \u4E4B\u524D\u4EE5 classic <script> \u5F15\u5165 vendor/zip-js/zip-full.min.js\uFF09");
  }
  return window.zip;
}
var _configured = false;
function ensureConfigured() {
  if (_configured) return;
  try {
    Z().configure({ useWebWorkers: false });
  } catch (_) {
  }
  _configured = true;
}
function toZipReader(data) {
  const z = Z();
  if (data instanceof Blob) return new z.BlobReader(data);
  if (data instanceof Uint8Array) return new z.Uint8ArrayReader(data);
  if (data instanceof ArrayBuffer) return new z.Uint8ArrayReader(new Uint8Array(data));
  if (typeof data === "string") return new z.TextReader(data);
  throw new TypeError("zip: \u4E0D\u652F\u6301\u7684\u6570\u636E\u7C7B\u578B");
}
async function zipPack(entries) {
  ensureConfigured();
  const z = Z();
  const writer = new z.ZipWriter(new z.BlobWriter("application/zip"));
  for (const { path, data } of entries) {
    await writer.add(path, toZipReader(data), { level: 0 });
  }
  return await writer.close();
}
async function zipUnpack(blob) {
  ensureConfigured();
  const z = Z();
  const reader = new z.ZipReader(new z.BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    const out = {};
    for (const e of entries) {
      if (e.directory) continue;
      out[e.filename] = await e.getData(new z.Uint8ArrayWriter());
    }
    return out;
  } finally {
    await reader.close();
  }
}

// src/ora.js
function makeBitmap3(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      return new OffscreenCanvas(w, h);
    } catch (_) {
    }
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
async function canvasToPngBytes(canvas) {
  let blob;
  if (typeof canvas.convertToBlob === "function") {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else if (typeof canvas.toBlob === "function") {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } else {
    throw new Error("canvas \u65E0 toBlob / convertToBlob");
  }
  if (!blob) throw new Error("canvas \u2192 blob \u5931\u8D25");
  return new Uint8Array(await blob.arrayBuffer());
}
function bytesToString(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}
function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;"
  })[c]);
}
function renderMerged(doc2) {
  const c = makeBitmap3(doc2.width, doc2.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = doc2.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, doc2.width, doc2.height);
  const baseFor = computeClipBaseFor(doc2.layers);
  for (let i = 0; i < doc2.layers.length; i++) {
    const L = doc2.layers[i];
    if (!L.visible) continue;
    if (L.bboxW <= 0 || L.bboxH <= 0) continue;
    const baseIdx = baseFor[i];
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    if (baseIdx < 0) {
      ctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    } else {
      const base = doc2.layers[baseIdx];
      const tmp = makeBitmap3(L.bboxW, L.bboxH);
      const tctx = tmp.getContext("2d");
      tctx.drawImage(L.canvas, 0, 0);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(base.canvas, base.bboxX - L.bboxX, base.bboxY - L.bboxY);
      ctx.drawImage(tmp, L.bboxX, L.bboxY);
    }
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  return c;
}
function renderThumbnail(merged, maxSide = 256) {
  const w = merged.width, h = merged.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const c = makeBitmap3(tw, th);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(merged, 0, 0, tw, th);
  return c;
}
function buildStackXml(doc2) {
  const layers = [];
  for (let i = doc2.layers.length - 1; i >= 0; i--) {
    const L = doc2.layers[i];
    if (L.bboxW <= 0 || L.bboxH <= 0) {
    }
    const attrs = [
      `name="${escapeXml(L.name)}"`,
      `src="data/layer${L.id}.png"`,
      `x="${L.bboxX}"`,
      `y="${L.bboxY}"`,
      `opacity="${L.opacity.toFixed(4)}"`,
      `visibility="${L.visible ? "visible" : "hidden"}"`,
      `composite-op="${oraCompositeOp(L.mode || "source-over")}"`,
      // 私有属性：clipping mask + reference layer 标记
      ...L.clippingMask ? [`webpaint:clipping="true"`] : [],
      ...doc2.referenceLayerId === L.id ? [`webpaint:reference="true"`] : []
    ];
    layers.push(`    <layer ${attrs.join(" ")} />`);
  }
  const wroteWith = WEBPAINT_VERSION;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${doc2.width}" h="${doc2.height}" xres="72" yres="72" xmlns:webpaint="https://github.com/fangzhangmnm/webpaint/ns" webpaint:wrote-with="${escapeXml(wroteWith)}">
  <stack name="root">
${layers.join("\n")}
  </stack>
</image>
`;
  return xml;
}
var MODE_TO_ORA = {
  "source-over": "svg:src-over",
  "multiply": "svg:multiply",
  "screen": "svg:screen",
  "overlay": "svg:overlay",
  "darken": "svg:darken",
  "lighten": "svg:lighten",
  "color-dodge": "svg:color-dodge",
  "color-burn": "svg:color-burn",
  "hard-light": "svg:hard-light",
  "soft-light": "svg:soft-light",
  "difference": "svg:difference",
  "exclusion": "svg:exclusion"
};
function oraCompositeOp(canvasMode) {
  return MODE_TO_ORA[canvasMode] || "svg:src-over";
}
var ORA_TO_MODE = Object.fromEntries(
  Object.entries(MODE_TO_ORA).map(([k, v]) => [v, k])
);
function canvasModeFromOra(op) {
  return ORA_TO_MODE[op] || "source-over";
}
async function encodeDocToOra(doc2, opts = {}) {
  const merged = renderMerged(doc2);
  const thumb = renderThumbnail(merged, 256);
  const mergedPng = await canvasToPngBytes(merged);
  const thumbPng = await canvasToPngBytes(thumb);
  const entries = [
    // spec 要求 mimetype 是第一个 entry
    { path: "mimetype", data: "image/openraster" },
    { path: "stack.xml", data: buildStackXml(doc2) },
    { path: "mergedimage.png", data: mergedPng },
    { path: "Thumbnails/thumbnail.png", data: thumbPng }
  ];
  for (const L of doc2.layers) {
    let png;
    if (L.bboxW > 0 && L.bboxH > 0) {
      png = await canvasToPngBytes(L.canvas);
    } else {
      const c = makeBitmap3(1, 1);
      png = await canvasToPngBytes(c);
    }
    entries.push({ path: `data/layer${L.id}.png`, data: png });
  }
  if (opts.referenceImage instanceof Blob) {
    const refBytes = new Uint8Array(await opts.referenceImage.arrayBuffer());
    entries.push({ path: "webpaint/reference.png", data: refBytes });
  }
  if (opts.webpaintState && typeof opts.webpaintState === "object") {
    const jsonText = JSON.stringify(opts.webpaintState);
    entries.push({ path: "webpaint/state.json", data: jsonText });
  }
  return await zipPack(entries);
}
function parseStackXml(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = dom.querySelector("parsererror");
  if (err) throw new Error("stack.xml \u89E3\u6790\u5931\u8D25\uFF1A" + err.textContent);
  const image = dom.querySelector("image");
  if (!image) throw new Error("stack.xml \u7F3A <image>");
  const w = parseInt(image.getAttribute("w") || "0", 10);
  const h = parseInt(image.getAttribute("h") || "0", 10);
  if (!w || !h) throw new Error("stack.xml <image> w/h \u65E0\u6548");
  const layerNodes = [...dom.querySelectorAll("stack > layer")].reverse();
  const layers = layerNodes.map((n) => ({
    name: n.getAttribute("name") || "\u56FE\u5C42",
    src: n.getAttribute("src") || "",
    x: parseInt(n.getAttribute("x") || "0", 10),
    y: parseInt(n.getAttribute("y") || "0", 10),
    opacity: parseFloat(n.getAttribute("opacity") || "1"),
    visible: (n.getAttribute("visibility") || "visible") === "visible",
    mode: canvasModeFromOra(n.getAttribute("composite-op") || "svg:src-over"),
    clippingMask: n.getAttribute("webpaint:clipping") === "true",
    isReference: n.getAttribute("webpaint:reference") === "true"
  }));
  const wroteWith = image.getAttribute("webpaint:wrote-with") || null;
  return { w, h, layers, wroteWith };
}
async function decodeOraToDoc(blob) {
  const files = await zipUnpack(blob);
  if (!files["stack.xml"]) throw new Error(".ora \u7F3A stack.xml");
  if (files["mimetype"]) {
    const m = bytesToString(files["mimetype"]).trim();
    if (m !== "image/openraster") {
      console.warn(`[ora] mimetype \u4E0D\u662F image/openraster\uFF1A${m}`);
    }
  }
  const xml = bytesToString(files["stack.xml"]);
  const meta = parseStackXml(xml);
  const doc2 = new PaintDoc({ width: meta.w, height: meta.h });
  doc2.layers = [];
  for (const L of meta.layers) {
    const png = files[L.src];
    if (!png) throw new Error(`.ora \u7F3A\u56FE\u5C42 PNG\uFF1A${L.src}`);
    const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const layer = new Layer({
      width: meta.w,
      height: meta.h,
      name: L.name,
      empty: true
      // 起空，下面手填 bbox + canvas
    });
    layer.visible = L.visible;
    layer.opacity = L.opacity;
    layer.mode = L.mode;
    layer.clippingMask = !!L.clippingMask;
    layer.bboxX = L.x;
    layer.bboxY = L.y;
    layer.bboxW = bitmap.width;
    layer.bboxH = bitmap.height;
    layer.canvas = makeBitmap3(bitmap.width, bitmap.height);
    layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: false });
    layer.ctx.imageSmoothingEnabled = true;
    layer.ctx.imageSmoothingQuality = "low";
    layer.ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    doc2.layers.push(layer);
    if (L.isReference) doc2.referenceLayerId = layer.id;
  }
  if (doc2.layers.length === 0) {
    doc2.layers.push(new Layer({ width: meta.w, height: meta.h, name: "\u56FE\u5C42 1" }));
  }
  doc2.activeIndex = Math.max(0, doc2.layers.length - 1);
  if (files["webpaint/reference.png"]) {
    doc2._referenceBlob = new Blob([files["webpaint/reference.png"]], { type: "image/png" });
  }
  if (files["webpaint/state.json"]) {
    try {
      doc2._webpaintState = JSON.parse(bytesToString(files["webpaint/state.json"]));
    } catch (e) {
      console.warn("[ora] webpaint/state.json parse failed:", e);
    }
  }
  doc2._wroteWith = meta.wroteWith || null;
  return doc2;
}
function parseAppVersion(s) {
  if (!s) return null;
  const m = String(s).match(/^v(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// src/session.js
var LS_CURRENT_NAME = "webpaint.currentSessionName";
var DEFAULT_NAME = "\u672A\u547D\u540D";
var LEGACY_SLOT = "current";
function getCurrentSessionName() {
  try {
    return localStorage.getItem(LS_CURRENT_NAME) || DEFAULT_NAME;
  } catch {
    return DEFAULT_NAME;
  }
}
function setCurrentSessionName(name) {
  try {
    localStorage.setItem(LS_CURRENT_NAME, name);
  } catch {
  }
}
async function saveSession(doc2, name, opts = {}) {
  const sessionName = name || getCurrentSessionName();
  const [ora, thumb] = await Promise.all([
    encodeDocToOra(doc2, {
      referenceImage: opts.referenceImage,
      webpaintState: opts.webpaintState
    }),
    renderThumbBlob(doc2, 256)
  ]);
  const pkg = {
    name: sessionName,
    updatedAt: Date.now(),
    ora,
    thumb
    // Blob (image/jpeg, ~5-15KB)
  };
  await putSession(sessionName, pkg);
  return pkg;
}
async function renderThumbBlob(doc2, maxSide = 256) {
  const W = doc2.width, H = doc2.height;
  const merged = document.createElement("canvas");
  merged.width = W;
  merged.height = H;
  const mctx = merged.getContext("2d");
  mctx.fillStyle = doc2.backgroundColor || "#ffffff";
  mctx.fillRect(0, 0, W, H);
  for (const L of doc2.layers) {
    if (!L.visible || L.bboxW <= 0 || L.bboxH <= 0) continue;
    const pa = mctx.globalAlpha, pc = mctx.globalCompositeOperation;
    mctx.globalAlpha = L.opacity;
    mctx.globalCompositeOperation = L.mode || "source-over";
    mctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    mctx.globalAlpha = pa;
    mctx.globalCompositeOperation = pc;
  }
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const tw = Math.max(1, Math.round(W * scale));
  const th = Math.max(1, Math.round(H * scale));
  const thumb = document.createElement("canvas");
  thumb.width = tw;
  thumb.height = th;
  const tctx = thumb.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(merged, 0, 0, tw, th);
  const jpgBlob = await new Promise((resolve) => thumb.toBlob(resolve, "image/jpeg", 0.78));
  if (jpgBlob) return jpgBlob;
  return await new Promise((resolve) => thumb.toBlob(resolve, "image/png"));
}
async function listSessions() {
  const ids = await listSessionIds();
  const out = [];
  for (const id of ids) {
    if (id === LEGACY_SLOT) continue;
    const pkg = await getSession(id);
    if (!pkg) continue;
    out.push({
      name: id,
      updatedAt: pkg.updatedAt || 0,
      size: pkg.ora && pkg.ora.size || 0,
      thumb: pkg.thumb || null
      // v36 之前的 pkg 没 thumb，UI 给占位
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
async function loadCurrentSession() {
  const name = getCurrentSessionName();
  let pkg = await getSession(name);
  if (!pkg) {
    pkg = await getSession(LEGACY_SLOT);
    if (pkg) {
      pkg.name = DEFAULT_NAME;
      await putSession(DEFAULT_NAME, pkg);
      await deleteSession(LEGACY_SLOT);
      setCurrentSessionName(DEFAULT_NAME);
    }
  }
  if (!pkg || !pkg.ora) return null;
  return await decodeOraToDoc(pkg.ora);
}
async function openSession(name) {
  const pkg = await getSession(name);
  if (!pkg || !pkg.ora) return null;
  return await decodeOraToDoc(pkg.ora);
}
async function removeSession(name) {
  await deleteSession(name);
}
async function exportOraDownload(doc2, filename = "\u672A\u547D\u540D.ora") {
  const blob = await encodeDocToOra(doc2);
  triggerDownload(blob, filename);
}
async function exportPsdDownload(doc2, filename = "\u672A\u547D\u540D.psd") {
  const { encodeDocToPsd: encodeDocToPsd2 } = await Promise.resolve().then(() => (init_psd(), psd_exports));
  const blob = await encodeDocToPsd2(doc2);
  triggerDownload(blob, filename);
}
async function renderMergedBlob(doc2, mime = "image/png", quality) {
  const c = document.createElement("canvas");
  c.width = doc2.width;
  c.height = doc2.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = doc2.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, doc2.width, doc2.height);
  for (const L of doc2.layers) {
    if (!L.visible) continue;
    if (L.bboxW <= 0 || L.bboxH <= 0) continue;
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    ctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  const blob = await new Promise((resolve) => c.toBlob(resolve, mime, quality));
  if (blob) return blob;
  if (mime !== "image/png") {
    return await new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }
  throw new Error("canvas.toBlob \u8FD4 null");
}
async function shareOrDownloadImage(doc2, format = "png", filename = "WebPaint") {
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const ext = format === "jpg" ? "jpg" : "png";
  const quality = format === "jpg" ? 0.92 : void 0;
  const blob = await renderMergedBlob(doc2, mime, quality);
  const fname = `${filename}.${ext}`;
  const file = new File([blob], fname, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return { method: "share" };
    } catch (e) {
      if (e && e.name === "AbortError") return { method: "cancel" };
    }
  }
  triggerDownload(blob, fname);
  return { method: "download" };
}
async function copyImageToClipboard(doc2) {
  if (!navigator.clipboard || !navigator.clipboard.write) {
    throw new Error("\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u526A\u8D34\u677F\u5199\u5165");
  }
  const blob = await renderMergedBlob(doc2, "image/png");
  if (!blob) throw new Error("\u751F\u6210 PNG \u5931\u8D25");
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob })
  ]);
}
async function readImageFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error("\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u526A\u8D34\u677F\u8BFB\u53D6");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    for (const type of item.types) {
      if (type.startsWith("image/")) {
        return await item.getType(type);
      }
    }
  }
  return null;
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// src/config.js
var CLIENT_ID = "18c496a6-5d86-4ff5-8dd0-67d565480a3e";
var AUTHORITY = "https://login.microsoftonline.com/common";
var SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
function sessionFileName(sessionName) {
  const segments = (sessionName || "\u672A\u547D\u540D").split("/").map((s) => s.replace(/[\\:*?"<>|]+/g, "_").trim()).filter(Boolean);
  if (!segments.length) segments.push("\u672A\u547D\u540D");
  return `${segments.join("/")}.ora`;
}

// src/auth.js
function isAuthConfigured() {
  return typeof CLIENT_ID === "string" && CLIENT_ID.length > 0 && !CLIENT_ID.startsWith("REPLACE_ME");
}
var MSAL_URL = new URL("./src/vendor/msal/msal-browser.min.js", document.baseURI).href;
var msalLoadPromise = null;
var pca = null;
var activeAccount = null;
var initPromise = null;
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}
async function loadScriptWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await loadScript(url);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`MSAL load attempt ${i + 1}/${attempts} failed`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`MSAL load failed ${url}: ${lastErr?.message}`);
}
function loadMsal() {
  if (window.msal) return Promise.resolve(window.msal);
  if (msalLoadPromise) return msalLoadPromise;
  msalLoadPromise = (async () => {
    await loadScriptWithRetry(MSAL_URL);
    if (window.msal) return window.msal;
    msalLoadPromise = null;
    throw new Error("MSAL loaded but window.msal didn't appear");
  })().catch((e) => {
    msalLoadPromise = null;
    throw e;
  });
  return msalLoadPromise;
}
async function initAuth() {
  if (!isAuthConfigured()) {
    return { signedIn: false, account: null, notConfigured: true };
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const msal = await loadMsal();
    pca = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
        postLogoutRedirectUri: location.origin + location.pathname
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false
      }
    });
    await pca.initialize();
    let response = null;
    try {
      response = await pca.handleRedirectPromise();
    } catch (e) {
      console.warn("handleRedirectPromise failed:", e);
    }
    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      return { signedIn: true, account: activeAccount };
    }
    const cached = pca.getAllAccounts();
    if (cached.length === 0) return { signedIn: false, account: null };
    try {
      await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
      pca.setActiveAccount(cached[0]);
      activeAccount = cached[0];
      return { signedIn: true, account: activeAccount };
    } catch (_) {
      return { signedIn: false, account: null, probedAccount: cached[0] };
    }
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}
async function signIn() {
  if (!pca) await initAuth();
  return pca.loginRedirect({ scopes: SCOPES });
}
async function signOut() {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  try {
    await pca.clearCache({ account });
  } catch (e) {
    console.warn("clearCache failed:", e);
  }
  try {
    pca.setActiveAccount(null);
  } catch (_) {
  }
}
async function getToken() {
  if (!pca || !activeAccount) throw new Error("Not signed in");
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: activeAccount });
    return result.accessToken;
  } catch (e) {
    await pca.acquireTokenRedirect({ scopes: SCOPES });
    throw e;
  }
}
function getActiveAccount() {
  return activeAccount;
}
function isSignedIn() {
  return !!activeAccount;
}
async function retrySilentSignIn() {
  if (activeAccount) return true;
  if (!isAuthConfigured()) return false;
  if (!pca) {
    try {
      await initAuth();
    } catch (_) {
      return false;
    }
  }
  if (!pca) return false;
  const cached = pca.getAllAccounts();
  if (cached.length === 0) return false;
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
    pca.setActiveAccount(cached[0]);
    activeAccount = cached[0];
    return true;
  } catch (_) {
    return false;
  }
}

// src/graph.js
var GRAPH_BASE = "https://graph.microsoft.com/v1.0";
var SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
function encodeSeg(name) {
  return encodeURIComponent(name).replace(/'/g, "%27");
}
function encodeApprootPath(path) {
  return path.split("/").filter(Boolean).map(encodeSeg).join("/");
}
async function graphFetch(method, pathOrUrl, { headers = {}, body = null } = {}) {
  const token = await getToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (body != null) {
    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
    }
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch (_) {
    }
    const err = new Error(`Graph ${method} ${pathOrUrl} \u2192 ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = detail;
    throw err;
  }
  return response;
}
async function listChildren(subfolder = "") {
  const pathPart = subfolder ? `:/${encodeApprootPath(subfolder)}:` : "";
  const items = [];
  let next = `/me/drive/special/approot${pathPart}/children?$top=200&$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder`;
  while (next) {
    let response;
    try {
      response = await graphFetch("GET", next);
    } catch (e) {
      if (e.status === 404 && subfolder) return [];
      throw e;
    }
    const page = await response.json();
    items.push(...page.value ?? []);
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}
async function getItemByPath(path) {
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,size,eTag,@microsoft.graph.downloadUrl`
    );
    return await r.json();
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
async function downloadItemBlob(itemId) {
  const meta = await graphFetch(
    "GET",
    `/me/drive/items/${itemId}?$select=id,@microsoft.graph.downloadUrl`
  );
  const metaJson = await meta.json();
  const dl = metaJson["@microsoft.graph.downloadUrl"];
  if (dl) {
    const r2 = await fetch(dl);
    if (!r2.ok) throw new Error(`downloadUrl failed ${r2.status}`);
    return await r2.blob();
  }
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`);
  return await r.blob();
}
async function uploadFileToApproot(path, blob, contentType = "application/octet-stream", { conflictBehavior = "replace", eTag = null } = {}) {
  const headers = { "Content-Type": contentType };
  if (eTag) headers["If-Match"] = eTag;
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    const r = await graphFetch(
      "PUT",
      `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
      { headers, body: blob }
    );
    return r.json();
  }
  const sessR = await graphFetch(
    "POST",
    `/me/drive/special/approot:/${encodeApprootPath(path)}:/createUploadSession`,
    {
      body: {
        item: {
          "@microsoft.graph.conflictBehavior": conflictBehavior,
          name: path.split("/").pop()
        }
      },
      headers: eTag ? { "If-Match": eTag } : void 0
    }
  );
  const { uploadUrl } = await sessR.json();
  const CHUNK = 5 * 1024 * 1024;
  let offset = 0;
  let last = null;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size) - 1;
    const chunk = blob.slice(offset, end + 1);
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.size),
        "Content-Range": `bytes ${offset}-${end}/${blob.size}`
      },
      body: chunk
    });
    if (!r.ok && r.status !== 202) {
      const err = new Error(`chunked upload failed ${r.status}`);
      err.status = r.status;
      throw err;
    }
    last = await r.json().catch(() => null);
    offset = end + 1;
  }
  return last;
}
async function deleteItem(itemId) {
  await graphFetch("DELETE", `/me/drive/items/${itemId}`);
}

// src/cloud.js
var ORA_CT = "application/zip";
function etagKey(name) {
  return `webpaint.etag:${name}`;
}
function getKnownETag(name) {
  try {
    return localStorage.getItem(etagKey(name)) || null;
  } catch (_) {
    return null;
  }
}
function setKnownETag(name, eTag) {
  try {
    if (eTag) localStorage.setItem(etagKey(name), eTag);
    else localStorage.removeItem(etagKey(name));
  } catch (_) {
  }
}
function cloudDirtyKey(name) {
  return `webpaint.cloudDirty:${name}`;
}
function isCloudDirty(name) {
  if (!isSignedIn()) return false;
  try {
    const v = localStorage.getItem(cloudDirtyKey(name));
    if (v === null) return true;
    return v === "1";
  } catch (_) {
    return false;
  }
}
function setCloudDirty(name, dirty) {
  try {
    localStorage.setItem(cloudDirtyKey(name), dirty ? "1" : "0");
  } catch (_) {
  }
}
var LAST_SIGNED_IN_KEY = "webpaint.lastSessionSignedIn";
function getLastSessionSignedIn() {
  try {
    return localStorage.getItem(LAST_SIGNED_IN_KEY) === "1";
  } catch (_) {
    return false;
  }
}
function setLastSessionSignedIn(v) {
  try {
    localStorage.setItem(LAST_SIGNED_IN_KEY, v ? "1" : "0");
  } catch (_) {
  }
}
async function fetchSessionMetadata(name) {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const path = sessionFileName(name);
  const item = await getItemByPath(path);
  if (!item) return null;
  return {
    etag: item.eTag,
    lastModified: item.lastModifiedDateTime,
    size: item.size,
    item
  };
}
var CloudConflictError = class extends Error {
  constructor(message, sessionName) {
    super(message);
    this.name = "CloudConflictError";
    this.sessionName = sessionName;
  }
};
async function pushSession(name, oraBlob) {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const path = sessionFileName(name);
  const knownETag = getKnownETag(name);
  try {
    const item = await uploadFileToApproot(path, oraBlob, ORA_CT, {
      conflictBehavior: "replace",
      eTag: knownETag
      // 首次推 null → 服务器接受
    });
    setKnownETag(name, item.eTag);
    setCloudDirty(name, false);
    return { item };
  } catch (e) {
    if (e.status === 412) {
      throw new CloudConflictError(
        `\u4E91\u7AEF\u5DF2\u6709\u66F4\u65B0\u7248\u672C "${name}"\u3002\u8BF7\u53E6\u5B58\u4E3A\u65B0\u540D\u5B57\u540E\u518D\u63A8\u9001\u3002`,
        name
      );
    }
    throw e;
  }
}
async function pullSessionByPath(path) {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const item = await getItemByPath(path);
  if (!item) return null;
  const blob = await downloadItemBlob(item.id);
  const stem = path.replace(/\.ora$/i, "");
  setKnownETag(stem, item.eTag);
  setCloudDirty(stem, false);
  return { blob, item, suggestedName: stem };
}
async function listCloudSessionsRecursive() {
  if (!isSignedIn()) return [];
  const out = [];
  await _walkApproot("", out);
  return out;
}
async function _walkApproot(subpath, out, depth = 0) {
  if (depth > 8) return;
  let items;
  try {
    items = await listChildren(subpath);
  } catch (e) {
    console.warn("listChildren failed at", subpath, e);
    return;
  }
  for (const it of items) {
    const itPath = subpath ? `${subpath}/${it.name}` : it.name;
    if (it.folder) {
      await _walkApproot(itPath, out, depth + 1);
    } else if (it.file && /\.ora$/i.test(it.name)) {
      out.push({ ...it, path: itPath });
    }
  }
}
async function deleteCloudSession(name) {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const path = sessionFileName(name);
  const item = await getItemByPath(path);
  if (item) await deleteItem(item.id);
  clearCloudState(name);
}
var BRUSH_RACK_NAME = "brush-rack";
var BRUSH_RACK_PATH = "brush-rack.json";
var BRUSH_RACK_CT = "application/json";
async function pushBrushRack(rack) {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const knownETag = getKnownETag(BRUSH_RACK_NAME);
  const json = JSON.stringify(rack);
  const blob = new Blob([json], { type: BRUSH_RACK_CT });
  try {
    const item = await uploadFileToApproot(BRUSH_RACK_PATH, blob, BRUSH_RACK_CT, {
      conflictBehavior: "replace",
      eTag: knownETag
    });
    setKnownETag(BRUSH_RACK_NAME, item.eTag);
    return { item };
  } catch (e) {
    if (e.status === 412) {
      throw new CloudConflictError(`\u4E91\u7AEF\u7B14\u67B6\u5DF2\u88AB\u6539\u8FC7`, BRUSH_RACK_NAME);
    }
    throw e;
  }
}
async function pullBrushRack() {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const item = await getItemByPath(BRUSH_RACK_PATH);
  if (!item) return null;
  const blob = await downloadItemBlob(item.id);
  setKnownETag(BRUSH_RACK_NAME, item.eTag);
  const text = await blob.text();
  return { rack: JSON.parse(text), etag: item.eTag };
}
async function fetchBrushRackMetadata() {
  if (!isSignedIn()) throw new Error("\u672A\u767B\u5F55 OneDrive");
  const item = await getItemByPath(BRUSH_RACK_PATH);
  if (!item) return null;
  return { etag: item.eTag, lastModified: item.lastModifiedDateTime };
}
function getBrushRackKnownETag() {
  return getKnownETag(BRUSH_RACK_NAME);
}
function clearCloudState(name) {
  try {
    localStorage.removeItem(etagKey(name));
    localStorage.removeItem(cloudDirtyKey(name));
  } catch (_) {
  }
}

// src/app.js
var THEMES = ["auto", "day", "night"];
var THEME_LABEL = { auto: "\u8DDF\u968F\u7CFB\u7EDF", day: "\u65E5", night: "\u591C" };
var els = {
  board: document.getElementById("board"),
  topBar: document.getElementById("topBar"),
  zoomLabel: document.getElementById("zoomLabel"),
  canvasSizeLabel: document.getElementById("canvasSizeLabel"),
  statusLabel: document.getElementById("statusLabel"),
  versionLabel: document.getElementById("versionLabel"),
  sizeSlider: document.getElementById("sizeSlider"),
  sizePopup: document.getElementById("sizePopup"),
  sizePopupCircle: document.getElementById("sizePopupCircle"),
  sizePopupText: document.getElementById("sizePopupText"),
  opacitySlider: document.getElementById("opacitySlider"),
  undoBtn: document.getElementById("undoButton"),
  redoBtn: document.getElementById("redoButton"),
  layersBtn: document.getElementById("layersButton"),
  layersPanel: document.getElementById("layersPanel"),
  layersPanelHead: document.getElementById("layersPanelHead"),
  layersPanelClose: document.getElementById("layersPanelClose"),
  layersList: document.getElementById("layersList"),
  layersCountLabel: document.getElementById("layersCountLabel"),
  layerAddBtn: document.getElementById("layerAddBtn"),
  layerDelBtn: document.getElementById("layerDelBtn"),
  layerUpBtn: document.getElementById("layerUpBtn"),
  layerDownBtn: document.getElementById("layerDownBtn"),
  menuBtn: document.getElementById("menuButton"),
  menuPanel: document.getElementById("menuPanel"),
  menuLongPressPick: document.getElementById("menuLongPressPick"),
  menuPressureSize: document.getElementById("menuPressureSize"),
  menuPressureOpacity: document.getElementById("menuPressureOpacity"),
  menuTheme: document.getElementById("menuTheme"),
  menuClear: document.getElementById("menuClear"),
  // v120 (user：「导出项目和导出语义分开 + 小扳手」)
  // 旧 5 项 (menuImport / menuExportPng/Jpg/Ora/Psd / menuClipboardCopy/Paste) → 新 3 行
  menuExportProject: document.getElementById("menuExportProject"),
  menuExportProjectConfig: document.getElementById("menuExportProjectConfig"),
  menuExportImage: document.getElementById("menuExportImage"),
  menuExportImageConfig: document.getElementById("menuExportImageConfig"),
  menuImportImage: document.getElementById("menuImportImage"),
  menuImportImageConfig: document.getElementById("menuImportImageConfig"),
  menuFit: document.getElementById("menuFit"),
  menuBrushSettings: document.getElementById("menuBrushSettings"),
  // v109: brushPanel + brush* sliders 撤了（平滑 per-preset，进 brush settings 调）
  topSaveBtn: document.getElementById("topSaveBtn"),
  topAdjustBtn: document.getElementById("topAdjustBtn"),
  adjustPopup: document.getElementById("adjustPopup"),
  adjustLiquify: document.getElementById("adjustLiquify"),
  // v110 crop / resample / adjust
  resampleBackdrop: document.getElementById("resampleBackdrop"),
  resampleSheet: document.getElementById("resampleSheet"),
  resampleW: document.getElementById("resampleW"),
  resampleH: document.getElementById("resampleH"),
  resampleLock: document.getElementById("resampleLock"),
  resampleMode: document.getElementById("resampleMode"),
  resampleCancel: document.getElementById("resampleCancel"),
  resampleConfirm: document.getElementById("resampleConfirm"),
  adjustPanel: document.getElementById("adjustPanel"),
  adjustPanelHead: document.getElementById("adjustPanelHead"),
  adjustBrightness: document.getElementById("adjustBrightness"),
  adjustBrightnessVal: document.getElementById("adjustBrightnessVal"),
  adjustContrast: document.getElementById("adjustContrast"),
  adjustContrastVal: document.getElementById("adjustContrastVal"),
  adjustSaturation: document.getElementById("adjustSaturation"),
  adjustSaturationVal: document.getElementById("adjustSaturationVal"),
  adjustHue: document.getElementById("adjustHue"),
  adjustHueVal: document.getElementById("adjustHueVal"),
  topGalleryBtn: document.getElementById("topGalleryBtn"),
  liquifyPanel: document.getElementById("liquifyPanel"),
  liquifyPanelHead: document.getElementById("liquifyPanelHead"),
  liquifyPanelClose: document.getElementById("liquifyPanelClose"),
  liquifyMode: document.getElementById("liquifyMode"),
  liquifySize: document.getElementById("liquifySize"),
  liquifySizeVal: document.getElementById("liquifySizeVal"),
  liquifyStrength: document.getElementById("liquifyStrength"),
  liquifyStrengthVal: document.getElementById("liquifyStrengthVal"),
  menuReference: document.getElementById("menuReference"),
  menuResetBrushRack: document.getElementById("menuResetBrushRack"),
  menuForcePwaReset: document.getElementById("menuForcePwaReset"),
  referencePanel: document.getElementById("referencePanel"),
  referencePanelHead: document.getElementById("referencePanelHead"),
  referencePanelClose: document.getElementById("referencePanelClose"),
  referenceBody: document.getElementById("referenceBody"),
  referenceCanvas: document.getElementById("referenceCanvas"),
  referenceEmpty: document.getElementById("referenceEmpty"),
  referenceLoadBtn: document.getElementById("referenceLoadBtn"),
  referenceLiveBtn: document.getElementById("referenceLiveBtn"),
  referenceFitBtn: document.getElementById("referenceFitBtn"),
  referenceFileInput: document.getElementById("referenceFileInput"),
  galleryFull: document.getElementById("galleryFull"),
  galleryCloseBtn: document.getElementById("galleryCloseBtn"),
  galleryGrid: document.getElementById("galleryGrid"),
  galleryEmpty: document.getElementById("galleryEmpty"),
  galleryAddBtn: document.getElementById("galleryAddBtn"),
  galleryAddPopup: document.getElementById("galleryAddPopup"),
  addNew: document.getElementById("addNew"),
  addImportPhoto: document.getElementById("addImportPhoto"),
  addImportClipboard: document.getElementById("addImportClipboard"),
  cloudIconBtn: document.getElementById("cloudIconBtn"),
  cloudAccountPopup: document.getElementById("cloudAccountPopup"),
  cloudAccountInfo: document.getElementById("cloudAccountInfo"),
  cloudSignInBtn: document.getElementById("cloudSignInBtn"),
  cloudSignOutBtn: document.getElementById("cloudSignOutBtn"),
  cloudRefreshBtn: document.getElementById("cloudRefreshBtn"),
  galleryFootUsage: document.getElementById("galleryFootUsage"),
  newDocBackdrop: document.getElementById("newDocBackdrop"),
  newDocSheet: document.getElementById("newDocSheet"),
  newDocName: document.getElementById("newDocName"),
  newDocPreset: document.getElementById("newDocPreset"),
  newDocCustomRow: document.getElementById("newDocCustomRow"),
  newDocW: document.getElementById("newDocW"),
  newDocH: document.getElementById("newDocH"),
  newDocConfirm: document.getElementById("newDocConfirm"),
  newDocCancel: document.getElementById("newDocCancel"),
  menuRename: document.getElementById("menuRename"),
  menuCheckerboard: document.getElementById("menuCheckerboard"),
  menuCheckUpdate: document.getElementById("menuCheckUpdate"),
  oraFileInput: document.getElementById("oraFileInput"),
  genericBackdrop: document.getElementById("genericBackdrop"),
  genericSheet: document.getElementById("genericSheet"),
  genericSheetTitle: document.getElementById("genericSheetTitle"),
  genericSheetMessage: document.getElementById("genericSheetMessage"),
  genericSheetInput: document.getElementById("genericSheetInput"),
  genericSheetConfirm: document.getElementById("genericSheetConfirm"),
  genericSheetCancel: document.getElementById("genericSheetCancel"),
  toolBtns: [...document.querySelectorAll(".tool[data-tool]")],
  activeSwatch: document.getElementById("activeSwatch"),
  // 浮动色板
  colorPanel: document.getElementById("colorPanel"),
  colorPanelHead: document.getElementById("colorPanelHead"),
  colorPanelClose: document.getElementById("colorPanelClose"),
  svPad: document.getElementById("svPad"),
  hueSlider: document.getElementById("hueSlider"),
  hexInput: document.getElementById("hexInput"),
  previewSwatch: document.getElementById("previewSwatch"),
  // clear sheet
  clearSheet: document.getElementById("clearSheet"),
  clearBackdrop: document.getElementById("clearBackdrop"),
  // update toast
  updateToast: document.getElementById("updateToast"),
  updateReload: document.getElementById("updateToastReload"),
  updateDismiss: document.getElementById("updateToastDismiss")
};
function safeLS(key, fallback) {
  try {
    return localStorage.getItem(key);
  } catch {
    return fallback;
  }
}
function safeLSSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
  }
}
if (navigator.maxTouchPoints > 0) {
  document.body.dataset.inputTouchscreen = "1";
}
var doc = new PaintDoc({ width: 2048, height: 2048 });
var board = new Board(els.board, doc);
els.canvasSizeLabel.textContent = `${doc.width}\xD7${doc.height}`;
els.versionLabel.textContent = WEBPAINT_VERSION || "?";
var state = {
  tool: "brush",
  color: safeLS("webpaint.color") || "#1b1b1b",
  brush: new BrushSettings({
    size: parseFloat(safeLS("webpaint.size") || "12"),
    opacity: parseFloat(safeLS("webpaint.opacity") || "1"),
    color: safeLS("webpaint.color") || "#1b1b1b"
    // v109：smooth 字段 per-preset，删 LS load。applyBrushPresetFrozen 会覆盖
  }),
  longPressPick: safeLS("webpaint.longPressPick") === "1",
  // 默认关，user 担心误触
  checkerboard: safeLS("webpaint.checkerboard") === "1",
  // 默认关；开后用半透明灰白格替代纯背景
  // 液化设置（独立于 brush，见 src/liquify.js + docs/artist-priorities.md v46）
  liquify: {
    mode: safeLS("webpaint.liquify.mode") || "push",
    size: parseFloat(safeLS("webpaint.liquify.size") || "60"),
    strength: parseFloat(safeLS("webpaint.liquify.strength") || "0.4")
  }
};
function syncBrushColor() {
  state.brush.color = state.color;
}
syncBrushColor();
var _brushRack = null;
var RACK_META_KEY = "brush-rack";
function defaultToolStateFor(tool) {
  if (_brushRack) {
    const brush = getActiveBrush(_brushRack, tool);
    if (brush) {
      return {
        size: brush.size.base,
        opacity: 1,
        flow: 1,
        activeBrushId: brush.id
      };
    }
  }
  return { size: 12, opacity: 1, flow: 1, activeBrushId: null };
}
state.toolStates = {
  brush: { size: 12, opacity: 1, flow: 1, activeBrushId: null },
  smudge: { size: 16, opacity: 1, flow: 0.8, activeBrushId: null },
  eraser: { size: 32, opacity: 0.6, flow: 1, activeBrushId: null }
};
function getRackToolKey(tool) {
  return tool === "airbrush" ? "brush" : tool;
}
async function loadBrushRack() {
  try {
    const stored = await getMeta(RACK_META_KEY);
    if (stored && Array.isArray(stored.brushes) && stored.brushes.length > 0) {
      let migrated = false;
      for (const b of stored.brushes) {
        const before = JSON.stringify(b);
        migrateBrush(b);
        if (JSON.stringify(b) !== before) migrated = true;
      }
      const merged = mergeMissingDefaults(stored);
      if (migrated || merged) {
        try {
          await setMeta(RACK_META_KEY, stored);
        } catch (_) {
        }
      }
      return stored;
    }
  } catch (e) {
    console.warn("[brush-rack] load failed:", e);
  }
  const rack = makeDefaultRack();
  try {
    await setMeta(RACK_META_KEY, rack);
  } catch (e) {
    console.warn("[brush-rack] save default failed:", e);
  }
  return rack;
}
async function persistBrushRack() {
  if (!_brushRack) return;
  try {
    await setMeta(RACK_META_KEY, _brushRack);
  } catch (e) {
    console.warn("[brush-rack] persist failed:", e);
  }
}
var _sidebarBrushBtn = document.getElementById("leftSidebarBrush");
var _sidebarBrushName = document.getElementById("leftSidebarBrushName");
function updateSidebarBrushIndicator() {
  if (!_brushRack || !_sidebarBrushName) return;
  const tool = state.tool;
  const rackKey = getRackToolKey(tool);
  const ts = state.toolStates[rackKey];
  const brush = ts?.activeBrushId ? findBrush(_brushRack, ts.activeBrushId) : null;
  _sidebarBrushName.textContent = brush ? brush.name : "\u2014";
}
if (_sidebarBrushBtn) {
  let lpTimer = null;
  _sidebarBrushBtn.addEventListener("pointerdown", () => {
    lpTimer = setTimeout(() => {
      lpTimer = null;
      const rackKey = getRackToolKey(state.tool);
      const ts = state.toolStates[rackKey];
      if (ts?.activeBrushId) {
        closeExclusive();
        _openBrushSettings(ts.activeBrushId);
      }
    }, 600);
  });
  const cancelLP = () => {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  };
  _sidebarBrushBtn.addEventListener("pointerup", cancelLP);
  _sidebarBrushBtn.addEventListener("pointerleave", cancelLP);
  _sidebarBrushBtn.addEventListener("pointercancel", cancelLP);
  _sidebarBrushBtn.addEventListener("click", () => {
    const t = state.tool;
    const id = RACK_PANEL_BY_TOOL[t];
    if (id) openExclusive(id);
  });
}
function applyBrushPresetFrozen(brush) {
  if (!brush) return;
  state.brush.shapeKind = brush.shape.kind || "round";
  state.brush.shapeAspect = brush.shape.aspect ?? 1;
  state.brush.shapeRotation = (brush.shape.rotation ?? 0) * Math.PI / 180;
  state.brush.hardness = brush.shape.hardness ?? 1;
  state.brush.taperIn = brush.taper.in ?? 0;
  state.brush.sizeCoeff = brush.sizeCoeff ?? 0.6;
  state.brush.opaCoeff = brush.opaCoeff ?? 0.6;
  state.brush.flowCoeff = brush.flowCoeff ?? 0;
  state.brush.pressureGamma = brush.pressureGamma ?? 1;
  state.brush.pressureLPF = brush.pressureLPF ?? 0;
  state.brush.compositeMode = brush.compositeMode || "wash";
  state.brush.spacing = typeof brush.spacing === "number" ? brush.spacing : brush.spacing?.value ?? 0.06;
  state.brush.pixelMode = !!brush.pixelMode;
  const sm = brush.smooth || {};
  state.brush.streamline = sm.streamline ?? 0.3;
  state.brush.stabilization = sm.stabilization ?? 0;
  state.brush.pullStabilizer = sm.pullStabilizer ?? 0;
  state.brush.motionFilter = sm.motionFilter ?? 0;
  if (brush.smudge) {
    state.brush.smudgeStrength = brush.smudge.strength ?? 0.8;
    state.brush.smudgeDryness = brush.smudge.dryness ?? 0.1;
  }
  if (input?.brush?.invalidateStamp) input.brush.invalidateStamp();
}
function applyToolState(tool) {
  if (!_brushRack) return;
  const key = getRackToolKey(tool);
  const ts = state.toolStates[key];
  if (!ts) return;
  if (ts.activeBrushId == null) {
    Object.assign(ts, defaultToolStateFor(key));
  }
  const brush = ts.activeBrushId ? findBrush(_brushRack, ts.activeBrushId) : null;
  if (brush) applyBrushPresetFrozen(brush);
  state.brush.size = ts.size;
  state.brush.opacity = ts.opacity ?? 1;
  state.brush.flow = ts.flow ?? 1;
  if (els.sizeSlider) {
    const sliderMax = brush?.size?.max || 200;
    els.sizeSlider.max = "100";
    els.sizeSlider.min = "0";
    els.sizeSlider.step = "1";
    els.sizeSlider.value = String(sizeToSliderPos(ts.size, sliderMax));
    els.sizeSlider.dataset.maxPx = String(sliderMax);
  }
  if (els.opacitySlider) {
    els.opacitySlider.value = String(Math.round((ts.opacity ?? 1) * 100));
  }
  updateSidebarBrushIndicator();
  updateSidebarSlider2Label();
}
function sliderPosToSize(pos, maxPx) {
  const t = Math.max(0, Math.min(100, pos)) / 100;
  return Math.max(1, Math.round(Math.exp(t * Math.log(Math.max(2, maxPx)))));
}
function sizeToSliderPos(size, maxPx) {
  const t = Math.log(Math.max(1, size)) / Math.log(Math.max(2, maxPx));
  return Math.round(Math.max(0, Math.min(1, t)) * 100);
}
function updateSidebarSlider2Label() {
}
function writeCurrentToolSize(v) {
  const ts = state.toolStates[getRackToolKey(state.tool)];
  if (ts) ts.size = v;
}
function writeCurrentToolOpacity(v) {
  const ts = state.toolStates[getRackToolKey(state.tool)];
  if (ts) ts.opacity = v;
}
function selectBrushPresetForTool(tool, brushId) {
  const key = getRackToolKey(tool);
  const ts = state.toolStates[key];
  if (!ts) return;
  const brush = findBrush(_brushRack, brushId);
  if (!brush) return;
  ts.activeBrushId = brushId;
  ts.size = brush.size.base;
  ts.opacity = brush.defaultOpa ?? 1;
  ts.flow = 1;
  if (key === getRackToolKey(state.tool)) applyToolState(state.tool);
}
var history = new UndoStack({ max: 50 });
var input = new InputController(board, doc, {
  getTool: () => state.tool,
  getBrushSettings: () => state.brush,
  getLiquifySettings: () => state.liquify,
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex) => setColor(hex),
  status: setStatus,
  history
});
var _suppressedDuringTransient = [];
function _suppressTransientPanels(mode) {
  const allow = {
    transform: ["referencePanel", "layersPanel"],
    // transform 时还要看引用图 / 切活动层
    crop: ["referencePanel"],
    "adjust-color": ["referencePanel", "layersPanel"]
  };
  const allowList = allow[mode] || [];
  const candidates = ["colorPanel", "paletteWindow", "referencePanel", "layersPanel", "liquifyPanel"];
  _restoreTransientPanels();
  for (const id of candidates) {
    if (allowList.includes(id)) continue;
    const el = document.getElementById(id);
    if (!el || el.classList.contains("hidden")) continue;
    _suppressedDuringTransient.push({ el, id });
    el.classList.add("hidden");
  }
  try {
    closeExclusive();
  } catch {
  }
}
function _restoreTransientPanels() {
  for (const { el } of _suppressedDuringTransient) {
    el.classList.remove("hidden");
  }
  _suppressedDuringTransient = [];
}
var _panelTopZ = 15;
function _bringPanelTop(el) {
  if (!el) return;
  _panelTopZ++;
  el.style.zIndex = _panelTopZ;
}
(function bindPanelZOrder() {
  const panels = [
    "colorPanel",
    "paletteWindow",
    "referencePanel",
    "adjustPanel",
    "liquifyPanel"
  ];
  for (const id of panels) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("pointerdown", () => _bringPanelTop(el), true);
  }
})();
window.addEventListener("pointercancel", () => input.cancelAllPointers(), true);
window.addEventListener("blur", () => input.cancelAllPointers());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") input.cancelAllPointers();
});
board.setOverlayProvider(() => input.brush.getLiveOverlay());
board.setLassoProvider(() => ({
  selection: doc.selection,
  drawingPath: input.lasso.getDrawingPath(),
  drawingRect: input.lasso.getDrawingRect(),
  drawingEllipse: input.lasso.getDrawingEllipse(),
  floating: input.lasso.getFloating(),
  handles: input.lasso.visibleHandles(board.viewport.scale),
  sampleMode: input.lasso.getSampleMode()
}));
var lassoToolbarStack = document.getElementById("lassoToolbarStack");
var lassoToolbarRow1 = document.getElementById("lassoToolbarRow1");
var lassoToolbarRow2 = document.getElementById("lassoToolbarRow2");
var lassoSubToolBar = document.getElementById("lassoSubToolBar");
var lassoSelectionActions = document.getElementById("lassoSelectionActions");
var lassoTransformCtrl = document.getElementById("lassoTransformCtrl");
var lassoSubBtns = [...lassoSubToolBar.querySelectorAll("[data-lasso-sub]")];
var lassoSetOpBtns = [...lassoSubToolBar.querySelectorAll("[data-lasso-setop]")];
var lassoTransformModeBtns = [...lassoTransformCtrl.querySelectorAll("[data-lasso-mode]")];
var lassoThresholdInput = document.getElementById("lassoThreshold");
var lassoThresholdVal = document.getElementById("lassoThresholdVal");
var lassoMagicCfgBtn = document.getElementById("lassoMagicCfgBtn");
var lassoMagicPopup = document.getElementById("lassoMagicPopup");
var lassoConstrainBtn = document.getElementById("lassoConstrainBtn");
var lassoConstrainSep = document.querySelector(".lasso-constrain-sep");
function updateLassoToolbar() {
  const floating = input.lasso.hasFloating();
  const hasSelection = !!doc.selection;
  const lassoActive = state.tool === "lasso";
  const showAny = floating || hasSelection || lassoActive;
  lassoToolbarStack.classList.toggle("hidden", !showAny);
  if (!showAny) return;
  const showRow1 = lassoActive && !floating;
  lassoToolbarRow1.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("hidden", !showRow1);
  const showSelectionActions = hasSelection && !floating;
  const showTransformCtrl = floating;
  const showRow2 = showSelectionActions || showTransformCtrl;
  lassoToolbarRow2.classList.toggle("hidden", !showRow2);
  lassoSelectionActions.classList.toggle("hidden", !showSelectionActions);
  lassoTransformCtrl.classList.toggle("hidden", !showTransformCtrl);
  const sub2 = input.lasso.getSubTool();
  for (const b of lassoSubBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSub === sub2 ? "true" : "false");
  }
  lassoMagicCfgBtn.classList.toggle("hidden", sub2 !== "magic");
  if (sub2 !== "magic") lassoMagicPopup.classList.add("hidden");
  const showConstrain = sub2 === "rect" || sub2 === "ellipse";
  lassoConstrainBtn.classList.toggle("hidden", !showConstrain);
  lassoConstrainSep.classList.toggle("hidden", !showConstrain);
  if (showConstrain) {
    lassoConstrainBtn.setAttribute("aria-pressed", input.lasso.getConstrainSquare() ? "true" : "false");
  }
  const setOp = input.lasso.getSetOpMode();
  for (const b of lassoSetOpBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSetop === setOp ? "true" : "false");
  }
  if (floating) {
    const mode = input.lasso.getMode();
    for (const b of lassoTransformModeBtns) {
      b.setAttribute("aria-pressed", b.dataset.lassoMode === mode ? "true" : "false");
    }
    const sm = input.lasso.getSampleMode();
    const sel = document.getElementById("lassoSampleSel");
    if (sel && sel.value !== sm) sel.value = sm;
  }
}
for (const b of lassoSubBtns) {
  b.addEventListener("click", () => {
    input.lasso.setSubTool(b.dataset.lassoSub);
    updateLassoToolbar();
  });
}
for (const b of lassoSetOpBtns) {
  b.addEventListener("click", () => {
    input.lasso.setSetOpMode(b.dataset.lassoSetop);
    updateLassoToolbar();
  });
}
lassoThresholdInput.addEventListener("input", () => {
  const v = parseInt(lassoThresholdInput.value, 10) || 0;
  input.lasso.setMagicThreshold(v);
  lassoThresholdVal.textContent = String(v);
});
function toggleMagicPopup(e) {
  e.stopPropagation();
  lassoMagicPopup.classList.toggle("hidden");
}
lassoMagicCfgBtn.addEventListener("click", toggleMagicPopup);
document.addEventListener("pointerdown", (e) => {
  if (lassoMagicPopup.classList.contains("hidden")) return;
  if (lassoMagicPopup.contains(e.target)) return;
  if (lassoMagicCfgBtn.contains(e.target)) return;
  lassoMagicPopup.classList.add("hidden");
});
lassoConstrainBtn.addEventListener("click", () => {
  input.lasso.setConstrainSquare(!input.lasso.getConstrainSquare());
  updateLassoToolbar();
});
document.getElementById("lassoTransformBtn").addEventListener("click", () => {
  if (!doc.selection) return;
  const ok = input.lasso.liftSelectionForTransform(doc.activeLayer);
  if (ok) {
    updateLassoToolbar();
    _suppressTransientPanels("transform");
  }
});
document.getElementById("lassoDeselectBtn").addEventListener("click", () => {
  const entry = input.lasso.setSelection(null);
  if (entry && history) history.push(entry);
  board.invalidateAll();
  updateLassoToolbar();
});
document.getElementById("lassoFillBtn").addEventListener("click", () => {
  const layer = doc.activeLayer;
  if (!layer || !doc.selection) return;
  const before = layer.snapshot();
  fillSelectionOnLayer(layer, doc.selection, state.color);
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => {
    entry.beforeBlob = blob;
  });
  compressPixelSnap(entry.after, (blob) => {
    entry.afterBlob = blob;
  });
  board.invalidateAll();
  setStatus(`\u5DF2\u586B\u8272\uFF1A${state.color}`);
});
document.getElementById("lassoClearBtn").addEventListener("click", () => {
  const layer = doc.activeLayer;
  if (!layer || !doc.selection) return;
  const before = layer.snapshot();
  clearSelectionOnLayer(layer, doc.selection);
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => {
    entry.beforeBlob = blob;
  });
  compressPixelSnap(entry.after, (blob) => {
    entry.afterBlob = blob;
  });
  board.invalidateAll();
  setStatus("\u5DF2\u6E05\u9664\u9009\u533A\u5185\u50CF\u7D20");
});
document.getElementById("lassoSelectAllBtn").addEventListener("click", () => {
  const w = doc.width, h = doc.height;
  const mask = document.createElement("canvas");
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#fff";
  mctx.fillRect(0, 0, w, h);
  const sel = { bboxX: 0, bboxY: 0, bboxW: w, bboxH: h, maskCanvas: mask };
  const entry = input.lasso.setSelection(sel);
  if (entry && history) history.push(entry);
  board.invalidateAll();
  updateLassoToolbar();
});
document.getElementById("lassoInvertBtn").addEventListener("click", () => {
  const inv = invertSelection(doc.selection, doc.width, doc.height);
  const entry = input.lasso.setSelection(inv);
  if (entry && history) history.push(entry);
  board.invalidateAll();
  updateLassoToolbar();
});
for (const b of lassoTransformModeBtns) {
  b.addEventListener("click", () => {
    input.lasso.setMode(b.dataset.lassoMode);
    updateLassoToolbar();
  });
}
document.getElementById("lassoCommitBtn").addEventListener("click", () => {
  input.commitLassoIfFloating();
  updateLassoToolbar();
  _restoreTransientPanels();
});
document.getElementById("lassoCancelBtn").addEventListener("click", () => {
  if (input.lasso.hasFloating()) {
    input.lasso.cancel();
    board.invalidateAll();
    updateLassoToolbar();
  }
  _restoreTransientPanels();
});
document.getElementById("lassoStampBtn").addEventListener("click", () => {
  if (!input.lasso.hasFloating()) return;
  if (input.lasso.stamp()) {
    board.invalidateAll();
    setStatus("\u5DF2\u76D6\u5370");
  }
});
var lassoSampleSel = document.getElementById("lassoSampleSel");
if (lassoSampleSel) {
  lassoSampleSel.addEventListener("change", () => {
    input.lasso.setSampleMode(lassoSampleSel.value);
    board.invalidateAll();
    updateLassoToolbar();
  });
}
document.getElementById("lassoDuplicateBtn").addEventListener("click", () => {
  selectionToNewLayer({ move: false });
});
document.getElementById("lassoMoveToLayerBtn").addEventListener("click", () => {
  selectionToNewLayer({ move: true });
});
function selectionToNewLayer({ move }) {
  const sel = doc.selection;
  if (!sel) {
    setStatus("\u6CA1\u9009\u533A");
    return;
  }
  if (doc.layers.length >= doc.maxLayers) {
    setStatus(`\u56FE\u5C42\u6570\u5DF2\u8FBE\u4E0A\u9650 ${doc.maxLayers}`);
    return;
  }
  const src = doc.activeLayer;
  if (!src) return;
  const beforeActive = move ? src.snapshot() : null;
  const newL = doc.addLayer(move ? "\u79FB\u5230\u65B0\u5C42" : "\u590D\u5236\u5C42");
  if (!newL) return;
  newL.bboxX = sel.bboxX;
  newL.bboxY = sel.bboxY;
  newL.bboxW = sel.bboxW;
  newL.bboxH = sel.bboxH;
  newL.canvas.width = sel.bboxW;
  newL.canvas.height = sel.bboxH;
  newL.ctx = newL.canvas.getContext("2d", { willReadFrequently: false });
  newL.ctx.imageSmoothingEnabled = true;
  newL.ctx.imageSmoothingQuality = "low";
  newL.ctx.drawImage(src.canvas, src.bboxX - sel.bboxX, src.bboxY - sel.bboxY);
  newL.ctx.globalCompositeOperation = "destination-in";
  newL.ctx.drawImage(sel.maskCanvas, 0, 0);
  newL.ctx.globalCompositeOperation = "source-over";
  if (move) {
    src.ctx.save();
    src.ctx.globalCompositeOperation = "destination-out";
    src.ctx.drawImage(sel.maskCanvas, sel.bboxX - src.bboxX, sel.bboxY - src.bboxY);
    src.ctx.restore();
  }
  const insertIndex = doc.layers.findIndex((l) => l.id === newL.id);
  const newLayerSpec = layerSpecFrom(newL);
  const afterActive = move ? src.snapshot() : null;
  history.push({
    type: "selectionToLayer",
    isMove: move,
    newLayerSpec,
    insertIndex,
    activeLayerId: src.id,
    beforeActive,
    afterActive
  });
  compressPixelSnap(newLayerSpec, (blob) => {
    newLayerSpec.blob = blob;
  });
  if (move && beforeActive) compressPixelSnap(beforeActive, (blob) => {
    beforeActive.blob = blob;
  });
  if (move && afterActive) compressPixelSnap(afterActive, (blob) => {
    afterActive.blob = blob;
  });
  _afterDocChange();
  setStatus(move ? "\u5DF2\u79FB\u5230\u65B0\u5C42" : "\u5DF2\u590D\u5236\u5230\u65B0\u5C42");
}
window.addEventListener("wp:lassochange", updateLassoToolbar);
window.addEventListener("wp:histchange", updateLassoToolbar);
function readCssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({ voidColor: readCssColor("--void") });
}
var theme = safeLS("webpaint.theme") || "auto";
if (!THEMES.includes(theme)) theme = "auto";
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  safeLSSet("webpaint.theme", t);
  els.menuTheme.querySelector('[data-state-for="theme"]').textContent = THEME_LABEL[t];
  requestAnimationFrame(applyThemeColorsToBoard);
}
applyTheme(theme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
});
var _pendingTransients = [];
function registerPendingTransient({ check, apply, label }) {
  _pendingTransients.push({ check, apply, label });
}
function hasAnyPendingTransient() {
  return _pendingTransients.some((p) => {
    try {
      return p.check();
    } catch {
      return false;
    }
  });
}
function applyAllPendingTransients() {
  for (const p of _pendingTransients) {
    try {
      if (p.check()) p.apply();
    } catch (e) {
      console.warn(`[pending] ${p.label} apply failed:`, e);
    }
  }
  _restoreTransientPanels?.();
}
registerPendingTransient({
  label: "lasso-floating",
  check: () => input.lasso.hasFloating(),
  apply: () => input.commitLassoIfFloating()
});
function setTool(t) {
  if (t === "airbrush") t = "brush";
  if (t === "shapes") t = "brush";
  if (t === "smudge") {
    setStatus("\u6D82\u62B9 \u5DE5\u5177\u6682\u672A\u542F\u7528");
    return;
  }
  applyAllPendingTransients();
  state.tool = t;
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false");
  els.topAdjustBtn.setAttribute("aria-pressed", t === "liquify" ? "true" : "false");
  document.body.dataset.tool = t;
  updateLassoToolbar();
  if (t === "brush" || t === "smudge" || t === "eraser") {
    applyToolState(t);
  }
  if (t === "smudge") {
    setStatus("smudge engine \u5F85\u5B9E\u88C5\uFF1B\u73B0\u5728\u6309 brush \u8D70");
  }
}
var RACK_PANEL_BY_TOOL = {
  brush: PANELS.RACK_BRUSH,
  smudge: PANELS.RACK_SMUDGE,
  eraser: PANELS.RACK_ERASER
};
for (const b of els.toolBtns) {
  b.addEventListener("click", () => {
    const t = b.dataset.tool;
    if (state.tool === t && RACK_PANEL_BY_TOOL[t]) {
      openExclusive(RACK_PANEL_BY_TOOL[t]);
      return;
    }
    setTool(t);
    closeExclusive();
  });
}
window.addEventListener("wp:settool", (e) => setTool(e.detail));
window.addEventListener("wp:doubletap", () => {
  if (input.lasso.hasFloating()) {
    setStatus("\u5957\u7D22\u6D6E\u5C42\u8FDB\u884C\u4E2D\uFF0C\u53CC\u51FB\u5207\u6362\u6682\u505C\uFF08\u70B9\u5E94\u7528 / \u53D6\u6D88 / \u8FD4\u56DE\u5DE5\u5177\u680F\uFF09");
    return;
  }
  const next = state.tool === "eraser" ? "brush" : "eraser";
  setTool(next);
  setStatus(`\u53CC\u51FB \xB7 ${next === "eraser" ? "\u6A61\u76AE" : "\u7B14\u5237"}`);
});
setTool(state.tool);
loadBrushRack().then((rack) => {
  _brushRack = rack;
  for (const t of Object.keys(state.toolStates)) {
    if (state.toolStates[t].activeBrushId == null) {
      const init = defaultToolStateFor(t);
      Object.assign(state.toolStates[t], init);
    }
  }
  applyToolState(state.tool);
  updateSidebarBrushIndicator();
  setTimeout(() => {
    checkBrushRackCloud().catch(() => {
    });
  }, 2e3);
}).catch((e) => {
  console.warn("[brush-rack] init failed:", e);
  _brushRack = makeDefaultRack();
  applyToolState(state.tool);
  updateSidebarBrushIndicator();
  setStatus("\u7B14\u67B6\u6301\u4E45\u5316\u5931\u8D25\uFF08\u53EF\u80FD\u79C1\u5BC6\u6D4F\u89C8\uFF09\uFF1A\u672C\u6B21 session \u53EF\u7528\uFF0C\u91CD\u542F\u4F1A\u91CD\u7F6E", true);
});
var _suppressPickerSync = false;
function setColor(hex) {
  state.color = hex;
  safeLSSet("webpaint.color", hex);
  els.activeSwatch.style.background = hex;
  syncBrushColor();
  if (!_suppressPickerSync && !els.colorPanel.classList.contains("hidden")) {
    pickerSetFromHex(hex);
  }
}
els.activeSwatch.addEventListener("click", () => toggleColorPanel());
setColor(state.color);
var _sizePopupTimer = null;
function showSizePopup(px) {
  if (!els.sizePopup) return;
  const zoom = board?.viewport?.scale ?? 1;
  const screenPx = px * zoom;
  const FRAME = 120;
  const r = Math.max(2, screenPx / 2);
  els.sizePopupCircle.style.width = r * 2 + "px";
  els.sizePopupCircle.style.height = r * 2 + "px";
  if (Math.abs(zoom - 1) < 5e-3) {
    els.sizePopupText.textContent = `${px | 0} px`;
  } else {
    els.sizePopupText.textContent = `${px | 0} px (\u5C4F ${Math.round(screenPx)})`;
  }
  const rect = els.sizeSlider.getBoundingClientRect();
  els.sizePopup.style.left = rect.right + 12 + "px";
  els.sizePopup.style.top = rect.top + rect.height / 2 - FRAME / 2 + "px";
  els.sizePopup.classList.remove("hidden");
  clearTimeout(_sizePopupTimer);
  _sizePopupTimer = setTimeout(() => els.sizePopup.classList.add("hidden"), 1500);
}
function setSize(v) {
  v = Math.max(1, Math.round(v));
  state.brush.size = v;
  writeCurrentToolSize(v);
  safeLSSet("webpaint.size", String(v));
  const maxPx = parseInt(els.sizeSlider.dataset.maxPx, 10) || 200;
  els.sizeSlider.value = String(sizeToSliderPos(v, maxPx));
  showSizePopup(v);
}
function setOpacity(v) {
  state.brush.opacity = v;
  writeCurrentToolOpacity(v);
  safeLSSet("webpaint.opacity", String(v));
  els.opacitySlider.value = String(Math.round(v * 100));
}
els.sizeSlider.addEventListener("input", () => {
  const pos = parseFloat(els.sizeSlider.value);
  const maxPx = parseInt(els.sizeSlider.dataset.maxPx, 10) || 200;
  const px = sliderPosToSize(pos, maxPx);
  state.brush.size = px;
  writeCurrentToolSize(px);
  safeLSSet("webpaint.size", String(px));
  showSizePopup(px);
});
els.opacitySlider.addEventListener("input", () => setOpacity(parseFloat(els.opacitySlider.value) / 100));
els.sizeSlider.dataset.maxPx = "200";
setSize(state.brush.size);
setOpacity(state.brush.opacity);
window.addEventListener("wp:adjsize", (e) => {
  const delta = e.detail;
  setSize(Math.max(1, Math.min(200, state.brush.size + delta)));
  setStatus(`\u7B14\u7C97 ${state.brush.size}px`);
});
function setMenuItem(btn, on, stateLabel = on ? "\u5F00" : "\u5173") {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const st = btn.querySelector(".menu-item-state");
  if (st) st.textContent = stateLabel;
}
function applyPressureSize(on) {
  state.brush.pressureToSize = !!on;
  setMenuItem(els.menuPressureSize, on);
  safeLSSet("webpaint.pToSize", on ? "1" : "0");
}
function applyPressureOpacity(on) {
  state.brush.pressureToOpacity = !!on;
  setMenuItem(els.menuPressureOpacity, on);
  safeLSSet("webpaint.pToOpacity", on ? "1" : "0");
}
function applyLongPressPick(on) {
  state.longPressPick = !!on;
  setMenuItem(els.menuLongPressPick, on);
  safeLSSet("webpaint.longPressPick", on ? "1" : "0");
}
function applyCheckerboard(on) {
  state.checkerboard = !!on;
  setMenuItem(els.menuCheckerboard, on);
  safeLSSet("webpaint.checkerboard", on ? "1" : "0");
  board.setShowCheckerboard?.(!!on);
  board.invalidateAll();
  board.requestRender();
}
els.menuPressureSize.addEventListener("click", () => {
  applyPressureSize(!state.brush.pressureToSize);
  setStatus(`\u538B\xB7\u7C97 \xB7 ${state.brush.pressureToSize ? "\u5F00" : "\u5173"}`);
});
els.menuPressureOpacity.addEventListener("click", () => {
  applyPressureOpacity(!state.brush.pressureToOpacity);
  setStatus(`\u538B\xB7\u900F \xB7 ${state.brush.pressureToOpacity ? "\u5F00" : "\u5173"}`);
});
els.menuLongPressPick.addEventListener("click", () => {
  applyLongPressPick(!state.longPressPick);
  setStatus(`\u957F\u6309\u5438\u8272 \xB7 ${state.longPressPick ? "\u5F00" : "\u5173"}`);
});
els.menuCheckerboard.addEventListener("click", () => {
  applyCheckerboard(!state.checkerboard);
  setStatus(`\u900F\u660E\u68CB\u76D8 \xB7 ${state.checkerboard ? "\u5F00" : "\u5173"}`);
});
els.menuTheme.addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(next);
  setStatus(`\u4E3B\u9898 \xB7 ${THEME_LABEL[next]}`);
});
if (els.menuCheckUpdate) els.menuCheckUpdate.addEventListener("click", () => setMenuOpen(false));
els.menuClear.addEventListener("click", () => {
  setMenuOpen(false);
  openSheet(els.clearSheet, els.clearBackdrop);
});
applyPressureSize(state.brush.pressureToSize);
applyPressureOpacity(state.brush.pressureToOpacity);
applyLongPressPick(state.longPressPick);
applyCheckerboard(state.checkerboard);
function setMenuOpen(open) {
  els.menuPanel.classList.toggle("hidden", !open);
  els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
els.menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen(els.menuPanel.classList.contains("hidden"));
});
document.addEventListener("pointerdown", (e) => {
  if (els.menuPanel.classList.contains("hidden")) return;
  if (els.menuPanel.contains(e.target) || els.menuBtn.contains(e.target)) return;
  setMenuOpen(false);
});
els.undoBtn.addEventListener("click", () => input.undo());
els.redoBtn.addEventListener("click", () => input.redo());
window.addEventListener("wp:histchange", (e) => {
  els.undoBtn.disabled = !e.detail.canUndo;
  els.redoBtn.disabled = !e.detail.canRedo;
});
els.undoBtn.disabled = true;
els.redoBtn.disabled = true;
function openSheet(sheet, backdrop) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet, backdrop) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}
els.clearBackdrop.addEventListener("click", () => closeSheet(els.clearSheet, els.clearBackdrop));
els.clearSheet.addEventListener("click", (e) => {
  const a = e.target.closest("[data-clear]")?.dataset.clear;
  if (!a) return;
  closeSheet(els.clearSheet, els.clearBackdrop);
  if (a !== "confirm") return;
  const layer = doc.activeLayer;
  if (!layer) return;
  const before = layer.snapshot();
  doc.clearActiveLayer();
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => {
    entry.beforeBlob = blob;
  });
  compressPixelSnap(entry.after, (blob) => {
    entry.afterBlob = blob;
  });
  board.invalidateAll();
  setStatus("\u5DF2\u6E05\u7A7A\u5F53\u524D\u56FE\u5C42\uFF08Ctrl+Z \u64A4\u9500\uFF09");
});
function updateZoomLabel() {
  els.zoomLabel.textContent = Math.round(board.viewport.scale * 100) + "%";
}
var statusTimer = null;
function setStatus(text, persist = false) {
  els.statusLabel.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  if (!persist) {
    statusTimer = setTimeout(() => {
      els.statusLabel.textContent = "\u5C31\u7EEA";
    }, 1800);
  }
}
function updateNewerBanner() {
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    document.body.dataset.docNewer = "1";
  } else {
    delete document.body.dataset.docNewer;
  }
}
var origRender = board.render.bind(board);
board.render = function() {
  origRender();
  updateZoomLabel();
};
var pickerHsv = { h: 0, s: 0, v: 0.1 };
function toggleColorPanel(force) {
  const hidden = els.colorPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  if (show) {
    pickerSetFromHex(state.color);
    els.colorPanel.classList.remove("hidden");
    const saved = safeLS("webpaint.colorPanel.pos");
    const w = els.colorPanel.offsetWidth || 264;
    const h = els.colorPanel.offsetHeight || 320;
    let left, top;
    if (saved) {
      try {
        const o = JSON.parse(saved);
        left = o.left;
        top = o.top;
      } catch {
        left = top = null;
      }
    }
    if (left == null) {
      left = window.innerWidth - w - 16;
      top = 60;
    }
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
    drawSvPad();
  } else {
    els.colorPanel.classList.add("hidden");
  }
}
els.colorPanelClose.addEventListener("click", () => toggleColorPanel(false));
var _panelDrag = null;
els.colorPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".close-x")) return;
  const r = els.colorPanel.getBoundingClientRect();
  _panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.colorPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.colorPanelHead.addEventListener("pointermove", (e) => {
  if (!_panelDrag || e.pointerId !== _panelDrag.id) return;
  const w = els.colorPanel.offsetWidth;
  const h = els.colorPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _panelDrag.ol + (e.clientX - _panelDrag.sx)));
  const top = Math.max(0, Math.min(window.innerHeight - h, _panelDrag.ot + (e.clientY - _panelDrag.sy)));
  els.colorPanel.style.left = left + "px";
  els.colorPanel.style.top = top + "px";
  safeLSSet("webpaint.colorPanel.pos", JSON.stringify({ left, top }));
});
els.colorPanelHead.addEventListener("pointerup", (e) => {
  if (_panelDrag && e.pointerId === _panelDrag.id) {
    try {
      els.colorPanelHead.releasePointerCapture(e.pointerId);
    } catch {
    }
    _panelDrag = null;
  }
});
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.key === "c" || e.key === "C") {
    if (!(e.ctrlKey || e.metaKey)) toggleColorPanel();
  }
});
function toggleLayersPanel(force) {
  const hidden = els.layersPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.layersPanel.classList.toggle("hidden", !show);
  els.layersBtn.setAttribute("aria-pressed", show ? "true" : "false");
  if (show) renderLayersPanel();
}
els.layersBtn.addEventListener("click", () => toggleLayersPanel());
els.layersPanelClose.addEventListener("click", () => toggleLayersPanel(false));
var _layersDrag = null;
els.layersPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".float-panel-close")) return;
  const r = els.layersPanel.getBoundingClientRect();
  _layersDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.layersPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.layersPanelHead.addEventListener("pointermove", (e) => {
  if (!_layersDrag || e.pointerId !== _layersDrag.id) return;
  const w = els.layersPanel.offsetWidth;
  const h = els.layersPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _layersDrag.ol + (e.clientX - _layersDrag.sx)));
  const top = Math.max(0, Math.min(window.innerHeight - h, _layersDrag.ot + (e.clientY - _layersDrag.sy)));
  els.layersPanel.style.left = left + "px";
  els.layersPanel.style.right = "auto";
  els.layersPanel.style.top = top + "px";
  safeLSSet("webpaint.layersPanel.pos", JSON.stringify({ left, top }));
});
els.layersPanelHead.addEventListener("pointerup", (e) => {
  if (_layersDrag && e.pointerId === _layersDrag.id) {
    try {
      els.layersPanelHead.releasePointerCapture(e.pointerId);
    } catch {
    }
    _layersDrag = null;
  }
});
(function restoreLayersPanelPos() {
  const saved = safeLS("webpaint.layersPanel.pos");
  if (!saved) return;
  try {
    const o = JSON.parse(saved);
    els.layersPanel.style.left = o.left + "px";
    els.layersPanel.style.right = "auto";
    els.layersPanel.style.top = o.top + "px";
  } catch {
  }
})();
var LAYER_MODE_INITIAL = {
  "source-over": "N",
  "multiply": "M",
  "screen": "S",
  "overlay": "O",
  "darken": "Da",
  "lighten": "Li",
  "color-dodge": "CD",
  "color-burn": "CB",
  "hard-light": "HL",
  "soft-light": "SL",
  "difference": "Df",
  "exclusion": "Ex"
};
var LAYER_MODE_LABEL = {
  "source-over": "\u6B63\u5E38",
  "multiply": "\u6B63\u7247\u53E0\u5E95",
  "screen": "\u6EE4\u8272",
  "overlay": "\u53E0\u52A0",
  "darken": "\u53D8\u6697",
  "lighten": "\u53D8\u4EAE",
  "color-dodge": "\u989C\u8272\u51CF\u6DE1",
  "color-burn": "\u989C\u8272\u52A0\u6DF1",
  "hard-light": "\u5F3A\u5149",
  "soft-light": "\u67D4\u5149",
  "difference": "\u5DEE\u503C",
  "exclusion": "\u6392\u9664"
};
function modeInitial(m) {
  return LAYER_MODE_INITIAL[m] || "?";
}
var _expandedLayerId = null;
function renderLayersPanel() {
  els.layersList.innerHTML = "";
  const max = doc.maxLayers;
  els.layersCountLabel.textContent = `${doc.layers.length} / ${max}`;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    const row = document.createElement("div");
    const isRef = doc.referenceLayerId === L.id;
    row.className = "layer-row" + (i === doc.activeIndex ? " active" : "") + (L.clippingMask ? " clipping" : "") + (isRef ? " reference" : "");
    row.dataset.layerId = String(L.id);
    const vis = document.createElement("button");
    vis.type = "button";
    vis.className = "layer-vis" + (L.visible ? "" : " hidden-icon");
    vis.title = L.visible ? "\u53EF\u89C1" : "\u5DF2\u9690\u85CF";
    vis.innerHTML = L.visible ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.94 18.94 0 0 1 4.06-5.06"/><path d="M1 1l22 22"/></svg>';
    vis.addEventListener("click", (e) => {
      e.stopPropagation();
      const oldVal = L.visible;
      L.visible = !oldVal;
      history.push({ type: "setLayerProp", layerId: L.id, prop: "visible", oldVal, newVal: L.visible });
      renderLayersPanel();
      board.invalidateAll();
      board.requestRender();
    });
    row.appendChild(vis);
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = L.name;
    row.appendChild(name);
    if (L.clippingMask) {
      const chip = document.createElement("span");
      chip.className = "layer-clip-chip";
      chip.textContent = "\u2198";
      chip.title = "\u5DF2\u526A\u88C1\u5230\u4E0B\u65B9\u7B2C\u4E00\u9897\u975E\u526A\u88C1\u5C42";
      row.appendChild(chip);
    }
    if (isRef) {
      const chip = document.createElement("span");
      chip.className = "layer-ref-chip";
      chip.textContent = "\u53C2";
      chip.title = "\u53C2\u8003\u5C42\uFF1A\u9B54\u68D2 / \u6CB9\u6F06\u6876\u8BFB\u8FD9\u4E00\u5C42";
      row.appendChild(chip);
    }
    const tools = document.createElement("button");
    tools.type = "button";
    tools.className = "layer-tools-btn";
    tools.title = "\u56FE\u5C42\u83DC\u5355";
    tools.textContent = "\u22EF";
    tools.addEventListener("click", (e) => {
      e.stopPropagation();
      openLayerToolsMenu(L, tools, name);
    });
    row.appendChild(tools);
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "layer-mode-badge" + (_expandedLayerId === L.id ? " active" : "");
    badge.textContent = modeInitial(L.mode);
    badge.title = `\u4E0D\u900F\u660E\u5EA6 ${Math.round(L.opacity * 100)}% \xB7 \u6A21\u5F0F ${LAYER_MODE_LABEL[L.mode] || L.mode}`;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      _expandedLayerId = _expandedLayerId === L.id ? null : L.id;
      renderLayersPanel();
    });
    row.appendChild(badge);
    row.addEventListener("click", () => {
      doc.setActiveById(L.id);
      renderLayersPanel();
    });
    els.layersList.appendChild(row);
    if (_expandedLayerId === L.id) {
      const expand = document.createElement("div");
      expand.className = "layer-row-expand";
      const opaRow = document.createElement("label");
      opaRow.className = "layer-slider-row";
      opaRow.innerHTML = `<span>\u900F</span><input type="range" min="0" max="100" value="${Math.round(L.opacity * 100)}"><span class="layer-slider-val">${Math.round(L.opacity * 100)}</span>`;
      const opaInput = opaRow.querySelector("input");
      const opaVal = opaRow.querySelector(".layer-slider-val");
      let opaCoalesceOldVal = null;
      opaInput.addEventListener("pointerdown", () => {
        opaCoalesceOldVal = L.opacity;
      });
      opaInput.addEventListener("input", () => {
        const v = parseFloat(opaInput.value) / 100;
        L.opacity = v;
        opaVal.textContent = String(Math.round(v * 100));
        badge.title = `\u4E0D\u900F\u660E\u5EA6 ${Math.round(v * 100)}% \xB7 \u6A21\u5F0F ${LAYER_MODE_LABEL[L.mode] || L.mode}`;
        board.invalidateAll();
        board.requestRender();
      });
      const opaCommit = () => {
        if (opaCoalesceOldVal === null) return;
        if (opaCoalesceOldVal !== L.opacity) {
          history.push({ type: "setLayerProp", layerId: L.id, prop: "opacity", oldVal: opaCoalesceOldVal, newVal: L.opacity });
        }
        opaCoalesceOldVal = null;
      };
      opaInput.addEventListener("pointerup", opaCommit);
      opaInput.addEventListener("pointercancel", opaCommit);
      opaInput.addEventListener("click", (e) => e.stopPropagation());
      expand.appendChild(opaRow);
      const modeRow = document.createElement("label");
      modeRow.className = "layer-slider-row";
      let optsHtml = "";
      for (const [val, lbl] of Object.entries(LAYER_MODE_LABEL)) {
        optsHtml += `<option value="${val}"${L.mode === val ? " selected" : ""}>${lbl}</option>`;
      }
      modeRow.innerHTML = `<span>\u6A21\u5F0F</span><select style="grid-column: span 2;">${optsHtml}</select>`;
      const modeSelect = modeRow.querySelector("select");
      modeSelect.addEventListener("change", () => {
        const oldVal = L.mode;
        const newVal = modeSelect.value;
        L.mode = newVal;
        history.push({ type: "setLayerProp", layerId: L.id, prop: "mode", oldVal, newVal });
        badge.textContent = modeInitial(L.mode);
        badge.title = `\u4E0D\u900F\u660E\u5EA6 ${Math.round(L.opacity * 100)}% \xB7 \u6A21\u5F0F ${LAYER_MODE_LABEL[L.mode] || L.mode}`;
        board.invalidateAll();
        board.requestRender();
      });
      modeSelect.addEventListener("click", (e) => e.stopPropagation());
      expand.appendChild(modeRow);
      const clipRow = document.createElement("div");
      clipRow.className = "layer-slider-row";
      clipRow.innerHTML = `
        <span>\u526A\u88C1</span>
        <span class="layer-clip-hint">\u2198 \u8DDF\u968F\u4E0B\u65B9</span>
        <button type="button" class="layer-clip-toggle" aria-pressed="${L.clippingMask ? "true" : "false"}">${L.clippingMask ? "\u5F00" : "\u5173"}</button>
      `;
      const clipBtn = clipRow.querySelector(".layer-clip-toggle");
      clipBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const oldVal = L.clippingMask;
        L.clippingMask = !oldVal;
        history.push({
          type: "setLayerProp",
          layerId: L.id,
          prop: "clippingMask",
          oldVal,
          newVal: L.clippingMask
        });
        renderLayersPanel();
        board.invalidateAll();
        board.requestRender();
      });
      expand.appendChild(clipRow);
      const refRow = document.createElement("div");
      refRow.className = "layer-slider-row";
      const isRefNow = doc.referenceLayerId === L.id;
      refRow.innerHTML = `
        <span>\u53C2\u8003</span>
        <span class="layer-clip-hint">\u9B54\u68D2 / \u6CB9\u6F06\u6876\u8BFB\u8FD9\u5C42</span>
        <button type="button" class="layer-clip-toggle" aria-pressed="${isRefNow ? "true" : "false"}">${isRefNow ? "\u5F00" : "\u5173"}</button>
      `;
      const refBtn = refRow.querySelector(".layer-clip-toggle");
      refBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const oldVal = doc.referenceLayerId;
        const newVal = isRefNow ? null : L.id;
        doc.referenceLayerId = newVal;
        history.push({ type: "setReferenceLayer", oldVal, newVal });
        renderLayersPanel();
      });
      expand.appendChild(refRow);
      expand.addEventListener("click", (e) => e.stopPropagation());
      els.layersList.appendChild(expand);
    }
  }
  els.layerAddBtn.disabled = doc.layers.length >= max;
  els.layerDelBtn.disabled = doc.layers.length <= 1;
  els.layerUpBtn.disabled = doc.activeIndex >= doc.layers.length - 1;
  els.layerDownBtn.disabled = doc.activeIndex <= 0;
}
function _afterDocChange() {
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
els.layerAddBtn.addEventListener("click", () => {
  if (doc.layers.length >= doc.maxLayers) {
    setStatus(`\u56FE\u5C42\u6570\u5DF2\u8FBE\u4E0A\u9650 ${doc.maxLayers}`);
    return;
  }
  const L = doc.addLayer();
  if (!L) return;
  const insertIndex = doc.layers.findIndex((l) => l.id === L.id);
  const layerSpec = layerSpecFrom(L);
  history.push({ type: "addLayer", index: insertIndex, layerSpec });
  _afterDocChange();
});
els.layerDelBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  if (doc.layers.length <= 1) {
    setStatus("\u81F3\u5C11\u4FDD\u7559\u4E00\u5C42");
    return;
  }
  const index = doc.layers.findIndex((l) => l.id === L.id);
  const layerSpec = layerSpecFrom(L);
  doc.removeLayer(L.id);
  const entry = { type: "removeLayer", index, layerSpec };
  history.push(entry);
  compressPixelSnap(layerSpec, (blob) => {
    layerSpec.blob = blob;
  });
  _afterDocChange();
});
els.layerUpBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  const from = doc.layers.findIndex((l) => l.id === L.id);
  if (!doc.moveLayer(L.id, 1)) return;
  const to = doc.layers.findIndex((l) => l.id === L.id);
  history.push({ type: "moveLayer", layerId: L.id, fromIdx: from, toIdx: to });
  _afterDocChange();
});
els.layerDownBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  const from = doc.layers.findIndex((l) => l.id === L.id);
  if (!doc.moveLayer(L.id, -1)) return;
  const to = doc.layers.findIndex((l) => l.id === L.id);
  history.push({ type: "moveLayer", layerId: L.id, fromIdx: from, toIdx: to });
  _afterDocChange();
});
function _resolveAndClose(resolve, value, cleanup) {
  closeSheet(els.genericSheet, els.genericBackdrop);
  cleanup();
  resolve(value);
}
function openInputSheet(title, defaultValue = "", { placeholder = "" } = {}) {
  return new Promise((resolve) => {
    els.genericSheetTitle.textContent = title;
    els.genericSheetMessage.classList.add("hidden");
    els.genericSheetInput.classList.remove("hidden");
    els.genericSheetInput.value = defaultValue;
    els.genericSheetInput.placeholder = placeholder;
    openSheet(els.genericSheet, els.genericBackdrop);
    setTimeout(() => {
      els.genericSheetInput.focus();
      els.genericSheetInput.select();
    }, 0);
    const onConfirm = () => _resolveAndClose(resolve, els.genericSheetInput.value, cleanup);
    const onCancel = () => _resolveAndClose(resolve, null, cleanup);
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    const cleanup = () => {
      els.genericSheetConfirm.removeEventListener("click", onConfirm);
      els.genericSheetCancel.removeEventListener("click", onCancel);
      els.genericBackdrop.removeEventListener("click", onCancel);
      els.genericSheetInput.removeEventListener("keydown", onKey);
    };
    els.genericSheetConfirm.addEventListener("click", onConfirm);
    els.genericSheetCancel.addEventListener("click", onCancel);
    els.genericBackdrop.addEventListener("click", onCancel);
    els.genericSheetInput.addEventListener("keydown", onKey);
  });
}
var syncGate = {
  backdrop: document.getElementById("syncGateBackdrop"),
  sheet: document.getElementById("syncGateSheet"),
  title: document.getElementById("syncGateTitle"),
  message: document.getElementById("syncGateMessage"),
  spinner: document.getElementById("syncGateSpinner"),
  actions: document.getElementById("syncGateActions")
};
function lockSyncGate({ title, message, showSpinner, actions }) {
  syncGate.title.textContent = title;
  syncGate.message.textContent = message;
  syncGate.spinner.classList.toggle("hidden", !showSpinner);
  syncGate.actions.innerHTML = "";
  return new Promise((resolve) => {
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label;
      if (a.primary) btn.classList.add("primary");
      btn.addEventListener("click", () => {
        unlockSyncGate();
        resolve(a.value);
      });
      syncGate.actions.appendChild(btn);
    }
    syncGate.backdrop.classList.remove("hidden");
    syncGate.sheet.classList.remove("hidden");
    syncGate._pendingResolve = resolve;
  });
}
function unlockSyncGate() {
  syncGate.backdrop.classList.add("hidden");
  syncGate.sheet.classList.add("hidden");
  syncGate._pendingResolve = null;
}
function settleSyncGate(value) {
  if (syncGate._pendingResolve) {
    const r = syncGate._pendingResolve;
    unlockSyncGate();
    r(value);
  }
}
async function gateCloudSyncOnOpen(sessionName) {
  if (!isAuthConfigured() || !getLastSessionSignedIn()) return;
  const online = navigator.onLine;
  if (!online) {
    const choice = await lockSyncGate({
      title: "\u672A\u8FDE\u63A5\u7F51\u7EDC",
      message: "\u4E0A\u6B21\u662F\u767B\u5F55 OneDrive \u72B6\u6001\u3002\u79BB\u7EBF\u53EA\u80FD\u7528\u672C\u5730\u7F13\u5B58\u3002",
      showSpinner: false,
      actions: [
        { label: "\u79BB\u7EBF\u6A21\u5F0F", value: "offline" },
        { label: "\u7A0D\u540E\u518D\u8BD5\uFF08\u53D6\u6D88\uFF09", value: "offline", primary: false }
      ]
    });
    if (choice === "offline") setStatus("\u79BB\u7EBF\u6A21\u5F0F\uFF1A\u7528\u672C\u5730\u7F13\u5B58", true);
    return;
  }
  if (!isSignedIn()) {
    try {
      await retrySilentSignIn();
    } catch (_) {
    }
  }
  if (!isSignedIn()) {
    const choice = await lockSyncGate({
      title: "OneDrive \u767B\u5F55\u5DF2\u8FC7\u671F",
      message: "token \u5931\u6548\u3002\u91CD\u767B\u62FF\u4E91\u7AEF\uFF0C\u79BB\u7EBF\u7528\u672C\u5730\u3002",
      showSpinner: false,
      actions: [
        { label: "\u91CD\u65B0\u767B\u5F55", value: "signin", primary: true },
        { label: "\u79BB\u7EBF\u6A21\u5F0F", value: "offline" }
      ]
    });
    if (choice === "signin") {
      try {
        await signIn();
        setStatus("\u5DF2\u767B\u5F55");
      } catch (e) {
        setStatus("\u767B\u5F55\u5931\u8D25\uFF1A" + (e.message || e), true);
        return;
      }
      return gateCloudSyncOnOpen(sessionName);
    }
    return;
  }
  await checkCloudETag(sessionName);
}
async function checkCloudETag(sessionName) {
  if (!sessionName) return;
  const result = await Promise.race([
    lockSyncGate({
      title: "\u68C0\u67E5\u4E91\u7AEF",
      message: sessionName,
      showSpinner: true,
      actions: [
        { label: "\u8DF3\u8FC7\u5230\u79BB\u7EBF", value: { kind: "skip" } }
      ]
    }),
    (async () => {
      try {
        const meta = await fetchSessionMetadata(sessionName);
        return { kind: "fetched", meta };
      } catch (e) {
        return { kind: "error", error: e };
      }
    })()
  ]);
  if (result.kind === "fetched") settleSyncGate(null);
  else if (result.kind === "error") settleSyncGate(null);
  if (result.kind === "skip") {
    setStatus("\u5DF2\u8DF3\u8FC7\u4E91\u7AEF\u68C0\u67E5\uFF0C\u7528\u672C\u5730\u7248\u672C");
    return;
  }
  if (result.kind === "error") {
    setStatus("\u8FDE\u4E0D\u4E0A\u4E91\u7AEF\uFF0C\u7528\u672C\u5730\u7248\u672C");
    return;
  }
  const cloudETag = result.meta?.etag || null;
  const localETag = getKnownETag(sessionName);
  if (!cloudETag || cloudETag === localETag) {
    return;
  }
  const cloudTime = result.meta?.lastModified || "?";
  const choice = await lockSyncGate({
    title: "\u4E91\u7AEF\u6709\u65B0\u7248\u672C",
    message: `${sessionName} \u5728\u4E91\u7AEF ${formatCloudTime(cloudTime)} \u6709\u65B0\u7248\u672C\u3002\u672C\u5730\u662F ${getLocalSavedAtLabel()}\u3002`,
    showSpinner: false,
    actions: [
      { label: "\u62C9\u4E91\u7AEF\uFF08\u5907\u4EFD\u672C\u5730\uFF09", value: "pull", primary: true },
      { label: "\u4FDD\u7559\u672C\u5730\uFF08\u4E4B\u540E push \u53EF\u80FD\u51B2\u7A81\uFF09", value: "keep" },
      { label: "\u4E91\u7AEF\u5F00\u4E3A\u526F\u672C", value: "branch" }
    ]
  });
  if (choice === "pull") {
    setStatus("\u6B63\u5728\u62C9\u4E91\u7AEF\u2026");
    const backupName = `${sessionName}-backup-${Date.now()}`;
    try {
      await renameLocalSessionAsBackup(sessionName, backupName);
    } catch (e) {
      setStatus(`\u672C\u5730\u5907\u4EFD\u5931\u8D25\uFF0C\u5DF2\u53D6\u6D88\u62C9\u4E91\u7AEF\uFF1A${e.message || e}`, true);
      return;
    }
    try {
      const r = await pullSessionByPath(sessionName + ".ora");
      if (r) {
        const loaded = await decodeOraToDoc(r.blob);
        adoptLoadedDoc(loaded, sessionName);
        await saveSession(doc, sessionName, {});
        setStatus(`\u5DF2\u62C9\u4E91\u7AEF\uFF1B\u672C\u5730\u539F\u7248\u5907\u4EFD\u4E3A\u300C${backupName}\u300D`);
      } else {
        setStatus(`\u4E91\u7AEF\u627E\u4E0D\u5230\u300C${sessionName}\u300D\uFF08\u672C\u5730\u672A\u52A8\uFF0C\u5907\u4EFD\u300C${backupName}\u300D\u53EF\u5220\uFF09`, true);
      }
    } catch (e) {
      setStatus(`\u62C9\u4E91\u7AEF\u5931\u8D25\uFF1A${e.message || e}\uFF08\u672C\u5730\u672A\u52A8\uFF0C\u5907\u4EFD\u300C${backupName}\u300D\u53EF\u5220\uFF09`, true);
    }
  } else if (choice === "branch") {
    setStatus("\u6B63\u5728\u62C9\u4E91\u7AEF\u5230\u526F\u672C\u2026");
    try {
      const r = await pullSessionByPath(sessionName + ".ora");
      if (r) {
        const branchName = `${sessionName}-cloud-${Date.now()}`;
        const loaded = await decodeOraToDoc(r.blob);
        await saveSession(loaded, branchName, {});
        setStatus(`\u4E91\u7AEF\u7248\u5DF2\u5F00\u4E3A\u300C${branchName}\u300D`);
      }
    } catch (e) {
      setStatus("\u5F00\u526F\u672C\u5931\u8D25\uFF1A" + (e.message || e), true);
    }
  } else {
    setStatus("\u5DF2\u4FDD\u7559\u672C\u5730\uFF0C\u4E91\u7AEF\u7248\u672C\u6682\u4E0D\u52A8");
  }
}
async function renameLocalSessionAsBackup(name, backupName) {
  const loaded = await openSession(name);
  if (!loaded) throw new Error(`\u672C\u5730\u627E\u4E0D\u5230\u300C${name}\u300D\uFF0C\u65E0\u6CD5\u5907\u4EFD`);
  await saveSession(loaded, backupName, {});
}
function formatCloudTime(iso) {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (!t) return iso;
  const d = new Date(t);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function getLocalSavedAtLabel() {
  if (!_docLastSavedAt) return "\uFF08\u672A\u4FDD\u5B58\uFF09";
  const d = new Date(_docLastSavedAt);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function openConfirmSheet(title, message) {
  return new Promise((resolve) => {
    els.genericSheetTitle.textContent = title;
    els.genericSheetInput.classList.add("hidden");
    els.genericSheetMessage.classList.remove("hidden");
    els.genericSheetMessage.textContent = message;
    openSheet(els.genericSheet, els.genericBackdrop);
    const onConfirm = () => _resolveAndClose(resolve, true, cleanup);
    const onCancel = () => _resolveAndClose(resolve, false, cleanup);
    const cleanup = () => {
      els.genericSheetConfirm.removeEventListener("click", onConfirm);
      els.genericSheetCancel.removeEventListener("click", onCancel);
      els.genericBackdrop.removeEventListener("click", onCancel);
    };
    els.genericSheetConfirm.addEventListener("click", onConfirm);
    els.genericSheetCancel.addEventListener("click", onCancel);
    els.genericBackdrop.addEventListener("click", onCancel);
  });
}
function openLayerToolsMenu(L, anchorEl, nameEl) {
  document.querySelectorAll(".layer-tools-popup").forEach((p) => p.remove());
  const popup = document.createElement("div");
  popup.className = "menu-panel layer-tools-popup";
  popup.innerHTML = `
    <button class="menu-item" data-act="rename" type="button">
      <span class="menu-item-label">\u91CD\u547D\u540D\u2026</span>
    </button>
  `;
  document.body.appendChild(popup);
  const r = anchorEl.getBoundingClientRect();
  const w = popup.offsetWidth || 160;
  popup.style.position = "fixed";
  popup.style.top = r.bottom + 4 + "px";
  popup.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
  const cleanup = () => {
    popup.remove();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (e) => {
    if (!popup.contains(e.target) && !anchorEl.contains(e.target)) cleanup();
  };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  popup.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    cleanup();
    if (act === "rename") startLayerRename(L, nameEl);
  });
}
function startLayerRename(L, nameEl) {
  const oldName = L.name;
  const input2 = document.createElement("input");
  input2.type = "text";
  input2.value = oldName;
  input2.className = "layer-name-input";
  nameEl.replaceWith(input2);
  input2.focus();
  input2.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const v = input2.value.trim();
    const newName = v || oldName;
    if (newName !== oldName) {
      L.name = newName;
      history.push({ type: "renameLayer", layerId: L.id, oldName, newName });
    }
    renderLayersPanel();
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    renderLayersPanel();
  };
  input2.addEventListener("blur", commit);
  input2.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input2.addEventListener("click", (e) => e.stopPropagation());
}
function layerSpecFrom(L) {
  const snap = L.snapshot();
  return {
    id: L.id,
    name: L.name,
    visible: L.visible,
    opacity: L.opacity,
    mode: L.mode,
    bboxX: snap.bboxX,
    bboxY: snap.bboxY,
    bboxW: snap.bboxW,
    bboxH: snap.bboxH,
    imageData: snap.imageData,
    blob: null
  };
}
history.registerHandler("addLayer", {
  undo: (e) => {
    doc.removeLayer(e.layerSpec.id);
    _afterDocChange();
  },
  redo: (e) => {
    doc.insertLayerAt(e.index, e.layerSpec);
    _afterDocChange();
  },
  refsLayer: (e, id) => e.layerSpec.id === id
});
history.registerHandler("removeLayer", {
  undo: async (e) => {
    const spec = e.layerSpec;
    if (spec.imageData || !spec.blob && (spec.bboxW <= 0 || spec.bboxH <= 0)) {
      doc.insertLayerAt(e.index, spec);
      _afterDocChange();
      return;
    }
    if (spec.blob) {
      const bitmap = await createImageBitmap(spec.blob);
      doc.insertLayerAt(e.index, { ...spec, bitmap });
      bitmap.close?.();
      _afterDocChange();
      return;
    }
    doc.insertLayerAt(e.index, spec);
    _afterDocChange();
  },
  redo: (e) => {
    doc.removeLayer(e.layerSpec.id);
    _afterDocChange();
  },
  refsLayer: (e, id) => e.layerSpec.id === id
});
history.registerHandler("moveLayer", {
  undo: (e) => {
    const cur = doc.layers.findIndex((l) => l.id === e.layerId);
    if (cur < 0) return;
    doc.moveLayer(e.layerId, e.fromIdx - cur);
    _afterDocChange();
  },
  redo: (e) => {
    const cur = doc.layers.findIndex((l) => l.id === e.layerId);
    if (cur < 0) return;
    doc.moveLayer(e.layerId, e.toIdx - cur);
    _afterDocChange();
  },
  refsLayer: (e, id) => e.layerId === id
});
history.registerHandler("renameLayer", {
  undo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) {
      L.name = e.oldName;
      renderLayersPanel();
    }
  },
  redo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) {
      L.name = e.newName;
      renderLayersPanel();
    }
  },
  refsLayer: (e, id) => e.layerId === id
});
history.registerHandler("setLayerProp", {
  undo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) {
      L[e.prop] = e.oldVal;
      _afterDocChange();
    }
  },
  redo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) {
      L[e.prop] = e.newVal;
      _afterDocChange();
    }
  },
  refsLayer: (e, id) => e.layerId === id
});
history.registerHandler("setReferenceLayer", {
  undo: (e) => {
    doc.referenceLayerId = e.oldVal;
    renderLayersPanel();
  },
  redo: (e) => {
    doc.referenceLayerId = e.newVal;
    renderLayersPanel();
  },
  refsLayer: (e, id) => e.oldVal === id || e.newVal === id
});
history.registerHandler("docTransform", {
  undo: (e) => {
    doc.restoreSnapshotAll(e.before.doc);
    if (e.before.viewport) Object.assign(board.viewport, e.before.viewport);
    _afterDocChange();
    if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}\xD7${doc.height}`;
    board.invalidateAll();
    renderLayersPanel();
  },
  redo: (e) => {
    doc.restoreSnapshotAll(e.after.doc);
    if (e.after.viewport) Object.assign(board.viewport, e.after.viewport);
    _afterDocChange();
    if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}\xD7${doc.height}`;
    board.invalidateAll();
    renderLayersPanel();
  },
  refsLayer: () => true
  // 所有层都受影响
});
history.registerHandler("selectionToLayer", {
  undo: async (e) => {
    doc.removeLayer(e.newLayerSpec.id);
    if (e.isMove && e.beforeActive) {
      const L = doc.findLayer(e.activeLayerId);
      if (L) await applyPixelSnap(doc, L.id, e.beforeActive, e.beforeActive.blob, board);
    }
    doc.setActiveById(e.activeLayerId);
    _afterDocChange();
  },
  redo: async (e) => {
    const spec = e.newLayerSpec;
    if (spec.blob && !spec.imageData) {
      const bitmap = await createImageBitmap(spec.blob);
      doc.insertLayerAt(e.insertIndex, { ...spec, bitmap });
      bitmap.close?.();
    } else {
      doc.insertLayerAt(e.insertIndex, spec);
    }
    if (e.isMove && e.afterActive) {
      const L = doc.findLayer(e.activeLayerId);
      if (L) await applyPixelSnap(doc, L.id, e.afterActive, e.afterActive.blob, board);
    }
    doc.setActiveById(spec.id);
    _afterDocChange();
  },
  refsLayer: (e, id) => e.newLayerSpec.id === id || e.activeLayerId === id
});
els.hueSlider.addEventListener("input", () => {
  pickerHsv.h = parseFloat(els.hueSlider.value);
  drawSvPad();
  commitPicker();
});
els.hexInput.addEventListener("change", () => {
  let v = els.hexInput.value.trim();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    pickerSetFromHex(v);
    commitPicker();
  } else {
    setStatus("HEX \u683C\u5F0F\u4E0D\u5BF9");
    els.hexInput.value = state.color;
  }
});
var svDragging = false;
els.svPad.addEventListener("pointerdown", (e) => {
  svDragging = true;
  els.svPad.setPointerCapture(e.pointerId);
  pickFromSv(e);
});
els.svPad.addEventListener("pointermove", (e) => {
  if (svDragging) pickFromSv(e);
});
els.svPad.addEventListener("pointerup", (e) => {
  svDragging = false;
});
function pickFromSv(e) {
  const r = els.svPad.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
  pickerHsv.s = x / r.width;
  pickerHsv.v = 1 - y / r.height;
  drawSvPad();
  commitPicker();
}
function drawSvPad() {
  const c = els.svPad;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  ctx.fillStyle = `hsl(${pickerHsv.h} 100% 50%)`;
  ctx.fillRect(0, 0, w, h);
  const gx = ctx.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, "rgba(255,255,255,1)");
  gx.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, w, h);
  const gy = ctx.createLinearGradient(0, 0, 0, h);
  gy.addColorStop(0, "rgba(0,0,0,0)");
  gy.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gy;
  ctx.fillRect(0, 0, w, h);
  const mx = pickerHsv.s * w;
  const my = (1 - pickerHsv.v) * h;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(mx, my, 5, 0, Math.PI * 2);
  ctx.stroke();
}
function commitPicker() {
  const hex = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
  els.hexInput.value = hex;
  els.previewSwatch.style.background = hex;
  _suppressPickerSync = true;
  setColor(hex);
  _suppressPickerSync = false;
}
function pickerSetFromHex(hex) {
  const { h, s, v } = hexToHsv(hex);
  pickerHsv = { h, s, v };
  els.hueSlider.value = String(Math.round(h));
  els.hexInput.value = hex;
  els.previewSwatch.style.background = hex;
  drawSvPad();
}
function hsvToHex(h, s, v) {
  const c = v * s;
  const hp = h / 60 % 6;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (0 <= hp && hp < 1) {
    r = c;
    g = x;
    b = 0;
  } else if (1 <= hp && hp < 2) {
    r = x;
    g = c;
    b = 0;
  } else if (2 <= hp && hp < 3) {
    r = 0;
    g = c;
    b = x;
  } else if (3 <= hp && hp < 4) {
    r = 0;
    g = x;
    b = c;
  } else if (4 <= hp && hp < 5) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  const m = v - c;
  const R = Math.round((r + m) * 255), G = Math.round((g + m) * 255), B = Math.round((b + m) * 255);
  return "#" + [R, G, B].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function hexToHsv(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { h: 0, s: 0, v: 0 };
  const R = parseInt(hex.slice(1, 3), 16) / 255;
  const G = parseInt(hex.slice(3, 5), 16) / 255;
  const B = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === R) h = (G - B) / d % 6;
    else if (mx === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  const v = mx;
  return { h, s, v };
}
var _docDirty = false;
var _docSaving = false;
var _loadedDocIsNewer = false;
var _loadedDocWriterVer = null;
var _loadedDocNewerConfirmed = false;
var _cloudPushing = false;
var _docLastSavedAt = 0;
var _activeSessionName = "\u672A\u547D\u540D";
var AUTOSAVE_MS = 3 * 60 * 1e3;
var ICON_DISK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
var ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
var ICON_CLOUD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';
var ICON_CLOUD_BUSY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><g class="spin-arc" style="transform-origin: 12px 13px;"><path d="M9 13a3 3 0 0 1 5.5-1.6" /><polyline points="14.5 9.5 14.5 11.4 12.6 11.4" /></g></svg>';
function computeSaveState() {
  if (_cloudPushing) return "cloud-busy";
  if (_docSaving) return "saving";
  if (_docDirty) return "dirty";
  if (isSignedIn() && isCloudDirty(_activeSessionName)) return "cloud-dirty";
  if (isSignedIn()) return "synced";
  return "local-only";
}
function updateSaveStatus() {
  const state2 = computeSaveState();
  els.topSaveBtn.dataset.state = state2;
  const name = _activeSessionName;
  if (state2 === "cloud-busy") {
    els.topSaveBtn.innerHTML = ICON_CLOUD_BUSY;
    els.topSaveBtn.title = `\u4E0A\u4F20\u4E2D\u2026 \xB7 ${name}`;
  } else if (state2 === "saving") {
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = `\u4FDD\u5B58\u4E2D\u2026 \xB7 ${name}`;
  } else if (state2 === "dirty") {
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = `\u4FDD\u5B58 + \u63A8\u9001 (Ctrl+S) \xB7 ${name} \xB7 \u672A\u4FDD\u5B58`;
  } else if (state2 === "cloud-dirty") {
    els.topSaveBtn.innerHTML = ICON_UPLOAD;
    els.topSaveBtn.title = `\u63A8\u9001\u5230\u4E91\u7AEF (Ctrl+S) \xB7 ${name} \xB7 \u672C\u5730\u5DF2\u5B58\uFF0C\u4E91\u7AEF\u672A\u540C\u6B65`;
  } else if (state2 === "synced") {
    els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK;
    els.topSaveBtn.title = `\u5DF2\u540C\u6B65\u5230\u4E91\u7AEF \xB7 ${name}`;
  } else {
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = `\u5DF2\u5B58\u672C\u5730\uFF08IDB \u6613\u5931\uFF0C\u767B\u5F55\u4E91\u7AEF\u66F4\u5B89\u5168\uFF09 \xB7 ${name}`;
  }
}
async function saveNow(opts = {}) {
  if (_docSaving) return;
  if (hasAnyPendingTransient()) {
    if (opts.implicit) return;
    applyAllPendingTransients();
  }
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    if (opts.implicit) return;
    const ok = await openConfirmSheet(
      `\u8986\u76D6\u66F4\u65B0\u7248\u672C\u5199\u7684\u753B\uFF1F`,
      `\u8FD9\u753B\u7531 ${_loadedDocWriterVer} \u5199\u7684\uFF0C\u4F60\u662F ${WEBPAINT_VERSION}\u3002\u4FDD\u5B58\u4F1A\u4E22\u5931\u65B0\u7248\u672C\u7279\u6709\u7684\u5C5E\u6027\uFF08\u5982\u65B0\u56FE\u5C42 flag \u7B49\uFF09\u3002\u5EFA\u8BAE\u5148\u5237\u65B0\u5347\u7EA7\u3002`
    );
    if (!ok) {
      setStatus("\u5DF2\u53D6\u6D88\u4FDD\u5B58");
      return;
    }
    _loadedDocNewerConfirmed = true;
    updateNewerBanner();
  }
  _docSaving = true;
  updateSaveStatus();
  try {
    await saveSession(doc, _activeSessionName, {
      referenceImage: referenceWindow.getPersistBlob(),
      webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState() }
    });
    _docDirty = false;
    _docLastSavedAt = Date.now();
    setStatus(`\u5DF2\u4FDD\u5B58\uFF1A${_activeSessionName}`);
    checkQuotaAndWarn();
  } catch (e) {
    console.warn("[session] save failed:", e);
    setStatus("\u4FDD\u5B58\u5931\u8D25\uFF1A" + (e && e.message || e));
  } finally {
    _docSaving = false;
    updateSaveStatus();
  }
}
function adoptLoadedDoc(loaded, sessionName) {
  doc.layers = loaded.layers;
  doc.activeIndex = loaded.activeIndex;
  doc.width = loaded.width;
  doc.height = loaded.height;
  doc.backgroundColor = loaded.backgroundColor;
  doc.referenceLayerId = loaded.referenceLayerId ?? null;
  doc.selection = null;
  els.canvasSizeLabel.textContent = `${doc.width}\xD7${doc.height}`;
  input.clearHistory();
  board.invalidateAll();
  board.requestRender();
  renderLayersPanel();
  _activeSessionName = sessionName;
  setCurrentSessionName(sessionName);
  _docDirty = false;
  _docLastSavedAt = Date.now();
  updateSaveStatus();
  _loadedDocIsNewer = false;
  _loadedDocNewerConfirmed = false;
  const writerN = parseAppVersion(loaded._wroteWith);
  const selfN = parseAppVersion(WEBPAINT_VERSION);
  if (writerN !== null && selfN !== null && writerN > selfN) {
    _loadedDocIsNewer = true;
    _loadedDocWriterVer = loaded._wroteWith;
    setStatus(
      `\u8FD9\u753B\u7531 ${loaded._wroteWith} \u5199\u7684\uFF0C\u4F60\u662F ${WEBPAINT_VERSION} \u2014\u2014 \u7F16\u8F91\u4FDD\u5B58\u4F1A\u4E22\u5931\u65B0\u7248\u7279\u6709\u7684\u5C42\u5C5E\u6027\u3002\u5EFA\u8BAE\u5148\u5237\u65B0\u5347\u7EA7\u3002`,
      true
    );
  } else {
    _loadedDocWriterVer = null;
  }
  updateNewerBanner();
  referenceWindow.clearBitmap();
  if (loaded._referenceBlob) {
    createImageBitmap(loaded._referenceBlob).then((bitmap) => {
      referenceWindow.setBitmap(bitmap, { persistBlob: loaded._referenceBlob });
      if (loaded._webpaintState?.reference) {
        referenceWindow.applySerializedState(loaded._webpaintState.reference);
      }
    }).catch(() => {
    });
  } else if (loaded._webpaintState?.reference) {
    referenceWindow.applySerializedState(loaded._webpaintState.reference);
  }
  if (loaded._webpaintState?.color) {
    setColor(loaded._webpaintState.color);
  }
  if (loaded._webpaintState?.palette) {
    try {
      paletteWindow.applySerializedState(loaded._webpaintState.palette);
    } catch (_) {
    }
  }
  if (loaded._webpaintState?.toolStates && typeof loaded._webpaintState.toolStates === "object") {
    for (const t of Object.keys(state.toolStates)) {
      const saved = loaded._webpaintState.toolStates[t];
      if (saved && typeof saved === "object") {
        const op = typeof saved.opacity === "number" ? saved.opacity : typeof saved.intensity === "number" ? saved.intensity : typeof saved.flow === "number" ? saved.flow : state.toolStates[t].opacity;
        const fl = typeof saved.flow === "number" && typeof saved.opacity === "number" ? saved.flow : state.toolStates[t].flow;
        Object.assign(state.toolStates[t], {
          size: typeof saved.size === "number" ? saved.size : state.toolStates[t].size,
          opacity: op,
          flow: fl,
          activeBrushId: typeof saved.activeBrushId === "string" ? saved.activeBrushId : state.toolStates[t].activeBrushId
        });
      }
    }
    applyToolState(state.tool);
  }
}
window.addEventListener("wp:histchange", () => {
  _docDirty = true;
  if (isSignedIn()) setCloudDirty(_activeSessionName, true);
  updateSaveStatus();
});
async function saveAndPush() {
  if (_docSaving) return;
  if (_docDirty) await saveNow();
  if (isSignedIn() && navigator.onLine === false && isCloudDirty(_activeSessionName)) {
    setStatus(`\u5DF2\u5B58\u672C\u5730\uFF1A${_activeSessionName}\uFF08\u79BB\u7EBF\uFF0C\u56DE\u5230\u5728\u7EBF\u518D Ctrl+S \u63A8\u4E91\u7AEF\uFF09`);
    return;
  }
  if (isSignedIn() && isCloudDirty(_activeSessionName)) {
    _cloudPushing = true;
    updateSaveStatus();
    try {
      const ora = await encodeDocToOra(doc, {
        referenceImage: referenceWindow.getPersistBlob(),
        webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState() }
      });
      await pushSession(_activeSessionName, ora);
      setStatus(`\u5DF2\u540C\u6B65\u5230\u4E91\u7AEF\uFF1A${_activeSessionName}`);
      renderGallery();
    } catch (e) {
      if (e instanceof CloudConflictError) {
        _cloudPushing = false;
        updateSaveStatus();
        const sessionName = _activeSessionName;
        const choice = await lockSyncGate({
          title: "\u4E91\u7AEF\u6709\u66F4\u65B0\u7248\u672C",
          message: `${sessionName} \u5728\u4E91\u7AEF\u5DF2\u88AB\u6539\u8FC7\u3002\u63A8\u4F1A\u8986\u76D6\u90A3\u6B21\u6539\u52A8\u3002`,
          showSpinner: false,
          actions: [
            { label: "\u62C9\u4E91\u7AEF\u8986\u76D6\u672C\u5730\uFF08\u5907\u4EFD\u672C\u5730\uFF09", value: "pull", primary: true },
            { label: "\u4FDD\u7559\u672C\u5730\u53E6\u5B58\u4E3A\u526F\u672C", value: "rename" },
            { label: "\u90FD\u7559\uFF08\u4E91\u7AEF\u5F00\u4E3A\u526F\u672C\uFF09", value: "branch" }
          ]
        });
        if (choice === "pull") {
          const backupName = `${sessionName}-backup-${Date.now()}`;
          try {
            await renameLocalSessionAsBackup(sessionName, backupName);
          } catch (err) {
            setStatus(`\u672C\u5730\u5907\u4EFD\u5931\u8D25\uFF0C\u5DF2\u53D6\u6D88\u62C9\u4E91\u7AEF\uFF1A${err.message || err}`, true);
            return;
          }
          try {
            const r = await pullSessionByPath(sessionName + ".ora");
            if (r) {
              const loaded = await decodeOraToDoc(r.blob);
              adoptLoadedDoc(loaded, sessionName);
              await saveSession(doc, sessionName, {});
              setStatus(`\u5DF2\u62C9\u4E91\u7AEF\uFF1B\u672C\u5730\u539F\u7248\u5907\u4EFD\u4E3A\u300C${backupName}\u300D`);
            } else {
              setStatus(`\u4E91\u7AEF\u627E\u4E0D\u5230\u300C${sessionName}\u300D\uFF08\u5907\u4EFD\u300C${backupName}\u300D\u53EF\u5220\uFF09`, true);
            }
          } catch (err) {
            setStatus(`\u62C9\u4E91\u7AEF\u5931\u8D25\uFF1A${err.message || err}\uFF08\u5907\u4EFD\u300C${backupName}\u300D\u53EF\u5220\uFF09`, true);
          }
        } else if (choice === "rename") {
          const newName = await renameCurrentSession({ suggested: sessionName + " (\u65B0)", reason: "\u4E91\u7AEF\u51B2\u7A81" });
          if (newName && isSignedIn()) {
            setCloudDirty(newName, true);
            queueSave("push");
          }
        } else if (choice === "branch") {
          try {
            const r = await pullSessionByPath(sessionName + ".ora");
            if (r) {
              const branchName = `${sessionName}-cloud-${Date.now()}`;
              const loaded = await decodeOraToDoc(r.blob);
              await saveSession(loaded, branchName, {});
              setStatus(`\u4E91\u7AEF\u7248\u5F00\u4E3A\u300C${branchName}\u300D\uFF1B\u672C\u5730\u672A\u53D8`);
            }
          } catch (err) {
            setStatus("\u5F00\u526F\u672C\u5931\u8D25\uFF1A" + (err.message || err), true);
          }
        }
        return;
      } else {
        console.warn("[cloud] push failed:", e);
        setStatus("\u63A8\u9001\u5931\u8D25\uFF1A" + (e && e.message || e));
      }
    } finally {
      _cloudPushing = false;
      updateSaveStatus();
    }
  } else if (!isSignedIn() && !_docDirty) {
    setStatus(`\u5DF2\u5B58\u672C\u5730\uFF1A${_activeSessionName}\uFF08IDB \u6613\u5931\uFF0C\u767B\u5F55\u4E91\u7AEF\u66F4\u5B89\u5168\uFF09`);
  }
}
async function renameCurrentSession({ suggested, reason } = {}) {
  applyAllPendingTransients();
  const oldName = _activeSessionName;
  let candidate = suggested || oldName;
  while (true) {
    const title = reason ? `\u91CD\u547D\u540D\uFF08${reason}\uFF09` : "\u91CD\u547D\u540D\u5F53\u524D\u753B\u4F5C";
    const input2 = await openInputSheet(title, candidate, { placeholder: "\u4F5C\u54C1\u540D\u5B57" });
    if (input2 === null) return null;
    const trimmed = input2.trim();
    if (!trimmed) {
      setStatus("\u540D\u5B57\u4E0D\u80FD\u7A7A", true);
      candidate = "";
      continue;
    }
    if (trimmed === oldName) return oldName;
    const localNames = (await listSessions()).map((s) => s.name);
    if (localNames.includes(trimmed)) {
      setStatus(`\u672C\u5730\u5DF2\u6709\u540C\u540D "${trimmed}"\uFF0C\u6362\u4E00\u4E2A`, true);
      candidate = trimmed;
      continue;
    }
    try {
      await saveSession(doc, trimmed, {
        referenceImage: referenceWindow.getPersistBlob(),
        webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState() }
      });
      if (oldName && oldName !== trimmed) {
        try {
          await removeSession(oldName);
        } catch {
        }
      }
      _activeSessionName = trimmed;
      setCurrentSessionName(trimmed);
      _docDirty = false;
      _docLastSavedAt = Date.now();
      updateSaveStatus();
      setStatus(`\u5DF2\u91CD\u547D\u540D\uFF1A${oldName} \u2192 ${trimmed}`);
      return trimmed;
    } catch (e) {
      setStatus("\u91CD\u547D\u540D\u5931\u8D25\uFF1A" + (e && e.message || e));
      return null;
    }
  }
}
var _savePending = null;
var _inFlightSaveType = null;
var _editVersion = 0;
var _inFlightStartVersion = 0;
window.addEventListener("wp:histchange", () => {
  _editVersion++;
});
function queueSave(type) {
  if (!_inFlightSaveType) {
    runQueuedSave(type);
    return;
  }
  const hasNewEdits = _editVersion !== _inFlightStartVersion;
  let shouldQueue;
  if (_inFlightSaveType === "local" && type === "push") shouldQueue = true;
  else shouldQueue = hasNewEdits;
  if (!shouldQueue) return;
  if (type === "push" || _savePending !== "push") _savePending = type;
}
async function runQueuedSave(type) {
  _inFlightSaveType = type;
  _inFlightStartVersion = _editVersion;
  try {
    if (type === "push") await saveAndPush();
    else await saveNow();
  } finally {
    _inFlightSaveType = null;
    if (_savePending) {
      const next = _savePending;
      _savePending = null;
      runQueuedSave(next);
    }
  }
}
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    queueSave(e.shiftKey ? "local" : "push");
  }
});
setInterval(() => {
  if (_docDirty && !_docSaving) saveNow({ implicit: true });
}, AUTOSAVE_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && _docDirty && !_docSaving) saveNow({ implicit: true });
});
window.addEventListener("pagehide", () => {
  if (_docDirty && !_docSaving) saveNow({ implicit: true });
});
window.addEventListener("beforeunload", (e) => {
  if (_docDirty && !_docSaving) {
    e.preventDefault();
    e.returnValue = "";
    saveNow({ implicit: true }).catch(() => {
    });
  }
});
function stampNow() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}
els.topSaveBtn.addEventListener("click", () => queueSave("push"));
function setAdjustOpen(open) {
  els.adjustPopup.classList.toggle("hidden", !open);
  els.topAdjustBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    const r = els.topAdjustBtn.getBoundingClientRect();
    const w = els.adjustPopup.offsetWidth || 200;
    els.adjustPopup.style.top = r.bottom + 4 + "px";
    els.adjustPopup.style.right = window.innerWidth - r.right + "px";
    els.adjustPopup.style.left = "auto";
  }
}
els.topAdjustBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setAdjustOpen(els.adjustPopup.classList.contains("hidden"));
});
document.addEventListener("pointerdown", (e) => {
  if (els.adjustPopup.classList.contains("hidden")) return;
  if (els.adjustPopup.contains(e.target) || els.topAdjustBtn.contains(e.target)) return;
  setAdjustOpen(false);
});
els.adjustLiquify.addEventListener("click", () => {
  setAdjustOpen(false);
  setTool("liquify");
  toggleLiquifyPanel(true);
  setStatus("\u6DB2\u5316");
});
function _captureDocBefore() {
  applyAllPendingTransients();
  return { doc: doc.snapshotAll(), viewport: { ...board.viewport } };
}
function _captureDocAfter() {
  return { doc: doc.snapshotAll(), viewport: { ...board.viewport } };
}
function _pushDocTransform(before, after, label) {
  history.push({ type: "docTransform", before, after });
  _docDirty = true;
  if (isSignedIn()) setCloudDirty(_activeSessionName, true);
  if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}\xD7${doc.height}`;
  board.invalidateAll();
  renderLayersPanel();
  setStatus(label);
}
function _shiftViewportAfterCrop(rect) {
  const v = board.viewport;
  v.tx = v.tx + rect.x * v.scale;
  v.ty = v.ty + rect.y * v.scale;
}
document.getElementById("adjustCropToSelection").addEventListener("click", () => {
  setMenuOpen(false);
  setAdjustOpen(false);
  if (!doc.selection) {
    setStatus("\u6CA1\u9009\u533A\u2014\u2014\u753B\u4E00\u4E2A lasso \u9009\u533A\u5148", true);
    return;
  }
  const s = doc.selection;
  const x = Math.max(0, s.bboxX | 0), y = Math.max(0, s.bboxY | 0);
  const w = Math.min(doc.width - x, s.bboxW | 0), h = Math.min(doc.height - y, s.bboxH | 0);
  if (w < 1 || h < 1) {
    setStatus("\u9009\u533A\u592A\u5C0F\u6216\u5728\u753B\u5E03\u5916", true);
    return;
  }
  const before = _captureDocBefore();
  doc.cropTo({ x, y, w, h });
  _shiftViewportAfterCrop({ x, y });
  const after = _captureDocAfter();
  _pushDocTransform(before, after, `\u5DF2\u88C1\u5230\u9009\u533A\uFF1A${w}\xD7${h}`);
});
var _cropState = null;
function _docRectToScreen(r) {
  const { tx, ty, scale } = board.viewport;
  return { x: r.x * scale + tx, y: r.y * scale + ty, w: r.w * scale, h: r.h * scale };
}
function _renderCropOverlay() {
  if (!_cropState) return;
  const r = _docRectToScreen(_cropState.rect);
  const el = document.getElementById("cropRect");
  el.style.left = r.x + "px";
  el.style.top = r.y + "px";
  el.style.width = Math.max(2, r.w) + "px";
  el.style.height = Math.max(2, r.h) + "px";
}
function _openCropMode() {
  if (board.viewport.rot && Math.abs(board.viewport.rot) > 0.01) {
    setStatus("\u5148\u628A\u753B\u5E03\u65CB\u8F6C\u590D\u4F4D\uFF08\u6309 0\uFF09\u518D\u8FDB\u81EA\u7531\u88C1\u5207", true);
    return;
  }
  _cropState = {
    rect: { x: 0, y: 0, w: doc.width, h: doc.height },
    drag: null,
    startMouse: null,
    startRect: null
  };
  document.getElementById("cropOverlay").classList.remove("hidden");
  document.getElementById("cropToolbar").classList.remove("hidden");
  _renderCropOverlay();
  _suppressTransientPanels("crop");
}
function _closeCropMode() {
  _cropState = null;
  document.getElementById("cropOverlay").classList.add("hidden");
  document.getElementById("cropToolbar").classList.add("hidden");
  _restoreTransientPanels();
}
document.getElementById("adjustCropFree").addEventListener("click", () => {
  setMenuOpen(false);
  setAdjustOpen(false);
  _openCropMode();
});
document.getElementById("cropToolbarCancel").addEventListener("click", () => _closeCropMode());
document.getElementById("cropToolbarApply").addEventListener("click", () => {
  if (!_cropState) return;
  const r = _cropState.rect;
  const x = Math.max(0, Math.min(doc.width - 1, r.x | 0));
  const y = Math.max(0, Math.min(doc.height - 1, r.y | 0));
  const w = Math.max(1, Math.min(doc.width - x, r.w | 0));
  const h = Math.max(1, Math.min(doc.height - y, r.h | 0));
  const before = _captureDocBefore();
  doc.cropTo({ x, y, w, h });
  _shiftViewportAfterCrop({ x, y });
  const after = _captureDocAfter();
  _pushDocTransform(before, after, `\u5DF2\u88C1\u5207\uFF1A${w}\xD7${h}`);
  _closeCropMode();
});
(function bindCropOverlayPointer() {
  const overlay = document.getElementById("cropOverlay");
  const rect = document.getElementById("cropRect");
  overlay.addEventListener("pointerdown", (e) => {
    if (!_cropState) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target?.dataset?.handle || (e.target === rect ? "move" : null);
    if (!handle) return;
    overlay.setPointerCapture(e.pointerId);
    _cropState.drag = handle;
    _cropState.startMouse = { x: e.clientX, y: e.clientY };
    _cropState.startRect = { ..._cropState.rect };
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!_cropState || !_cropState.drag) return;
    const dx_screen = e.clientX - _cropState.startMouse.x;
    const dy_screen = e.clientY - _cropState.startMouse.y;
    const scale = board.viewport.scale;
    const dx = dx_screen / scale;
    const dy = dy_screen / scale;
    const r0 = _cropState.startRect;
    const r = { ..._cropState.rect };
    const h = _cropState.drag;
    if (h === "move") {
      r.x = r0.x + dx;
      r.y = r0.y + dy;
    } else {
      if (h.includes("n")) {
        r.y = r0.y + dy;
        r.h = r0.h - dy;
      }
      if (h.includes("s")) {
        r.h = r0.h + dy;
      }
      if (h.includes("w")) {
        r.x = r0.x + dx;
        r.w = r0.w - dx;
      }
      if (h.includes("e")) {
        r.w = r0.w + dx;
      }
    }
    if (r.w < 4) {
      r.w = 4;
      if (h.includes("w")) r.x = r0.x + r0.w - 4;
    }
    if (r.h < 4) {
      r.h = 4;
      if (h.includes("n")) r.y = r0.y + r0.h - 4;
    }
    r.x = Math.max(0, Math.min(doc.width - r.w, r.x));
    r.y = Math.max(0, Math.min(doc.height - r.h, r.y));
    if (r.x + r.w > doc.width) r.w = doc.width - r.x;
    if (r.y + r.h > doc.height) r.h = doc.height - r.y;
    _cropState.rect = r;
    _renderCropOverlay();
  });
  overlay.addEventListener("pointerup", (e) => {
    if (!_cropState) return;
    try {
      overlay.releasePointerCapture(e.pointerId);
    } catch {
    }
    _cropState.drag = null;
  });
  overlay.addEventListener("pointercancel", (e) => {
    if (!_cropState) return;
    try {
      overlay.releasePointerCapture(e.pointerId);
    } catch {
    }
    _cropState.drag = null;
  });
})();
function _openResampleDialog() {
  els.resampleBackdrop.classList.remove("hidden");
  els.resampleSheet.classList.remove("hidden");
  els.resampleW.value = String(doc.width);
  els.resampleH.value = String(doc.height);
  els.resampleW.focus();
  const aspect = doc.width / doc.height;
  const onW = () => {
    if (!els.resampleLock.checked) return;
    const w = parseFloat(els.resampleW.value) | 0;
    if (w > 0) els.resampleH.value = String(Math.max(1, Math.round(w / aspect)));
  };
  const onH = () => {
    if (!els.resampleLock.checked) return;
    const h = parseFloat(els.resampleH.value) | 0;
    if (h > 0) els.resampleW.value = String(Math.max(1, Math.round(h * aspect)));
  };
  els.resampleW.oninput = onW;
  els.resampleH.oninput = onH;
}
function _closeResampleDialog() {
  els.resampleBackdrop.classList.add("hidden");
  els.resampleSheet.classList.add("hidden");
}
document.getElementById("adjustResample").addEventListener("click", () => {
  setMenuOpen(false);
  setAdjustOpen(false);
  _openResampleDialog();
});
els.resampleCancel.addEventListener("click", () => _closeResampleDialog());
els.resampleBackdrop.addEventListener("click", () => _closeResampleDialog());
els.resampleConfirm.addEventListener("click", () => {
  const nw = parseFloat(els.resampleW.value) | 0;
  const nh = parseFloat(els.resampleH.value) | 0;
  const mode = els.resampleMode.value || "bilinear";
  if (nw < 1 || nh < 1 || nw > 8192 || nh > 8192) {
    setStatus("\u5C3A\u5BF8\u8D85\u51FA [1, 8192]", true);
    return;
  }
  if (nw === doc.width && nh === doc.height) {
    _closeResampleDialog();
    return;
  }
  const before = _captureDocBefore();
  doc.resampleTo(nw, nh, mode);
  const after = _captureDocAfter();
  _pushDocTransform(before, after, `\u5DF2\u91CD\u91C7\u6837\u5230 ${nw}\xD7${nh}\uFF08${mode}\uFF09`);
  _closeResampleDialog();
});
var _adjustState = null;
function _bakeBCSHToImageData(srcData, dstData, s) {
  const b = 1 + s.brightness / 100;
  const c = 1 + s.contrast / 100;
  const sat = 1 + s.saturation / 100;
  const hueRad = (s.hue | 0) * Math.PI / 180;
  const cosH = Math.cos(hueRad);
  const sinH = Math.sin(hueRad);
  const lumR = 0.213, lumG = 0.715, lumB = 0.072;
  const m11 = lumR + cosH * (1 - lumR) + sinH * -lumR;
  const m12 = lumG + cosH * -lumG + sinH * -lumG;
  const m13 = lumB + cosH * -lumB + sinH * (1 - lumB);
  const m21 = lumR + cosH * -lumR + sinH * 0.143;
  const m22 = lumG + cosH * (1 - lumG) + sinH * 0.14;
  const m23 = lumB + cosH * -lumB + sinH * -0.283;
  const m31 = lumR + cosH * -lumR + sinH * -(1 - lumR);
  const m32 = lumG + cosH * -lumG + sinH * lumG;
  const m33 = lumB + cosH * (1 - lumB) + sinH * lumB;
  const useHue = s.hue !== 0;
  const N = srcData.length;
  for (let i = 0; i < N; i += 4) {
    let r = srcData[i], g = srcData[i + 1], bl = srcData[i + 2];
    r *= b;
    g *= b;
    bl *= b;
    r = (r - 128) * c + 128;
    g = (g - 128) * c + 128;
    bl = (bl - 128) * c + 128;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    r = luma + (r - luma) * sat;
    g = luma + (g - luma) * sat;
    bl = luma + (bl - luma) * sat;
    if (useHue) {
      const nr = r * m11 + g * m12 + bl * m13;
      const ng = r * m21 + g * m22 + bl * m23;
      const nb = r * m31 + g * m32 + bl * m33;
      r = nr;
      g = ng;
      bl = nb;
    }
    dstData[i] = r < 0 ? 0 : r > 255 ? 255 : r | 0;
    dstData[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    dstData[i + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl | 0;
    dstData[i + 3] = srcData[i + 3];
  }
}
function _bakeBCSHWithMask(srcData, dstData, s, mask) {
  if (!mask) {
    _bakeBCSHToImageData(srcData, dstData, s);
    return;
  }
  const b = 1 + s.brightness / 100;
  const c = 1 + s.contrast / 100;
  const sat = 1 + s.saturation / 100;
  const hueRad = (s.hue | 0) * Math.PI / 180;
  const cosH = Math.cos(hueRad);
  const sinH = Math.sin(hueRad);
  const lumR = 0.213, lumG = 0.715, lumB = 0.072;
  const m11 = lumR + cosH * (1 - lumR) + sinH * -lumR;
  const m12 = lumG + cosH * -lumG + sinH * -lumG;
  const m13 = lumB + cosH * -lumB + sinH * (1 - lumB);
  const m21 = lumR + cosH * -lumR + sinH * 0.143;
  const m22 = lumG + cosH * (1 - lumG) + sinH * 0.14;
  const m23 = lumB + cosH * -lumB + sinH * -0.283;
  const m31 = lumR + cosH * -lumR + sinH * -(1 - lumR);
  const m32 = lumG + cosH * -lumG + sinH * lumG;
  const m33 = lumB + cosH * (1 - lumB) + sinH * lumB;
  const useHue = s.hue !== 0;
  const N = srcData.length / 4;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const mAlpha = mask[i * 4 + 3];
    if (mAlpha < 128) {
      dstData[o] = srcData[o];
      dstData[o + 1] = srcData[o + 1];
      dstData[o + 2] = srcData[o + 2];
      dstData[o + 3] = srcData[o + 3];
      continue;
    }
    let r = srcData[o], g = srcData[o + 1], bl = srcData[o + 2];
    r *= b;
    g *= b;
    bl *= b;
    r = (r - 128) * c + 128;
    g = (g - 128) * c + 128;
    bl = (bl - 128) * c + 128;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    r = luma + (r - luma) * sat;
    g = luma + (g - luma) * sat;
    bl = luma + (bl - luma) * sat;
    if (useHue) {
      const nr = r * m11 + g * m12 + bl * m13;
      const ng = r * m21 + g * m22 + bl * m23;
      const nb = r * m31 + g * m32 + bl * m33;
      r = nr;
      g = ng;
      bl = nb;
    }
    dstData[o] = r < 0 ? 0 : r > 255 ? 255 : r | 0;
    dstData[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    dstData[o + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl | 0;
    dstData[o + 3] = srcData[o + 3];
  }
}
function _initAdjustSurrogate(L) {
  const sur = document.createElement("canvas");
  sur.width = L.bboxW;
  sur.height = L.bboxH;
  const surCtx = sur.getContext("2d");
  surCtx.drawImage(L.canvas, 0, 0);
  const srcImg = surCtx.getImageData(0, 0, L.bboxW, L.bboxH);
  let maskData = null;
  if (doc.selection) {
    const m = document.createElement("canvas");
    m.width = L.bboxW;
    m.height = L.bboxH;
    const mctx = m.getContext("2d");
    mctx.drawImage(
      doc.selection.maskCanvas,
      doc.selection.bboxX - L.bboxX,
      doc.selection.bboxY - L.bboxY
    );
    maskData = mctx.getImageData(0, 0, L.bboxW, L.bboxH).data;
  }
  return { sur, surCtx, srcImg, maskData };
}
function _openAdjustPanel() {
  const L = doc.activeLayer;
  if (!L) {
    setStatus("\u6CA1\u6D3B\u52A8\u56FE\u5C42", true);
    return;
  }
  if (L.bboxW <= 0 || L.bboxH <= 0) {
    setStatus("\u6D3B\u52A8\u56FE\u5C42\u662F\u7A7A\u7684", true);
    return;
  }
  const { sur, surCtx, srcImg, maskData } = _initAdjustSurrogate(L);
  _adjustState = {
    active: L,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    beforeSnap: L.snapshot(),
    sur,
    surCtx,
    srcImg,
    maskData
  };
  els.adjustPanel.classList.remove("hidden");
  const w = els.adjustPanel.offsetWidth || 280;
  els.adjustPanel.style.left = window.innerWidth - w - 16 + "px";
  els.adjustPanel.style.top = "70px";
  _bringPanelTop(els.adjustPanel);
  _syncAdjustSliders();
  board.setActiveLayerSurrogate?.(L.id, sur);
  _onAdjustChange();
  _suppressTransientPanels("adjust-color");
}
function _syncAdjustSliders() {
  const s = _adjustState;
  els.adjustBrightness.value = String(s.brightness);
  els.adjustBrightnessVal.textContent = String(s.brightness);
  els.adjustContrast.value = String(s.contrast);
  els.adjustContrastVal.textContent = String(s.contrast);
  els.adjustSaturation.value = String(s.saturation);
  els.adjustSaturationVal.textContent = String(s.saturation);
  els.adjustHue.value = String(s.hue);
  els.adjustHueVal.textContent = `${s.hue}\xB0`;
}
function _onAdjustChange() {
  if (!_adjustState) return;
  const s = _adjustState;
  const outImg = s.surCtx.createImageData(s.srcImg.width, s.srcImg.height);
  if (s.maskData) _bakeBCSHWithMask(s.srcImg.data, outImg.data, s, s.maskData);
  else _bakeBCSHToImageData(s.srcImg.data, outImg.data, s);
  s.surCtx.putImageData(outImg, 0, 0);
  board.invalidateAll();
}
function _closeAdjustPanel(applied) {
  if (!_adjustState) return;
  const L = _adjustState.active;
  board.setActiveLayerSurrogate?.(null, null);
  if (applied) {
    L.ctx.clearRect(0, 0, L.bboxW, L.bboxH);
    L.ctx.drawImage(_adjustState.sur, 0, 0);
    const after = L.snapshot();
    history.push({ type: "stroke", layerId: L.id, before: _adjustState.beforeSnap, after, beforeBlob: null, afterBlob: null });
    _docDirty = true;
    if (isSignedIn()) setCloudDirty(_activeSessionName, true);
    setStatus(`\u989C\u8272\u5DF2\u5E94\u7528\uFF1A${L.name}`);
  }
  _adjustState = null;
  els.adjustPanel.classList.add("hidden");
  _restoreTransientPanels();
  board.invalidateAll();
}
document.getElementById("adjustColor").addEventListener("click", () => {
  setAdjustOpen(false);
  _openAdjustPanel();
});
document.getElementById("adjustReset").addEventListener("click", () => {
  if (!_adjustState) return;
  _adjustState.brightness = 0;
  _adjustState.contrast = 0;
  _adjustState.saturation = 0;
  _adjustState.hue = 0;
  _syncAdjustSliders();
  _onAdjustChange();
});
document.getElementById("adjustCancel").addEventListener("click", () => _closeAdjustPanel(false));
document.getElementById("adjustPanelClose").addEventListener("click", () => _closeAdjustPanel(false));
document.getElementById("adjustApply").addEventListener("click", () => _closeAdjustPanel(true));
els.adjustBrightness.addEventListener("input", () => {
  if (!_adjustState) return;
  _adjustState.brightness = parseFloat(els.adjustBrightness.value) | 0;
  els.adjustBrightnessVal.textContent = String(_adjustState.brightness);
  _onAdjustChange();
});
els.adjustContrast.addEventListener("input", () => {
  if (!_adjustState) return;
  _adjustState.contrast = parseFloat(els.adjustContrast.value) | 0;
  els.adjustContrastVal.textContent = String(_adjustState.contrast);
  _onAdjustChange();
});
els.adjustSaturation.addEventListener("input", () => {
  if (!_adjustState) return;
  _adjustState.saturation = parseFloat(els.adjustSaturation.value) | 0;
  els.adjustSaturationVal.textContent = String(_adjustState.saturation);
  _onAdjustChange();
});
els.adjustHue.addEventListener("input", () => {
  if (!_adjustState) return;
  _adjustState.hue = parseFloat(els.adjustHue.value) | 0;
  els.adjustHueVal.textContent = `${_adjustState.hue}\xB0`;
  _onAdjustChange();
});
(function bindAdjustPanelDrag() {
  let drag = null;
  els.adjustPanelHead.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".float-panel-close")) return;
    const r = els.adjustPanel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.adjustPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.adjustPanelHead.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = els.adjustPanel.offsetWidth, h = els.adjustPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, drag.ol + (e.clientX - drag.sx)));
    const top = Math.max(0, Math.min(window.innerHeight - h, drag.ot + (e.clientY - drag.sy)));
    els.adjustPanel.style.left = left + "px";
    els.adjustPanel.style.top = top + "px";
  });
  els.adjustPanelHead.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.id) {
      try {
        els.adjustPanelHead.releasePointerCapture(e.pointerId);
      } catch {
      }
      drag = null;
    }
  });
})();
els.topGalleryBtn.addEventListener("click", () => {
  setGalleryOpen(true);
});
els.menuRename.addEventListener("click", () => {
  setMenuOpen(false);
  renameCurrentSession();
});
var _EXP_PRJ_KEY = "webpaint:exportProject:v1";
var _EXP_IMG_KEY = "webpaint:exportImage:v1";
var _IMP_IMG_KEY = "webpaint:importImage:v1";
function _getExpPrj() {
  try {
    return JSON.parse(localStorage.getItem(_EXP_PRJ_KEY)) || { format: "ora" };
  } catch {
    return { format: "ora" };
  }
}
function _getExpImg() {
  try {
    return JSON.parse(localStorage.getItem(_EXP_IMG_KEY)) || { format: "png", target: "file" };
  } catch {
    return { format: "png", target: "file" };
  }
}
function _getImpImg() {
  try {
    return JSON.parse(localStorage.getItem(_IMP_IMG_KEY)) || { source: "file" };
  } catch {
    return { source: "file" };
  }
}
function _setExpPrj(v) {
  localStorage.setItem(_EXP_PRJ_KEY, JSON.stringify(v));
  _updateMenuSubLabels();
}
function _setExpImg(v) {
  localStorage.setItem(_EXP_IMG_KEY, JSON.stringify(v));
  _updateMenuSubLabels();
}
function _setImpImg(v) {
  localStorage.setItem(_IMP_IMG_KEY, JSON.stringify(v));
  _updateMenuSubLabels();
}
function _updateMenuSubLabels() {
  const ep = _getExpPrj();
  const ei = _getExpImg();
  const ii = _getImpImg();
  const epEl = document.getElementById("menuExportProjectSub");
  const eiEl = document.getElementById("menuExportImageSub");
  const iiEl = document.getElementById("menuImportImageSub");
  if (epEl) epEl.textContent = "." + ep.format;
  if (eiEl) eiEl.textContent = `${ei.format.toUpperCase()} \xB7 ${ei.target === "clipboard" ? "\u526A\u5207\u677F" : "\u6587\u4EF6"}`;
  if (iiEl) iiEl.textContent = `${ii.source === "clipboard" ? "\u526A\u5207\u677F" : "\u6587\u4EF6"} \xB7 \u65B0\u56FE\u5C42`;
}
_updateMenuSubLabels();
els.menuExportProject.addEventListener("click", async () => {
  setMenuOpen(false);
  const { format } = _getExpPrj();
  try {
    if (format === "psd") {
      setStatus("PSD \u7F16\u7801\u4E2D\u2026", true);
      await exportPsdDownload(doc, `${_activeSessionName}.psd`);
      setStatus(".psd \u5DF2\u4E0B\u8F7D");
    } else {
      await exportOraDownload(doc, `${_activeSessionName}.ora`);
      setStatus(".ora \u5DF2\u4E0B\u8F7D");
    }
  } catch (e) {
    setStatus("\u5BFC\u51FA\u5931\u8D25\uFF1A" + (e && e.message || e));
  }
});
els.menuExportImage.addEventListener("click", async () => {
  setMenuOpen(false);
  const c = _getExpImg();
  try {
    if (c.target === "clipboard") {
      await copyImageToClipboard(doc);
      setStatus("\u5DF2\u590D\u5236 PNG \u5230\u526A\u8D34\u677F");
    } else {
      const r = await shareOrDownloadImage(doc, c.format, `${_activeSessionName}-${stampNow()}`);
      setStatus(r.method === "share" ? "\u5206\u4EAB\u9762\u677F\u5DF2\u5F00" : r.method === "cancel" ? "\u53D6\u6D88\u5206\u4EAB" : `${c.format.toUpperCase()} \u5DF2\u4E0B\u8F7D`);
    }
  } catch (e) {
    setStatus("\u5BFC\u51FA\u5931\u8D25\uFF1A" + (e && e.message || e));
  }
});
els.menuImportImage.addEventListener("click", async () => {
  setMenuOpen(false);
  const { source } = _getImpImg();
  if (source === "clipboard") {
    try {
      const blob = await readImageFromClipboard();
      if (!blob) {
        setStatus("\u526A\u8D34\u677F\u91CC\u6CA1\u6709\u56FE\u7247");
        return;
      }
      const fakeFile = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
      await importImageAsLayer(fakeFile);
    } catch (e) {
      setStatus("\u4ECE\u526A\u8D34\u677F\u7C98\u8D34\u5931\u8D25\uFF1A" + (e && e.message || e));
    }
  } else {
    els.oraFileInput.value = "";
    els.oraFileInput.click();
  }
});
var _layerImportBtn = document.getElementById("layerImportPhotoBtn");
if (_layerImportBtn) {
  _layerImportBtn.addEventListener("click", () => {
    els.oraFileInput.value = "";
    els.oraFileInput.click();
  });
}
function _openMenuConfigPopup(wrenchBtn, html, onApply) {
  document.querySelectorAll(".menu-config-popup").forEach((el) => el.remove());
  const row = wrenchBtn.closest(".menu-item-row");
  if (!row) return;
  const popup = document.createElement("div");
  popup.className = "menu-config-popup";
  popup.innerHTML = html;
  row.appendChild(popup);
  const onPopupChange = () => onApply(popup);
  popup.addEventListener("change", onPopupChange);
  popup.addEventListener("click", (e) => e.stopPropagation());
  setTimeout(() => {
    function onDocClick(ev) {
      if (popup.contains(ev.target) || wrenchBtn.contains(ev.target)) return;
      popup.remove();
      document.removeEventListener("pointerdown", onDocClick, true);
    }
    document.addEventListener("pointerdown", onDocClick, true);
  }, 0);
}
els.menuExportProjectConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getExpPrj();
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">\u683C\u5F0F</div>
      <label><input type="radio" name="fmt" value="ora" ${c.format === "ora" ? "checked" : ""} /> .ora\uFF08\u63A8\u8350 / \u5F00\u6E90\uFF09</label>
      <label><input type="radio" name="fmt" value="psd" ${c.format === "psd" ? "checked" : ""} /> .psd\uFF08Photoshop\uFF09</label>
    </div>
  `, (popup) => {
    const fmt = popup.querySelector('input[name="fmt"]:checked')?.value || "ora";
    _setExpPrj({ format: fmt });
  });
});
els.menuExportImageConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getExpImg();
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">\u683C\u5F0F</div>
      <label><input type="radio" name="fmt" value="png" ${c.format === "png" ? "checked" : ""} /> PNG</label>
      <label><input type="radio" name="fmt" value="jpg" ${c.format === "jpg" ? "checked" : ""} /> JPG</label>
    </div>
    <div class="menu-config-section">
      <div class="menu-config-title">\u53BB\u5411</div>
      <label><input type="radio" name="tgt" value="file" ${c.target === "file" ? "checked" : ""} /> \u6587\u4EF6</label>
      <label><input type="radio" name="tgt" value="clipboard" ${c.target === "clipboard" ? "checked" : ""} /> \u526A\u5207\u677F</label>
    </div>
  `, (popup) => {
    const fmt = popup.querySelector('input[name="fmt"]:checked')?.value || "png";
    const tgt = popup.querySelector('input[name="tgt"]:checked')?.value || "file";
    _setExpImg({ format: fmt, target: tgt });
  });
});
els.menuImportImageConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getImpImg();
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">\u6765\u6E90</div>
      <label><input type="radio" name="src" value="file" ${c.source === "file" ? "checked" : ""} /> \u6587\u4EF6</label>
      <label><input type="radio" name="src" value="clipboard" ${c.source === "clipboard" ? "checked" : ""} /> \u526A\u5207\u677F</label>
    </div>
  `, (popup) => {
    const src = popup.querySelector('input[name="src"]:checked')?.value || "file";
    _setImpImg({ source: src });
  });
});
els.menuFit.addEventListener("click", () => {
  setMenuOpen(false);
  board.fitToScreen();
  updateZoomLabel();
  setStatus("\u9002\u5E94\u5C4F\u5E55");
});
if (els.menuBrushSettings) els.menuBrushSettings.addEventListener("click", () => setMenuOpen(false));
function toggleLiquifyPanel(force) {
  const hidden = els.liquifyPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.liquifyPanel.classList.toggle("hidden", !show);
  if (show) {
    syncLiquifyPanelFromState();
    const saved = safeLS("webpaint.liquifyPanel.pos");
    const w = els.liquifyPanel.offsetWidth || 280;
    let left, top;
    if (saved) {
      try {
        const o = JSON.parse(saved);
        left = o.left;
        top = o.top;
      } catch {
        left = top = null;
      }
    }
    if (left == null) {
      left = window.innerWidth - w - 16;
      top = 60;
    }
    els.liquifyPanel.style.left = Math.max(0, Math.min(window.innerWidth - w, left)) + "px";
    els.liquifyPanel.style.top = Math.max(0, top) + "px";
  }
}
els.liquifyPanelClose.addEventListener("click", () => toggleLiquifyPanel(false));
var _liquifyPanelDrag = null;
els.liquifyPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".float-panel-close")) return;
  const r = els.liquifyPanel.getBoundingClientRect();
  _liquifyPanelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.liquifyPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.liquifyPanelHead.addEventListener("pointermove", (e) => {
  if (!_liquifyPanelDrag || e.pointerId !== _liquifyPanelDrag.id) return;
  const w = els.liquifyPanel.offsetWidth, h = els.liquifyPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _liquifyPanelDrag.ol + (e.clientX - _liquifyPanelDrag.sx)));
  const top = Math.max(0, Math.min(window.innerHeight - h, _liquifyPanelDrag.ot + (e.clientY - _liquifyPanelDrag.sy)));
  els.liquifyPanel.style.left = left + "px";
  els.liquifyPanel.style.top = top + "px";
  safeLSSet("webpaint.liquifyPanel.pos", JSON.stringify({ left, top }));
});
els.liquifyPanelHead.addEventListener("pointerup", (e) => {
  if (_liquifyPanelDrag && e.pointerId === _liquifyPanelDrag.id) {
    try {
      els.liquifyPanelHead.releasePointerCapture(e.pointerId);
    } catch {
    }
    _liquifyPanelDrag = null;
  }
});
function syncLiquifyPanelFromState() {
  const q = state.liquify;
  els.liquifyMode.value = q.mode;
  els.liquifySize.value = String(Math.round(q.size));
  els.liquifySizeVal.textContent = String(Math.round(q.size));
  els.liquifyStrength.value = String(Math.round(q.strength * 100));
  els.liquifyStrengthVal.textContent = String(Math.round(q.strength * 100));
}
els.liquifyMode.addEventListener("change", () => {
  state.liquify.mode = els.liquifyMode.value;
  safeLSSet("webpaint.liquify.mode", state.liquify.mode);
});
els.liquifySize.addEventListener("input", () => {
  const v = parseFloat(els.liquifySize.value);
  state.liquify.size = v;
  els.liquifySizeVal.textContent = String(Math.round(v));
  safeLSSet("webpaint.liquify.size", String(v));
});
els.liquifyStrength.addEventListener("input", () => {
  const v = parseFloat(els.liquifyStrength.value) / 100;
  state.liquify.strength = v;
  els.liquifyStrengthVal.textContent = String(Math.round(v * 100));
  safeLSSet("webpaint.liquify.strength", String(v));
});
var referenceWindow = new ReferenceWindow({
  panel: els.referencePanel,
  head: els.referencePanelHead,
  body: els.referenceBody,
  canvas: els.referenceCanvas,
  closeBtn: els.referencePanelClose,
  emptyHint: els.referenceEmpty,
  status: setStatus
});
var paletteWindow = new PaletteWindow({
  root: document.getElementById("paletteWindow"),
  onColorSampled: (hex) => setColor(hex),
  getCurrentColor: () => state.color
});
els.menuForcePwaReset.addEventListener("click", async () => {
  els.menuPanel?.classList.add("hidden");
  const ok = await openConfirmSheet(
    "\u5F3A\u5236\u6E05\u7F13\u5B58\u91CD\u542F\uFF1F",
    "\u4F1A\u6E05\u6389 SW + Cache Storage\uFF0C\u5F3A\u5236\u91CD\u65B0\u62C9\u6240\u6709 JS / CSS\u3002\u4F60\u7684\u753B / \u7B14\u67B6\uFF08IDB / OneDrive\uFF09\u4E0D\u4F1A\u52A8\u3002\n\u7528\u9014\uFF1APWA \u5361\u8001\u7248\u672C\uFF0C\u70B9\u66F4\u65B0\u8FD8\u662F\u8001\u7684\u65F6\u5019\u7528\u3002"
  );
  if (!ok) return;
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister().catch(() => {
      });
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k).catch(() => {
      });
    }
    setStatus("\u5DF2\u6E05\u7F13\u5B58\uFF0C\u6B63\u5728\u786C\u91CD\u8F7D\u2026", true);
    setTimeout(() => location.reload(), 200);
  } catch (e) {
    setStatus("\u6E05\u7F13\u5B58\u5931\u8D25\uFF1A" + (e.message || e), true);
  }
});
els.menuResetBrushRack.addEventListener("click", async () => {
  els.menuPanel?.classList.add("hidden");
  const ok = await openConfirmSheet(
    "\u91CD\u7F6E\u7B14\u67B6\uFF1F",
    "\u4F1A\u5220\u9664\u5168\u90E8\u81EA\u5B9A\u4E49\u7B14\u5237 + \u6539\u8FC7\u7684\u9ED8\u8BA4\u7B14\uFF0C\u6062\u590D\u51FA\u5382 8 \u4E2A brush\u3002\u4E0D\u53EF\u64A4\u9500\u3002"
  );
  if (!ok) return;
  _brushRack = makeDefaultRack();
  for (const t of Object.keys(state.toolStates)) {
    state.toolStates[t].activeBrushId = null;
    Object.assign(state.toolStates[t], defaultToolStateFor(t));
  }
  await persistBrushRack();
  applyToolState(state.tool);
  if (RACK_PANEL_BY_TOOL[state.tool] === getCurrentExclusive()) _renderRackSheet();
  _rackDirty = true;
  if (isSignedIn()) pushBrushRackIfSignedIn();
  _rackDirty = false;
  setStatus(`\u7B14\u67B6\u5DF2\u91CD\u7F6E\uFF08${_brushRack.brushes.length} \u4E2A brush\uFF09`, true);
});
els.menuReference.addEventListener("click", () => {
  setMenuOpen(false);
  referenceWindow.open();
});
els.referenceLoadBtn.addEventListener("click", () => {
  els.referenceFileInput.value = "";
  els.referenceFileInput.click();
});
els.referenceFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file);
    referenceWindow.setBitmap(bitmap, { persistBlob: file });
    _docDirty = true;
    updateSaveStatus();
    window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));
    setStatus(`\u53C2\u8003\uFF1A${file.name}\uFF08\u4F1A\u8DDF\u5F53\u524D\u753B\u4E00\u8D77\u4FDD\u5B58\uFF09`);
  } catch (err) {
    setStatus("\u53C2\u8003\u56FE\u8F7D\u5165\u5931\u8D25\uFF1A" + (err && err.message || err));
  }
});
els.referenceLiveBtn.addEventListener("click", () => {
  referenceWindow.toggleLive(doc);
  els.referenceLiveBtn.setAttribute("aria-pressed", referenceWindow.isLive() ? "true" : "false");
  setStatus(referenceWindow.isLive() ? "\u53C2\u8003\u5C0F\u7A97\uFF1A\u5B9E\u65F6\u955C\u50CF\u4E3B\u753B\u5E03" : "\u53C2\u8003\u5C0F\u7A97\uFF1A\u5DF2\u9000\u51FA\u5B9E\u65F6\u6A21\u5F0F");
});
els.referenceFitBtn.addEventListener("click", () => referenceWindow.fitToPanel());
els.oraFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const asNewDoc = _addImportAsNewDoc;
  _addImportAsNewDoc = false;
  if (!file) return;
  const isOra = /\.ora$/i.test(file.name);
  const isImage = (file.type || "").startsWith("image/");
  try {
    if (isOra) {
      const loaded = await decodeOraToDoc(file);
      const nm = file.name.replace(/\.ora$/i, "") || "\u672A\u547D\u540D";
      adoptLoadedDoc(loaded, nm);
      setStatus(`\u5DF2\u5BFC\u5165\uFF1A${nm}`);
      setGalleryOpen(false);
    } else if (isImage) {
      if (asNewDoc) {
        await importImageAsNewDoc(file);
        setGalleryOpen(false);
      } else {
        await importImageAsLayer(file);
      }
    } else {
      setStatus(`\u4E0D\u652F\u6301\u7684\u6587\u4EF6\u7C7B\u578B\uFF1A${file.type || file.name}`);
    }
  } catch (err) {
    console.warn("[import] failed:", err);
    setStatus("\u5BFC\u5165\u5931\u8D25\uFF1A" + (err && err.message || err));
  }
});
async function importImageAsNewDoc(file) {
  const bitmap = await createImageBitmap(file);
  const w = Math.min(8192, bitmap.width);
  const h = Math.min(8192, bitmap.height);
  if (_docDirty) await saveNow();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers;
  doc.activeIndex = 0;
  doc.width = w;
  doc.height = h;
  els.canvasSizeLabel.textContent = `${w}\xD7${h}`;
  const layer = doc.layers[0];
  layer.name = file.name.replace(/\.[^.]+$/, "") || "\u56FE\u50CF";
  layer.bboxX = 0;
  layer.bboxY = 0;
  layer.bboxW = w;
  layer.bboxH = h;
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : (() => {
    const x = document.createElement("canvas");
    x.width = w;
    x.height = h;
    return x;
  })();
  layer.canvas = c;
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = true;
  layer.ctx.imageSmoothingQuality = "high";
  layer.ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const stem = file.name.replace(/\.[^.]+$/, "") || "\u5BFC\u5165";
  const name = await uniqueLocalName(stem);
  _activeSessionName = name;
  setCurrentSessionName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _docDirty = true;
  _docLastSavedAt = 0;
  updateSaveStatus();
  await saveNow();
  setStatus(`\u65B0\u5EFA\uFF08\u7167\u7247\uFF09\uFF1A${name}\uFF08${w}\xD7${h}\uFF09`);
}
async function importImageAsLayer(file) {
  const bitmap = await createImageBitmap(file);
  const docW = doc.width, docH = doc.height;
  let w = bitmap.width, h = bitmap.height;
  if (w > docW || h > docH) {
    const s = Math.min(docW / w, docH / h) * 0.8;
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const layer = doc.addLayer(file.name.replace(/\.[^.]+$/, ""));
  if (!layer) {
    bitmap.close?.();
    setStatus(`\u56FE\u5C42\u5DF2\u8FBE\u4E0A\u9650 (${doc.maxLayers})\uFF0C\u65E0\u6CD5\u5BFC\u5165`);
    return;
  }
  layer.bboxX = Math.floor((docW - w) / 2);
  layer.bboxY = Math.floor((docH - h) / 2);
  layer.bboxW = w;
  layer.bboxH = h;
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : (() => {
    const x = document.createElement("canvas");
    x.width = w;
    x.height = h;
    return x;
  })();
  layer.canvas = c;
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = true;
  layer.ctx.imageSmoothingQuality = "high";
  layer.ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
  _docDirty = true;
  updateSaveStatus();
  window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));
  try {
    const sel = _makeFullLayerSelection(layer);
    if (sel) {
      doc.selection = sel;
      setTool("lasso");
      const ok = input.lasso.liftSelectionForTransform(layer);
      if (ok) {
        input.lasso.setMode("free");
        updateLassoToolbar();
        _suppressTransientPanels("transform");
        board.invalidateAll();
        setStatus(`\u5DF2\u5BFC\u5165\uFF1A${file.name}\uFF08\u62D6\u89D2\u53D8\u6362 \u2192 \u5E94\u7528 / \u53D6\u6D88\uFF09`);
        return;
      }
    }
  } catch (e) {
    console.warn("[import auto-transform]", e);
  }
  setStatus(`\u5DF2\u5BFC\u5165\u4E3A\u65B0\u56FE\u5C42\uFF1A${file.name}`);
}
function _makeFullLayerSelection(layer) {
  const w = layer.bboxW, h = layer.bboxH;
  if (w <= 0 || h <= 0) return null;
  const mask = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : (() => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  })();
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#fff";
  mctx.fillRect(0, 0, w, h);
  return { bboxX: layer.bboxX, bboxY: layer.bboxY, bboxW: w, bboxH: h, maskCanvas: mask };
}
var _galleryUrls = [];
async function setGalleryOpen(open) {
  if (open) {
    applyAllPendingTransients();
    if (_docDirty && !_docSaving) await saveNow();
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    renderGallery();
    updateIdbUsage();
  } else {
    applyAllPendingTransients();
    if (_docDirty && !_docSaving) await saveNow();
    els.galleryFull.classList.add("hidden");
    delete document.body.dataset.mode;
    for (const u of _galleryUrls) URL.revokeObjectURL(u);
    _galleryUrls = [];
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    board.requestRender();
  }
}
els.galleryCloseBtn.addEventListener("click", () => setGalleryOpen(false));
els.galleryAddBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const hidden = els.galleryAddPopup.classList.contains("hidden");
  els.cloudAccountPopup.classList.add("hidden");
  els.galleryAddPopup.classList.toggle("hidden", !hidden);
  if (hidden) anchorPopupToBtn(els.galleryAddPopup, els.galleryAddBtn);
  els.galleryAddBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
});
els.cloudIconBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const hidden = els.cloudAccountPopup.classList.contains("hidden");
  els.galleryAddPopup.classList.add("hidden");
  els.cloudAccountPopup.classList.toggle("hidden", !hidden);
  if (hidden) anchorPopupToBtn(els.cloudAccountPopup, els.cloudIconBtn);
  els.cloudIconBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
});
document.addEventListener("pointerdown", (e) => {
  if (!els.galleryAddPopup.classList.contains("hidden") && !els.galleryAddPopup.contains(e.target) && !els.galleryAddBtn.contains(e.target)) {
    els.galleryAddPopup.classList.add("hidden");
  }
  if (!els.cloudAccountPopup.classList.contains("hidden") && !els.cloudAccountPopup.contains(e.target) && !els.cloudIconBtn.contains(e.target)) {
    els.cloudAccountPopup.classList.add("hidden");
  }
});
function anchorPopupToBtn(popup, btn) {
  const r = btn.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.top = r.bottom + 4 + "px";
  popup.style.right = window.innerWidth - r.right + "px";
  popup.style.left = "auto";
}
els.addNew.addEventListener("click", () => {
  els.galleryAddPopup.classList.add("hidden");
  openNewDocSheet();
});
els.addImportPhoto.addEventListener("click", () => {
  els.galleryAddPopup.classList.add("hidden");
  els.oraFileInput.value = "";
  els.oraFileInput.click();
  _addImportAsNewDoc = true;
});
els.addImportClipboard.addEventListener("click", async () => {
  els.galleryAddPopup.classList.add("hidden");
  try {
    const blob = await readImageFromClipboard();
    if (!blob) {
      setStatus("\u526A\u8D34\u677F\u91CC\u6CA1\u6709\u56FE\u7247");
      return;
    }
    const file = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
    await importImageAsNewDoc(file);
    setGalleryOpen(false);
  } catch (e) {
    setStatus("\u4ECE\u526A\u5207\u677F\u65B0\u5EFA\u5931\u8D25\uFF1A" + (e && e.message || e));
  }
});
var _addImportAsNewDoc = false;
function openNewDocSheet() {
  els.newDocName.value = "\u672A\u547D\u540D";
  els.newDocPreset.value = "2048";
  els.newDocCustomRow.style.display = "none";
  els.newDocW.value = doc.width;
  els.newDocH.value = doc.height;
  els.newDocBackdrop.classList.remove("hidden");
  els.newDocSheet.classList.remove("hidden");
  setTimeout(() => els.newDocName.focus(), 50);
}
function closeNewDocSheet() {
  els.newDocBackdrop.classList.add("hidden");
  els.newDocSheet.classList.add("hidden");
}
els.newDocPreset.addEventListener("change", () => {
  els.newDocCustomRow.style.display = els.newDocPreset.value === "custom" ? "" : "none";
});
els.newDocBackdrop.addEventListener("click", closeNewDocSheet);
els.newDocCancel.addEventListener("click", closeNewDocSheet);
els.newDocConfirm.addEventListener("click", async () => {
  const nameRaw = (els.newDocName.value || "").trim() || "\u672A\u547D\u540D";
  let w, h;
  if (els.newDocPreset.value === "custom") {
    w = Math.max(64, Math.min(8192, parseInt(els.newDocW.value, 10) || 2048));
    h = Math.max(64, Math.min(8192, parseInt(els.newDocH.value, 10) || 2048));
  } else {
    w = h = parseInt(els.newDocPreset.value, 10);
  }
  const name = await uniqueLocalName(nameRaw);
  closeNewDocSheet();
  if (_docDirty) await saveNow();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers;
  doc.activeIndex = 0;
  doc.width = w;
  doc.height = h;
  doc.selection = null;
  doc.referenceLayerId = null;
  els.canvasSizeLabel.textContent = `${w}\xD7${h}`;
  _activeSessionName = name;
  setCurrentSessionName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _docDirty = true;
  _docLastSavedAt = 0;
  updateSaveStatus();
  referenceWindow.clearBitmap();
  await saveNow();
  setGalleryOpen(false);
  setStatus(`\u65B0\u5EFA\uFF1A${name}\uFF08${w}\xD7${h}\uFF09`);
});
async function updateIdbUsage() {
  try {
    const sessions = await listSessions();
    let total = 0;
    for (const s of sessions) total += s.size || 0;
    let label = `\u672C\u5730\u5360\u7528\uFF1A${humanSize(total)}\uFF08${sessions.length} \u4EF6\uFF09`;
    let level = "ok";
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        const ratio = (est.usage || 0) / est.quota;
        const pct = Math.round(ratio * 100);
        els.galleryFootUsage.title = `\u6D4F\u89C8\u5668\u5206\u914D\u4E0A\u9650\u7EA6 ${humanSize(est.quota)}\uFF1B\u5F53\u524D ${pct}% \u5DF2\u7528\uFF08\u542B SW \u7F13\u5B58\u7B49\uFF09`;
        if (ratio > 0.95) {
          level = "critical";
          label += ` \xB7 \u5DF2\u7528 ${pct}%`;
        } else if (ratio > 0.8) {
          level = "warn";
          label += ` \xB7 \u5DF2\u7528 ${pct}%`;
        }
      }
    }
    els.galleryFootUsage.textContent = label;
    els.galleryFootUsage.classList.toggle("usage-warn", level === "warn");
    els.galleryFootUsage.classList.toggle("usage-critical", level === "critical");
  } catch {
    els.galleryFootUsage.textContent = "\u5360\u7528\uFF1A\u672A\u77E5";
  }
}
var _lastQuotaWarnLevel = "ok";
async function checkQuotaAndWarn() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const est = await navigator.storage.estimate();
    if (!est || !est.quota) return;
    const ratio = (est.usage || 0) / est.quota;
    const pct = Math.round(ratio * 100);
    let level = "ok";
    if (ratio > 0.95) level = "critical";
    else if (ratio > 0.8) level = "warn";
    if (level === _lastQuotaWarnLevel) return;
    _lastQuotaWarnLevel = level;
    if (level === "critical") {
      setStatus(`\u672C\u5730\u5B58\u50A8 ${pct}% \u5DF2\u6EE1 \u2014 \u7ACB\u5373\u53BB\u56FE\u5E93\u5378\u8F7D\u4E0D\u5E38\u7528\u7684\u4F5C\u54C1`, true);
    } else if (level === "warn") {
      setStatus(`\u672C\u5730\u5B58\u50A8 ${pct}% \u5DF2\u7528 \u2014 \u5EFA\u8BAE\u5728\u56FE\u5E93\u6574\u7406`, true);
    }
  } catch {
  }
}
async function renderGallery() {
  updateCloudAuthUI();
  updateIdbUsage();
  for (const u of _galleryUrls) URL.revokeObjectURL(u);
  _galleryUrls = [];
  let local = [];
  try {
    local = await listSessions();
  } catch (e) {
    console.error("[gallery] listSessions failed:", e);
    setStatus("\u672C\u5730\u56FE\u5E93\u8BFB\u53D6\u5931\u8D25\uFF1A" + (e && e.message || e) + "\uFF08\u53EF\u80FD\u662F\u9690\u79C1\u7A97\u53E3 / IDB \u88AB\u7981\uFF09", true);
  }
  let cloud = [];
  if (isSignedIn() && navigator.onLine !== false) {
    try {
      cloud = await listCloudSessionsRecursive();
    } catch (e) {
      console.warn("[cloud] list failed:", e);
    }
  }
  const byName = /* @__PURE__ */ new Map();
  for (const l of local) {
    byName.set(l.name, { name: l.name, local: l, cloud: null });
  }
  for (const c of cloud) {
    const name = c.path.replace(/\.ora$/i, "");
    const ent = byName.get(name);
    if (ent) ent.cloud = c;
    else byName.set(name, { name, local: null, cloud: c });
  }
  const merged = [...byName.values()];
  merged.sort((a, b) => {
    const ta = a.local?.updatedAt || Date.parse(a.cloud?.lastModifiedDateTime || 0);
    const tb = b.local?.updatedAt || Date.parse(b.cloud?.lastModifiedDateTime || 0);
    return tb - ta;
  });
  els.galleryGrid.innerHTML = "";
  if (merged.length === 0) {
    els.galleryEmpty.classList.remove("hidden");
    els.galleryGrid.style.display = "none";
    return;
  }
  els.galleryEmpty.classList.add("hidden");
  els.galleryGrid.style.display = "";
  for (const item of merged) {
    const isLocal = !!item.local;
    const isCloud = !!item.cloud;
    const tile = document.createElement("div");
    tile.className = "gallery-tile" + (item.name === _activeSessionName ? " active" : "");
    let thumbEl;
    if (isLocal && item.local.thumb) {
      thumbEl = document.createElement("img");
      thumbEl.className = "gallery-tile-thumb";
      thumbEl.alt = item.name;
      const url = URL.createObjectURL(item.local.thumb);
      _galleryUrls.push(url);
      thumbEl.src = url;
      thumbEl.loading = "lazy";
    } else {
      thumbEl = document.createElement("div");
      thumbEl.className = "gallery-tile-thumb placeholder";
      if (isCloud) {
        thumbEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:48px;height:48px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
      } else {
        thumbEl.textContent = item.name.slice(0, 1) || "?";
      }
    }
    tile.appendChild(thumbEl);
    const info = document.createElement("div");
    info.className = "gallery-tile-info";
    const nm = document.createElement("div");
    nm.className = "gallery-tile-name";
    nm.textContent = item.name;
    const meta = document.createElement("div");
    meta.className = "gallery-tile-meta";
    const t = item.local?.updatedAt || Date.parse(item.cloud?.lastModifiedDateTime || 0);
    const sz = item.local?.size || item.cloud?.size || 0;
    const signedIn = isSignedIn();
    let stateLabel;
    if (isLocal && isCloud) stateLabel = "\u672C\u5730+\u4E91";
    else if (isCloud) stateLabel = "\u7EAF\u4E91\u7AEF";
    else if (isLocal && signedIn) stateLabel = "\u672A\u4E0A\u4F20";
    else stateLabel = "\u672C\u5730";
    meta.textContent = `${stateLabel} \xB7 ${humanTime(t)} \xB7 ${humanSize(sz)}`;
    info.appendChild(nm);
    info.appendChild(meta);
    tile.appendChild(info);
    const actions = document.createElement("div");
    actions.className = "gallery-tile-actions";
    if (isCloud && !isLocal) {
      const pullBtn = document.createElement("button");
      pullBtn.type = "button";
      pullBtn.textContent = "\u62C9\u53D6";
      pullBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        pullBtn.disabled = true;
        pullBtn.textContent = "\u62C9\u53D6\u4E2D\u2026";
        await pullCloudPath(item.cloud.path);
        pullBtn.disabled = false;
        pullBtn.textContent = "\u62C9\u53D6";
      });
      actions.appendChild(pullBtn);
    } else if (isLocal && !isCloud && signedIn) {
      const pushBtn = document.createElement("button");
      pushBtn.type = "button";
      pushBtn.textContent = "\u63A8\u9001";
      pushBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        pushBtn.disabled = true;
        pushBtn.textContent = "\u63A8\u9001\u4E2D\u2026";
        try {
          const loaded = await openSession(item.name);
          if (!loaded) throw new Error("\u627E\u4E0D\u5230\u672C\u5730 session");
          const ora = await encodeDocToOra(loaded, {
            referenceImage: loaded._referenceBlob,
            webpaintState: loaded._webpaintState
          });
          await pushSession(item.name, ora);
          setStatus(`\u5DF2\u63A8\u9001\uFF1A${item.name}`);
          renderGallery();
        } catch (err) {
          if (err instanceof CloudConflictError) {
            setStatus(`\u4E91\u7AEF\u51B2\u7A81\uFF1A${item.name}\uFF08\u5148\u6539\u540D\u518D\u63A8\uFF09`, true);
          } else {
            setStatus("\u63A8\u9001\u5931\u8D25\uFF1A" + (err && err.message || err));
          }
        } finally {
          pushBtn.disabled = false;
          pushBtn.textContent = "\u63A8\u9001";
        }
      });
      actions.appendChild(pushBtn);
    } else if (isLocal && isCloud) {
      const offloadBtn = document.createElement("button");
      offloadBtn.type = "button";
      offloadBtn.textContent = "\u5378\u8F7D\u672C\u5730";
      offloadBtn.title = "\u6E05\u8FD9\u5E45\u753B\u7684\u672C\u5730 IDB \u526F\u672C\uFF0C\u4E91\u7AEF\u4FDD\u7559\u3002\u4E0B\u6B21\u9700\u8981\u53EF\u70B9\u62C9\u53D6\u3002";
      offloadBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (item.name === _activeSessionName) {
          setStatus("\u6B63\u5728\u7F16\u8F91\u8FD9\u5E45\u753B\uFF0C\u4E0D\u80FD\u5378\u8F7D\u672C\u5730\u526F\u672C");
          return;
        }
        offloadBtn.disabled = true;
        offloadBtn.textContent = "\u5378\u8F7D\u4E2D\u2026";
        try {
          await removeSession(item.name);
          setStatus(`\u5DF2\u5378\u8F7D\u672C\u5730\uFF1A${item.name}\uFF08\u4E91\u7AEF\u4FDD\u7559\uFF09`);
          renderGallery();
        } catch (err) {
          setStatus("\u5378\u8F7D\u5931\u8D25\uFF1A" + (err && err.message || err));
        } finally {
          offloadBtn.disabled = false;
          offloadBtn.textContent = "\u5378\u8F7D\u672C\u5730";
        }
      });
      actions.appendChild(offloadBtn);
    }
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.textContent = "\u91CD\u547D\u540D";
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (item.name === _activeSessionName) {
        const newName = await renameCurrentSession();
        if (newName) renderGallery();
        return;
      }
      if (!isLocal) {
        setStatus("\u7EAF\u4E91\u7AEF\u4E0D\u652F\u6301\u56FE\u5E93\u76F4\u63A5\u91CD\u547D\u540D\uFF08\u5148\u62C9\u53D6\u5230\u672C\u5730\uFF09", true);
        return;
      }
      const input2 = await openInputSheet("\u91CD\u547D\u540D", item.name, { placeholder: "\u65B0\u540D\u5B57" });
      if (input2 == null) return;
      const trimmed = input2.trim();
      if (!trimmed || trimmed === item.name) return;
      const localNames = (await listSessions()).map((s) => s.name);
      if (localNames.includes(trimmed)) {
        setStatus(`\u672C\u5730\u5DF2\u6709\u540C\u540D "${trimmed}"\uFF0C\u6362\u4E00\u4E2A`, true);
        return;
      }
      try {
        const loaded = await openSession(item.name);
        if (!loaded) throw new Error("\u627E\u4E0D\u5230\u672C\u5730 session");
        await saveSession(loaded, trimmed, {
          referenceImage: loaded._referenceBlob,
          webpaintState: loaded._webpaintState
        });
        await removeSession(item.name);
        if (isCloud) {
          setStatus(`\u5DF2\u91CD\u547D\u540D\u672C\u5730\uFF1A${item.name} \u2192 ${trimmed}\uFF08\u4E91\u7AEF\u65E7\u540D\u300C${item.name}\u300D\u4ECD\u5728\uFF0C\u9700\u5355\u72EC\u5904\u7406\uFF09`, true);
        } else {
          setStatus(`\u5DF2\u91CD\u547D\u540D\uFF1A${item.name} \u2192 ${trimmed}`);
        }
        renderGallery();
      } catch (err) {
        setStatus("\u91CD\u547D\u540D\u5931\u8D25\uFF1A" + (err && err.message || err), true);
      }
    });
    actions.appendChild(renameBtn);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = isCloud && !isLocal ? "\u5220\u9664\uFF08\u4E91\uFF09" : isLocal && isCloud ? "\u5220\u9664\uFF08\u672C\u5730+\u4E91\uFF09" : "\u5220\u9664";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await openConfirmSheet(`\u5220\u9664 "${item.name}"\uFF1F`, `${isLocal ? "\u672C\u5730 " : ""}${isCloud ? "\u4E91\u7AEF " : ""}\u4E0D\u53EF\u64A4\u9500\u3002`);
      if (!ok) return;
      try {
        if (isLocal) await removeSession(item.name);
        if (isCloud) await deleteCloudSession(item.name);
        if (item.name === _activeSessionName && isLocal) {
          setStatus(`\u5DF2\u5220\u9664\uFF08\u5F53\u524D\u5728\u5185\u5B58\u91CC\uFF0C\u53EF\u4FDD\u5B58\u526F\u672C\u4E3A\u65B0\u540D\u5B57\u4FDD\u7559\uFF09`);
        } else {
          setStatus(`\u5DF2\u5220\u9664\uFF1A${item.name}`);
        }
        renderGallery();
      } catch (err) {
        setStatus("\u5220\u9664\u5931\u8D25\uFF1A" + (err && err.message || err));
      }
    });
    actions.appendChild(del);
    tile.appendChild(actions);
    tile.addEventListener("click", async (e) => {
      if (e.target.closest(".gallery-tile-actions")) return;
      if (item.name === _activeSessionName) {
        setGalleryOpen(false);
        return;
      }
      if (_docDirty) await saveNow();
      if (isLocal) {
        try {
          const loaded = await openSession(item.name);
          if (!loaded) {
            setStatus(`\u627E\u4E0D\u5230\uFF1A${item.name}`);
            return;
          }
          adoptLoadedDoc(loaded, item.name);
          setGalleryOpen(false);
          setStatus(`\u5DF2\u6253\u5F00\uFF1A${item.name}`);
          gateCloudSyncOnOpen(item.name).catch((e2) => console.warn("[sync-gate]", e2));
        } catch (err) {
          setStatus("\u6253\u5F00\u5931\u8D25\uFF1A" + (err && err.message || err));
        }
      } else if (isCloud) {
        await pullCloudPath(item.cloud.path);
      }
    });
    els.galleryGrid.appendChild(tile);
  }
}
function humanTime(ts) {
  if (!ts) return "\u672A\u77E5";
  const d = new Date(ts);
  const now = Date.now();
  const dt = now - ts;
  if (dt < 60 * 1e3) return "\u521A\u521A";
  if (dt < 60 * 60 * 1e3) return `${Math.floor(dt / 6e4)} \u5206\u949F\u524D`;
  if (dt < 24 * 60 * 60 * 1e3) return `${Math.floor(dt / 36e5)} \u5C0F\u65F6\u524D`;
  if (dt < 7 * 24 * 60 * 60 * 1e3) return `${Math.floor(dt / 864e5)} \u5929\u524D`;
  return d.toLocaleDateString();
}
function humanSize(b) {
  if (b == null) return "?";
  if (b === 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
var ICON_CLOUD_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
var ICON_CLOUD_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';
function updateCloudAuthUI() {
  const signed = isSignedIn();
  const configured = isAuthConfigured();
  const offline = navigator.onLine === false;
  if (signed) {
    const acc = getActiveAccount();
    els.cloudIconBtn.innerHTML = ICON_CLOUD_IN;
    els.cloudIconBtn.dataset.cloudState = "signedin";
    const who = acc?.username || acc?.name || "\u5DF2\u767B\u5F55";
    els.cloudIconBtn.title = offline ? `\u4E91\u7AEF\uFF1A${who}\uFF08\u79BB\u7EBF\uFF0C\u65E0\u6CD5\u63A8 / \u62C9\uFF09` : `\u4E91\u7AEF\uFF1A${who}\uFF08\u70B9\u5F00\u8D26\u53F7\u83DC\u5355\uFF09`;
    els.cloudAccountInfo.textContent = offline ? `\u4E91\u7AEF\uFF1A${who}\uFF08\u79BB\u7EBF\uFF09` : `\u4E91\u7AEF\uFF1A${who}`;
    els.cloudSignInBtn.classList.add("hidden");
    els.cloudSignOutBtn.classList.remove("hidden");
    els.cloudRefreshBtn.classList.toggle("hidden", offline);
  } else {
    els.cloudIconBtn.innerHTML = ICON_CLOUD_OUT;
    els.cloudIconBtn.dataset.cloudState = configured ? "out" : "unconfigured";
    if (offline && configured) {
      els.cloudIconBtn.title = "\u4E91\u7AEF\uFF1A\u79BB\u7EBF\uFF08\u65E0\u6CD5\u767B\u5F55 / \u540C\u6B65\uFF1B\u672C\u5730\u56FE\u5E93\u6B63\u5E38\uFF09";
      els.cloudAccountInfo.textContent = "\u4E91\u7AEF\uFF1A\u79BB\u7EBF";
    } else {
      els.cloudIconBtn.title = configured ? "\u4E91\u7AEF\uFF1A\u672A\u767B\u5F55\uFF08\u70B9\u5F00\u767B\u5F55\uFF09" : "\u4E91\u7AEF\uFF1A\u672A\u914D\u7F6E";
      els.cloudAccountInfo.textContent = configured ? "\u4E91\u7AEF\uFF1A\u672A\u767B\u5F55" : "\u4E91\u7AEF\uFF1A\u672A\u914D\u7F6E";
    }
    els.cloudSignInBtn.classList.toggle("hidden", !configured || offline);
    els.cloudSignOutBtn.classList.add("hidden");
    els.cloudRefreshBtn.classList.add("hidden");
  }
  updateSaveStatus();
}
els.cloudSignInBtn.addEventListener("click", async () => {
  els.cloudAccountPopup.classList.add("hidden");
  if (!isAuthConfigured()) {
    setStatus("\u5C1A\u672A\u914D\u7F6E OneDrive \u5BA2\u6237\u7AEF");
    return;
  }
  try {
    await signIn();
    setLastSessionSignedIn(true);
  } catch (e) {
    setStatus("\u767B\u5F55\u5931\u8D25\uFF1A" + (e && e.message || e));
  }
});
els.cloudSignOutBtn.addEventListener("click", async () => {
  els.cloudAccountPopup.classList.add("hidden");
  try {
    await signOut();
  } catch (_) {
  }
  setLastSessionSignedIn(false);
  updateCloudAuthUI();
  renderGallery();
});
els.cloudRefreshBtn.addEventListener("click", async () => {
  if (!isSignedIn() && navigator.onLine !== false) {
    await retrySilentSignIn();
    updateCloudAuthUI();
  }
  renderGallery();
});
async function uniqueLocalName(stem) {
  const existing = new Set((await listSessions()).map((s) => s.name));
  if (!existing.has(stem)) return stem;
  for (let i = 1; i < 100; i++) {
    const candidate = `${stem} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}`;
}
async function pullCloudPath(path) {
  try {
    const r = await pullSessionByPath(path);
    if (!r) {
      setStatus(`\u627E\u4E0D\u5230\uFF1A${path}`);
      return;
    }
    const loaded = await decodeOraToDoc(r.blob);
    const finalName = await uniqueLocalName(r.suggestedName);
    await saveSession(loaded, finalName, {
      referenceImage: loaded._referenceBlob,
      webpaintState: loaded._webpaintState
    });
    setStatus(`\u5DF2\u4ECE\u4E91\u7AEF\u62C9\u53D6\u5230\u672C\u5730\uFF1A${finalName}\uFF08\u70B9 tile \u6253\u5F00\uFF09`);
    renderGallery();
  } catch (err) {
    console.warn("[cloud] pull failed:", err);
    setStatus("\u62C9\u53D6\u5931\u8D25\uFF1A" + (err && err.message || err));
  }
}
setStatus("\u5C31\u7EEA");
updateZoomLabel();
updateSaveStatus();
updateCloudAuthUI();
if (isAuthConfigured()) {
  initAuth().then(() => {
    if (isSignedIn()) setLastSessionSignedIn(true);
    updateCloudAuthUI();
  }).catch((e) => {
    console.warn("[auth] init failed:", e);
  });
}
window.addEventListener("online", async () => {
  if (!isSignedIn()) await retrySilentSignIn();
  updateCloudAuthUI();
  if (!els.galleryFull.classList.contains("hidden")) renderGallery();
});
window.addEventListener("offline", () => {
  updateCloudAuthUI();
});
(async () => {
  const wantedName = getCurrentSessionName();
  try {
    const loaded = await loadCurrentSession();
    if (!loaded) {
      _activeSessionName = wantedName;
      updateSaveStatus();
      return;
    }
    adoptLoadedDoc(loaded, wantedName);
    setStatus(`\u5DF2\u6062\u590D\uFF1A${wantedName} (${loaded.layers.length} \u5C42)`);
    gateCloudSyncOnOpen(wantedName).catch((e) => console.warn("[sync-gate]", e));
  } catch (e) {
    console.warn("[session] load failed:", e);
    _activeSessionName = "\u672A\u547D\u540D";
    updateSaveStatus();
    setStatus(`\u542F\u52A8\u52A0\u8F7D "${wantedName}" \u5931\u8D25\uFF0C\u4F7F\u7528\u7A7A\u767D\u6587\u6863`);
  }
})();
var _rackEls = {
  sheet: document.getElementById("brushRackSheet"),
  title: document.getElementById("brushRackTitle"),
  close: document.getElementById("brushRackClose"),
  importBtn: document.getElementById("brushRackImport"),
  newBtn: document.getElementById("brushRackNew"),
  folders: document.getElementById("brushRackFolders"),
  grid: document.getElementById("brushRackGrid"),
  // v99 footer 操作
  exportFolderBtn: document.getElementById("brushRackExportFolder"),
  cloudPushBtn: document.getElementById("brushRackCloudPush"),
  resetBtn: document.getElementById("brushRackReset"),
  dumpCodeBtn: document.getElementById("brushRackDumpCode")
};
var _settingsEls = {
  view: document.getElementById("brushSettingsView"),
  body: document.getElementById("brushSettingsBody"),
  save: document.getElementById("brushSettingsSave"),
  cancel: document.getElementById("brushSettingsCancel")
};
var TOOL_LABEL = {
  brush: "\u7B14\u5237",
  smudge: "\u6D82\u62B9",
  eraser: "\u6A61\u76AE",
  // v120 删 shapes / airbrush（旧 brush.tool 持久化里可能还在，留映射给 UI 翻译）
  shapes: "\u5F62\u72B6",
  airbrush: "\u55B7\u67AA"
};
var _rackCurrentFolder = DEFAULT_FOLDER;
var _rackCurrentTool = "brush";
var _rackDirty = false;
function _showRackSheet(tool) {
  if (!_brushRack) return;
  _rackCurrentTool = tool;
  _rackEls.title.textContent = `\u7B14\u67B6 \xB7 ${TOOL_LABEL[tool] || tool}`;
  _renderRackSheet();
  _rackEls.sheet.classList.remove("hidden");
}
function _hideRackSheet() {
  _rackEls.sheet.classList.add("hidden");
  if (_rackDirty) {
    persistBrushRack();
    pushBrushRackIfSignedIn();
    _rackDirty = false;
  }
}
async function pushBrushRackIfSignedIn() {
  if (!isSignedIn() || !navigator.onLine) return;
  if (!_brushRack) return;
  try {
    await pushBrushRack(_brushRack);
    setStatus("\u7B14\u67B6\u5DF2\u540C\u6B65\u5230\u4E91\u7AEF");
  } catch (e) {
    if (e instanceof CloudConflictError) {
      const choice = await lockSyncGate({
        title: "\u7B14\u67B6\u4E91\u7AEF\u6709\u66F4\u65B0\u7248\u672C",
        message: "\u53E6\u4E00\u53F0\u8BBE\u5907\u6539\u8FC7\u4E91\u7AEF\u7B14\u67B6\u3002\u63A8\u4F1A\u8986\u76D6\u90A3\u6B21\u6539\u52A8\u3002",
        showSpinner: false,
        actions: [
          { label: "\u62C9\u4E91\u7AEF\u8986\u76D6\u672C\u5730", value: "pull", primary: true },
          { label: "\u4FDD\u7559\u672C\u5730\uFF08\u4E4B\u540E\u53EF\u91CD\u63A8\uFF09", value: "keep" }
        ]
      });
      if (choice === "pull") {
        try {
          const pulled = await pullBrushRack();
          if (pulled?.rack) {
            _brushRack = pulled.rack;
            mergeMissingDefaults(_brushRack);
            await persistBrushRack();
            applyToolState(state.tool);
            setStatus("\u5DF2\u62C9\u4E91\u7AEF\u7B14\u67B6");
          }
        } catch (err) {
          setStatus("\u62C9\u4E91\u7AEF\u7B14\u67B6\u5931\u8D25\uFF1A" + (err.message || err), true);
        }
      }
    } else {
      console.warn("[brush-rack push]", e);
      setStatus("\u7B14\u67B6\u63A8\u9001\u5931\u8D25\uFF1A" + (e.message || e), true);
    }
  }
}
async function checkBrushRackCloud() {
  if (!isAuthConfigured() || !navigator.onLine || !isSignedIn()) return;
  if (!_brushRack) return;
  try {
    const meta = await fetchBrushRackMetadata();
    if (!meta) return;
    const localETag = getBrushRackKnownETag();
    if (meta.etag === localETag) return;
    if (_rackDirty) {
      return;
    }
    const pulled = await pullBrushRack();
    if (pulled?.rack) {
      _brushRack = pulled.rack;
      mergeMissingDefaults(_brushRack);
      await persistBrushRack();
      applyToolState(state.tool);
      setStatus("\u7B14\u67B6\u5DF2\u4ECE\u4E91\u7AEF\u540C\u6B65");
    }
  } catch (e) {
    console.warn("[brush-rack cloud check]", e);
  }
}
function _renderRackSheet() {
  if (!_brushRack || !_brushRack.brushes || _brushRack.brushes.length === 0) {
    _rackEls.folders.innerHTML = "";
    _rackEls.grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-soft);">
      \u7B14\u67B6\u662F\u7A7A\u7684\u3002<br><br>
      <button class="brush-rack-action" id="_rackEmptyResetBtn">\u6062\u590D\u9ED8\u8BA4\u7B14\u67B6\uFF088 \u4E2A\uFF09</button>
    </div>`;
    const btn = document.getElementById("_rackEmptyResetBtn");
    if (btn) btn.addEventListener("click", () => {
      _brushRack = makeDefaultRack();
      for (const t of Object.keys(state.toolStates)) {
        state.toolStates[t].activeBrushId = null;
        Object.assign(state.toolStates[t], defaultToolStateFor(t));
      }
      _rackDirty = true;
      persistBrushRack();
      applyToolState(state.tool);
      _renderRackSheet();
      setStatus(`\u5DF2\u6062\u590D\u9ED8\u8BA4\u7B14\u67B6\uFF08${_brushRack.brushes.length} \u4E2A\uFF09`, true);
    });
    return;
  }
  const brushes = brushesByTool(_brushRack, _rackCurrentTool);
  if (brushes.length === 0) {
    _rackEls.folders.innerHTML = "";
    _rackEls.grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-soft);">
      \u6B64\u5DE5\u5177\u6682\u65E0\u7B14\u5237\u3002\u70B9\u300C+ \u65B0\u5EFA\u300D\u52A0\u4E00\u4E2A\u3002
    </div>`;
    return;
  }
  const folderSet = /* @__PURE__ */ new Set();
  for (const b of brushes) folderSet.add(b.folder || DEFAULT_FOLDER);
  if (folderSet.size === 0) folderSet.add(DEFAULT_FOLDER);
  const folders = Array.from(folderSet);
  if (!folders.includes(_rackCurrentFolder)) _rackCurrentFolder = folders[0];
  _rackEls.folders.innerHTML = "";
  for (const f of folders) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "brush-rack-folder";
    btn.textContent = f;
    btn.setAttribute("aria-pressed", f === _rackCurrentFolder ? "true" : "false");
    btn.addEventListener("click", () => {
      _rackCurrentFolder = f;
      _renderRackSheet();
    });
    _rackEls.folders.appendChild(btn);
  }
  const activeId = state.toolStates[_rackCurrentTool]?.activeBrushId;
  _rackEls.grid.innerHTML = "";
  for (const b of brushes.filter((x) => (x.folder || DEFAULT_FOLDER) === _rackCurrentFolder)) {
    const tile = document.createElement("div");
    tile.className = "brush-rack-tile";
    tile.setAttribute("aria-pressed", b.id === activeId ? "true" : "false");
    tile.dataset.brushId = b.id;
    tile.setAttribute("role", "button");
    tile.tabIndex = 0;
    const preview = document.createElement("div");
    preview.className = "brush-rack-tile-preview";
    if (b.shape.kind === "ellipse") {
      const ar = b.shape.aspect;
      preview.style.transform = `rotate(${b.shape.rotation}deg) scaleY(${ar})`;
    }
    preview.style.background = _smoothstepRadialGradient(b.shape.hardness);
    const name = document.createElement("span");
    name.className = "brush-rack-tile-name";
    name.textContent = b.name;
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "brush-rack-tile-edit";
    gear.title = "\u7F16\u8F91";
    gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExclusive();
      _openBrushSettings(b.id);
    });
    tile.appendChild(preview);
    tile.appendChild(name);
    tile.appendChild(gear);
    tile.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBrushPresetForTool(_rackCurrentTool, b.id);
      closeExclusive();
    });
    _rackEls.grid.appendChild(tile);
  }
}
var _registeredPanels = /* @__PURE__ */ new Set();
for (const tool of Object.keys(RACK_PANEL_BY_TOOL)) {
  const id = RACK_PANEL_BY_TOOL[tool];
  if (_registeredPanels.has(id)) continue;
  _registeredPanels.add(id);
  registerPanel(id, {
    show: () => _showRackSheet(tool),
    hide: _hideRackSheet
  });
}
_rackEls.close.addEventListener("click", () => closeExclusive());
function _nextBrushName() {
  const re = /^新笔\s*(\d+)$/;
  let max = 0;
  for (const b of _brushRack.brushes) {
    const m = re.exec(b.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `\u65B0\u7B14 ${max + 1}`;
}
_rackEls.newBtn.addEventListener("click", () => {
  const activeId = state.toolStates[getRackToolKey(_rackCurrentTool)]?.activeBrushId;
  let source = activeId ? findBrush(_brushRack, activeId) : null;
  if (!source) {
    const inFolder = brushesByTool(_brushRack, _rackCurrentTool).filter((b) => (b.folder || DEFAULT_FOLDER) === _rackCurrentFolder);
    source = inFolder[0] || _brushRack.brushes[0] || null;
  }
  let newB;
  if (source) {
    newB = JSON.parse(JSON.stringify(source));
    newB.id = newBrushId();
    newB.name = _nextBrushName();
    newB.folder = _rackCurrentFolder;
    newB.tool = _rackCurrentTool;
  } else {
    newB = {
      id: newBrushId(),
      name: _nextBrushName(),
      tool: _rackCurrentTool,
      folder: _rackCurrentFolder,
      shape: { kind: "round", aspect: 1, rotation: 0, hardness: 1, textureB64: null },
      size: { base: 12, max: 200 },
      sizeCoeff: 0.6,
      opaCoeff: 0.6,
      flowCoeff: 0,
      pressureGamma: 1,
      pressureLPF: 0,
      defaultOpa: 1,
      compositeMode: "wash",
      spacing: 0.06,
      pixelMode: false,
      taper: { in: 0, out: 0 },
      smudge: _rackCurrentTool === "smudge" ? { strength: 0.8, dryness: 0.1 } : null,
      smooth: { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 }
    };
  }
  _brushRack.brushes.push(newB);
  _rackDirty = true;
  closeExclusive();
  _openBrushSettings(newB.id);
});
_rackEls.importBtn.addEventListener("click", () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/json,.json";
  inp.style.display = "none";
  inp.addEventListener("change", async () => {
    const file = inp.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const b = brushFromJSON(txt);
      b.folder = _rackCurrentFolder;
      b.tool = _rackCurrentTool;
      _brushRack.brushes.push(b);
      _rackDirty = true;
      persistBrushRack();
      _renderRackSheet();
      setStatus(`\u5DF2\u5BFC\u5165\uFF1A${b.name}`);
    } catch (e) {
      setStatus("\u5BFC\u5165\u5931\u8D25\uFF1A" + (e.message || e), true);
    }
    document.body.removeChild(inp);
  });
  document.body.appendChild(inp);
  inp.click();
});
async function exportBrushAsFile(brush) {
  const json = brushToJSON(brush);
  const blob = new Blob([json], { type: "application/json" });
  const filename = `${brush.name || "brush"}-${brush.tool}.json`;
  await _shareOrDownloadJSON(blob, filename, brush.name);
}
async function _shareOrDownloadJSON(blob, filename, title) {
  if (navigator.canShare && navigator.share) {
    const file = new File([blob], filename, { type: "application/json" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return;
      } catch (_) {
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
function _smoothstepRadialGradient(hardness, stops = 16) {
  const hd = Math.max(0, Math.min(1, hardness));
  const out = [];
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    let alpha;
    if (t <= hd) alpha = 1;
    else {
      const u = (t - hd) / (1 - hd);
      alpha = 1 - u * u * (3 - 2 * u);
    }
    const pct = (t * 100).toFixed(1);
    const apct = (alpha * 100).toFixed(1);
    out.push(`color-mix(in srgb, var(--ink) ${apct}%, transparent) ${pct}%`);
  }
  return `radial-gradient(circle closest-side, ${out.join(", ")})`;
}
async function exportRackFolderAsFile() {
  if (!_brushRack) return;
  const tool = _rackCurrentTool;
  const folder = _rackCurrentFolder;
  const brushes = brushesByTool(_brushRack, tool).filter((b) => (b.folder || DEFAULT_FOLDER) === folder);
  if (brushes.length === 0) {
    setStatus("\u672C\u6587\u4EF6\u5939\u662F\u7A7A\u7684", true);
    return;
  }
  const pack = { version: 1, folder, tool, brushes };
  const json = JSON.stringify(pack, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const filename = `${folder || "folder"}-${tool}.json`;
  await _shareOrDownloadJSON(blob, filename, folder);
  setStatus(`\u5DF2\u5BFC\u51FA\u6587\u4EF6\u5939\u300C${folder}\u300D\uFF08${brushes.length} \u7B14\uFF09`);
}
async function dumpRackAsCode() {
  if (!_brushRack) return;
  const lines = [];
  lines.push("// Auto-dumped from brush rack. \u66FF\u6362 src/brushes.js DEFAULTS_SPEC array \u5185\u5BB9\u3002");
  lines.push("export const DEFAULTS_SPEC = [");
  for (const b of _brushRack.brushes) {
    const args = {};
    args.size = b.size?.base ?? 12;
    args.sizeBaseMax = b.size?.max ?? 200;
    args.hardness = b.shape?.hardness ?? 1;
    if (b.shape?.kind && b.shape.kind !== "round") args.shapeKind = b.shape.kind;
    if (b.shape?.aspect != null && b.shape.aspect !== 1) args.aspect = b.shape.aspect;
    if (b.shape?.rotation) args.rotation = b.shape.rotation;
    args.sizeCoeff = b.sizeCoeff ?? 0.6;
    args.opaCoeff = b.opaCoeff ?? 0.6;
    args.flowCoeff = b.flowCoeff ?? 0;
    if (b.pressureGamma != null && b.pressureGamma !== 1) args.pressureGamma = b.pressureGamma;
    if (b.defaultOpa != null && b.defaultOpa !== 1) args.defaultOpa = b.defaultOpa;
    args.compositeMode = b.compositeMode || "wash";
    args.spacingValue = typeof b.spacing === "number" ? b.spacing : b.spacing?.value ?? 0.06;
    if (b.pixelMode) args.pixelMode = true;
    if (b.taper?.in) args.taperIn = b.taper.in;
    if (b.taper?.out) args.taperOut = b.taper.out;
    if (b.smudge) args.smudge = b.smudge;
    const sm = b.smooth || {};
    if (sm.streamline != null && sm.streamline !== 0.3) args.streamline = sm.streamline;
    if (sm.stabilization != null && sm.stabilization !== 0) args.stabilization = sm.stabilization;
    if (sm.pullStabilizer != null && sm.pullStabilizer !== 0) args.pullStabilizer = sm.pullStabilizer;
    if (sm.motionFilter != null && sm.motionFilter !== 0) args.motionFilter = sm.motionFilter;
    const argsStr = JSON.stringify(args).replace(/"([a-zA-Z_]\w*)":/g, "$1:");
    lines.push(`  { id: ${JSON.stringify(b.id)}, name: ${JSON.stringify(b.name)}, tool: ${JSON.stringify(b.tool)},`);
    lines.push(`    args: ${argsStr} },`);
  }
  lines.push("];");
  const code = lines.join("\n");
  const blob = new Blob([code], { type: "text/javascript" });
  await _shareOrDownloadJSON(blob, "default-brushes.js", "\u7B14\u67B6\u4EE3\u7801");
  setStatus(`\u5DF2\u5BFC\u51FA ${_brushRack.brushes.length} \u7B14\u7684\u4EE3\u7801\u6587\u4EF6`);
}
if (_rackEls.exportFolderBtn) _rackEls.exportFolderBtn.addEventListener("click", () => exportRackFolderAsFile());
if (_rackEls.cloudPushBtn) _rackEls.cloudPushBtn.addEventListener("click", async () => {
  if (!isSignedIn()) {
    setStatus("\u8BF7\u5148\u767B\u5F55\u4E91\u7AEF\u8D26\u53F7", true);
    return;
  }
  setStatus("\u6B63\u5728\u4E0A\u4F20\u7B14\u67B6\u2026");
  await pushBrushRackIfSignedIn();
});
if (_rackEls.resetBtn) _rackEls.resetBtn.addEventListener("click", async () => {
  const ok = await openConfirmSheet(
    "\u91CD\u7F6E\u7B14\u67B6\uFF1F",
    "\u4F1A\u5220\u9664\u5168\u90E8\u81EA\u5B9A\u4E49\u7B14\u5237 + \u6539\u8FC7\u7684\u9ED8\u8BA4\u7B14\uFF0C\u6062\u590D\u51FA\u5382\u9ED8\u8BA4\u3002\u4E0D\u53EF\u64A4\u9500\u3002"
  );
  if (!ok) return;
  _brushRack = makeDefaultRack();
  for (const t of Object.keys(state.toolStates)) {
    state.toolStates[t].activeBrushId = null;
    Object.assign(state.toolStates[t], defaultToolStateFor(t));
  }
  await persistBrushRack();
  applyToolState(state.tool);
  if (RACK_PANEL_BY_TOOL[state.tool] === getCurrentExclusive()) _renderRackSheet();
  _rackDirty = true;
  if (isSignedIn()) pushBrushRackIfSignedIn();
  _rackDirty = false;
  setStatus(`\u7B14\u67B6\u5DF2\u91CD\u7F6E\uFF08${_brushRack.brushes.length} \u4E2A brush\uFF09`, true);
});
if (_rackEls.dumpCodeBtn) _rackEls.dumpCodeBtn.addEventListener("click", () => dumpRackAsCode());
var _editingBrushId = null;
var _editingBrushDraft = null;
function _openBrushSettings(brushId) {
  const b = findBrush(_brushRack, brushId);
  if (!b) return;
  _editingBrushId = brushId;
  _editingBrushDraft = JSON.parse(JSON.stringify(b));
  _renderBrushSettings();
  _settingsEls.view.classList.remove("hidden");
}
function _closeBrushSettings(save) {
  if (save && _editingBrushDraft) {
    const idx = _brushRack.brushes.findIndex((x) => x.id === _editingBrushId);
    if (idx >= 0) {
      _brushRack.brushes[idx] = _editingBrushDraft;
      _rackDirty = true;
      persistBrushRack();
      const tool = _editingBrushDraft.tool;
      const targetTool = state.tool === "airbrush" ? "brush" : tool;
      if (getRackToolKey(state.tool) === getRackToolKey(targetTool)) {
        selectBrushPresetForTool(state.tool, _editingBrushDraft.id);
      } else {
        selectBrushPresetForTool(targetTool, _editingBrushDraft.id);
      }
      setStatus(`\u5DF2\u4FDD\u5B58\uFF1A${_editingBrushDraft.name}`);
    }
  }
  _editingBrushId = null;
  _editingBrushDraft = null;
  _settingsEls.view.classList.add("hidden");
}
_settingsEls.save.addEventListener("click", () => _closeBrushSettings(true));
_settingsEls.cancel.addEventListener("click", () => _closeBrushSettings(false));
function _renderBrushSettings() {
  const b = _editingBrushDraft;
  if (!b) return;
  const body = _settingsEls.body;
  body.innerHTML = "";
  const section = (title) => {
    const s = document.createElement("div");
    s.className = "brush-settings-section";
    const t = document.createElement("div");
    t.className = "brush-settings-section-title";
    t.textContent = title;
    s.appendChild(t);
    body.appendChild(s);
    return s;
  };
  const rangeRow = (sec, label, min, max, step, val, fmt, onChange) => {
    const row = document.createElement("div");
    row.className = "brush-settings-row";
    row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}"><span class="brush-settings-val">${fmt(val)}</span>`;
    const input2 = row.querySelector("input");
    const valSpan = row.querySelector(".brush-settings-val");
    input2.addEventListener("input", () => {
      const v = parseFloat(input2.value);
      valSpan.textContent = fmt(v);
      onChange(v);
    });
    sec.appendChild(row);
  };
  const textRow = (sec, label, val, onChange) => {
    const row = document.createElement("div");
    row.className = "brush-settings-row brush-settings-row-full";
    row.innerHTML = `<label>${label}</label><input type="text" value="">`;
    const input2 = row.querySelector("input");
    input2.value = val;
    input2.addEventListener("input", () => onChange(input2.value));
    sec.appendChild(row);
  };
  const selectRow = (sec, label, options, val, onChange) => {
    const row = document.createElement("div");
    row.className = "brush-settings-row brush-settings-row-full";
    const opts = options.map(([v, l]) => `<option value="${v}"${v === val ? " selected" : ""}>${l}</option>`).join("");
    row.innerHTML = `<label>${label}</label><select>${opts}</select>`;
    const sel = row.querySelector("select");
    sel.addEventListener("change", () => onChange(sel.value));
    sec.appendChild(row);
  };
  const basic = section("\u57FA\u672C");
  textRow(basic, "\u540D\u5B57", b.name, (v) => b.name = v);
  selectRow(basic, "\u5DE5\u5177", [
    ["brush", "\u7B14\u5237"],
    ["smudge", "\u6D82\u62B9"],
    ["eraser", "\u6A61\u76AE"]
  ], b.tool, (v) => b.tool = v);
  textRow(basic, "\u6587\u4EF6\u5939", b.folder, (v) => b.folder = v);
  const shape = section("\u5F62\u72B6");
  selectRow(shape, "\u7C7B\u578B", [["round", "\u5706"], ["ellipse", "\u692D\u5706"], ["texture", "\u7EB9\u7406"]], b.shape.kind, (v) => {
    b.shape.kind = v;
    _renderBrushSettings();
  });
  if (b.shape.kind === "ellipse") {
    rangeRow(shape, "\u957F\u77ED\u8F74", 0.1, 1, 0.05, b.shape.aspect, (v) => v.toFixed(2), (v) => b.shape.aspect = v);
    rangeRow(shape, "\u65CB\u8F6C\xB0", 0, 180, 1, b.shape.rotation, (v) => `${v | 0}\xB0`, (v) => b.shape.rotation = v);
  }
  rangeRow(shape, "\u786C\u5EA6", 0, 1, 0.05, b.shape.hardness, (v) => v.toFixed(2), (v) => b.shape.hardness = v);
  if (b.sizeCoeff == null) b.sizeCoeff = 0.6;
  if (b.opaCoeff == null) b.opaCoeff = 0.6;
  if (b.flowCoeff == null) b.flowCoeff = 0;
  if (b.pressureGamma == null) b.pressureGamma = 1;
  if (b.pressureLPF == null) b.pressureLPF = 0;
  if (b.compositeMode == null) b.compositeMode = "wash";
  if (b.defaultOpa == null) b.defaultOpa = 1;
  if (!b.smooth) b.smooth = { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 };
  const size = section("\u7C97\u7EC6 (size)");
  rangeRow(size, "\u57FA\u7840", 1, b.size.max || 200, 1, b.size.base, (v) => `${v | 0} px`, (v) => b.size.base = v);
  rangeRow(size, "\u6700\u5927", 4, 800, 1, b.size.max || 200, (v) => `${v | 0} px`, (v) => b.size.max = v);
  const dyn = section("\u538B\u611F (\u22121..1\uFF0C0 = \u4E0D\u54CD\u5E94\u3001\u8D1F\u6570 = \u53CD\u5411)");
  rangeRow(dyn, "size", -1, 1, 0.05, b.sizeCoeff, (v) => v.toFixed(2), (v) => b.sizeCoeff = v);
  rangeRow(dyn, "opacity", -1, 1, 0.05, b.opaCoeff, (v) => v.toFixed(2), (v) => b.opaCoeff = v);
  rangeRow(dyn, "flow", -1, 1, 0.05, b.flowCoeff, (v) => v.toFixed(2), (v) => b.flowCoeff = v);
  const def = section("\u9ED8\u8BA4\u503C\uFF08\u9009\u7B14\u65F6\u62F7\u7ED9 opacity \u6ED1\u5757\uFF09");
  rangeRow(def, "\u9ED8\u8BA4 opacity", 0, 1, 0.05, b.defaultOpa, (v) => `${v * 100 | 0}%`, (v) => b.defaultOpa = v);
  const smooth = section("\u7B14\u753B\u5E73\u6ED1");
  rangeRow(smooth, "streamline", 0, 1, 0.05, b.smooth.streamline, (v) => v.toFixed(2), (v) => b.smooth.streamline = v);
  rangeRow(smooth, "stabilization", 0, 1, 0.05, b.smooth.stabilization, (v) => v.toFixed(2), (v) => b.smooth.stabilization = v);
  rangeRow(smooth, "pull-stab", 0, 1, 0.05, b.smooth.pullStabilizer, (v) => v.toFixed(2), (v) => b.smooth.pullStabilizer = v);
  rangeRow(smooth, "motion-filter", 0, 1, 0.05, b.smooth.motionFilter, (v) => v.toFixed(2), (v) => b.smooth.motionFilter = v);
  rangeRow(smooth, "pressure LPF", 0, 200, 5, b.pressureLPF, (v) => `${v | 0} ms`, (v) => b.pressureLPF = v);
  const adv = section("\u9AD8\u7EA7");
  selectRow(adv, "\u91CD\u53E0\u6A21\u5F0F compositeMode", [
    ["wash", "Wash\uFF08max\uFF1B\u81EA\u4EA4\u4E0D\u53D8\u6DF1\uFF0C\u6709\u4E0A\u9650\uFF09"],
    ["buildup", "Build-Up\uFF08\u7D2F\u79EF\uFF1B\u53EF\u8FBE 100%\uFF0C\u55B7\u67AA feel\uFF09"]
  ], b.compositeMode, (v) => b.compositeMode = v);
  rangeRow(adv, "pressureGamma", 0.2, 3, 0.05, b.pressureGamma, (v) => v.toFixed(2), (v) => b.pressureGamma = v);
  const pmRow = document.createElement("div");
  pmRow.className = "brush-settings-row brush-settings-row-full";
  const initPM = !!b.pixelMode;
  pmRow.innerHTML = `
    <label>pixelMode<br><span style="font-size:11px;color:var(--ink-soft);">\u5F00 = \u6574\u6570 snap + fillRect \u65E0 AA\uFF08\u50CF\u7D20\u827A\u672F\uFF09</span></label>
    <button type="button" class="brush-rack-action" style="justify-self:end;" aria-pressed="${initPM}">
      ${initPM ? "\u5F00" : "\u5173"}
    </button>
  `;
  const pmBtn = pmRow.querySelector("button");
  b.pixelMode = initPM;
  pmBtn.addEventListener("click", () => {
    b.pixelMode = !b.pixelMode;
    pmBtn.setAttribute("aria-pressed", b.pixelMode ? "true" : "false");
    pmBtn.textContent = b.pixelMode ? "\u5F00" : "\u5173";
  });
  adv.appendChild(pmRow);
  const sp = section("\u95F4\u8DDD (% \u76F4\u5F84)");
  const spVal = typeof b.spacing === "number" ? b.spacing : b.spacing?.value ?? 0.06;
  rangeRow(
    sp,
    "\u95F4\u8DDD",
    1,
    200,
    1,
    Math.round(spVal * 100),
    (v) => `${v | 0}%`,
    (v) => {
      b.spacing = v / 100;
    }
  );
  const tp = section("\u6536\u5C3E");
  rangeRow(tp, "\u5165\u7AEF", 0, 5, 0.1, b.taper.in, (v) => v.toFixed(1), (v) => b.taper.in = v);
  if (b.tool === "smudge") {
    if (!b.smudge) b.smudge = { strength: 0.8, dryness: 0.1 };
    const sm = section("\u6D82\u62B9");
    rangeRow(sm, "\u5F3A\u5EA6", 0, 1, 0.05, b.smudge.strength, (v) => v.toFixed(2), (v) => b.smudge.strength = v);
    rangeRow(sm, "\u5E72\u71E5\u5EA6", 0, 1, 0.05, b.smudge.dryness, (v) => v.toFixed(2), (v) => b.smudge.dryness = v);
  }
  const exp = section("");
  const expBtn = document.createElement("button");
  expBtn.type = "button";
  expBtn.className = "brush-rack-action";
  expBtn.textContent = "\u5BFC\u51FA\u6B64\u7B14\u4E3A JSON \u6587\u4EF6";
  expBtn.addEventListener("click", () => exportBrushAsFile(b));
  exp.appendChild(expBtn);
  const del = section("");
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "brush-rack-action";
  delBtn.textContent = "\u5220\u9664\u6B64\u7B14";
  delBtn.style.background = "rgba(220,38,38,0.1)";
  delBtn.style.color = "#dc2626";
  delBtn.style.borderColor = "#dc2626";
  delBtn.addEventListener("click", async () => {
    const ok = await openConfirmSheet("\u5220\u9664\u8FD9\u652F\u7B14\uFF1F", `\u300C${b.name}\u300D\uFF08\u4E0D\u53EF\u64A4\u9500\uFF09`);
    if (!ok) return;
    const idx = _brushRack.brushes.findIndex((x) => x.id === _editingBrushId);
    if (idx >= 0) _brushRack.brushes.splice(idx, 1);
    _rackDirty = true;
    persistBrushRack();
    _editingBrushId = null;
    _editingBrushDraft = null;
    _settingsEls.view.classList.add("hidden");
    setStatus("\u5DF2\u5220\u9664");
  });
  del.appendChild(delBtn);
}
els.board.addEventListener("pointerdown", () => {
  if (getCurrentExclusive()) closeExclusive();
}, { capture: true });
var LOCAL_DEV_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", ""]);
var updateDismissed = false;
function showUpdate() {
  if (updateDismissed) return;
  els.updateToast.classList.remove("hidden");
}
els.updateReload.addEventListener("click", async () => {
  applyAllPendingTransients();
  if (_docDirty && !_docSaving) await saveNow();
  const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
  if (!reg || !reg.waiting) {
    location.reload();
    return;
  }
  let reloaded = false;
  const doReload = () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
  reg.waiting.postMessage({ type: "skip-waiting" });
  setTimeout(doReload, 5e3);
});
els.updateDismiss.addEventListener("click", () => {
  updateDismissed = true;
  els.updateToast.classList.add("hidden");
});
var _swRegistration = null;
var IS_DEV_ROUTE = location.pathname.includes("/dev/");
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname) && !IS_DEV_ROUTE) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });
  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    _swRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdate();
    }
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdate();
        }
      });
    });
    const pokeUpdate = () => {
      registration.update().catch(() => {
      });
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pokeUpdate();
    });
    window.addEventListener("focus", pokeUpdate);
    setInterval(pokeUpdate, 10 * 60 * 1e3);
  }).catch((err) => {
    console.warn("SW register failed", err);
  });
}
//# sourceMappingURL=main-dev.mjs.map
