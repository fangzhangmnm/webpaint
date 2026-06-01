// 笔刷引擎 v98（Krita-aligned + 双 path）。详 docs/brush-architecture.md。
//
// **核心模型**：
//   per stamp at pressure p：
//     p' = p ^ pressureGamma
//     size_mul = signed_lerp(sizeCoeff, p')
//     flow_mul = signed_lerp(flowCoeff, p')
//     opa_mul  = signed_lerp(opaCoeff,  p')
//     size_eff = preset.size × size_mul
//     stamp_α  = state.brush.flow × flow_mul × opa_mul    ← user.opacity 不在这里
//
//   stroke buffer 内重叠合成（compositeMode 决定）：
//     buildup  (PS 默认 / 喷枪 feel): buffer = 1 − ∏(1 − stamp_α × shape_α)
//     wash     (Krita Alpha Darken):  buffer = max(buffer, stamp_α × shape_α)
//   v107: 两 mode 都走 JS per-pixel (Uint8 buffer)。原 Build-Up 用 Canvas2D 原生 source-over
//   + cached colored gradient，gradient linear interp 在 boundary 不平滑要 16 stops 逼近，复杂；
//   且 8-bit RGBA buffer 还有 quantize 问题。user 论证 per-pixel JS 70k×50/sec = 3.5M ops/sec
//   JS 不卡，更稳妥。两 mode 同 path，shape α 走解析 smoothstep。
//
//   endStroke composite to layer：
//     globalAlpha = user.opacity  ← Π 外面那一层乘 opacity
//     normal 模式 source-over；erase 模式 destination-out
//
// **为啥 opacity 在 Π 外**：flow 在 Π 内、opacity 在 Π 外是 PS / Krita 的标准。
//   spacing=100% 无重叠时 Π 退化为单项 → flow 和 opacity 可交换；
//   spacing<100% 有重叠时 flow 被 Π 放大、opacity 不被 → 出现 "10%flow > 100%flow×10%opa" 那种现象。
//
// **双 path**：
//   Build-Up: 走 Canvas2D 原生 source-over（GPU），bufferCanvas RGBA，
//             cached colored radial-gradient stamp 跟 v97 一样
//   Wash:     走 JS per-pixel max，bufferData Uint8 (α only)，
//             shape α 解析公式 (round / ellipse)，endStroke 转 RGBA canvas 上 layer
//   smudge / pixelMode: 都直接进 layer（不进 buffer）

const DEFAULT_SETTINGS = {
  type: "round",
  size: 12,
  color: "#1b1b1b",
  // 用户当场调（per-tool 持久）：
  opacity: 1.0,           // user.opacity —— 应用在 endStroke composite (Π 外)
  flow: 1.0,              // user.flow —— 进 α_dab (Π 内)
  // 压感 dynamics（preset 冻结，−1..1 signed）：
  sizeCoeff: 0.6,
  opaCoeff: 0.6,
  flowCoeff: 0,
  pressureGamma: 1.0,
  // v102: 压感时间域 LPF (ms，一阶 IIR)
  // 0 = raw，正值 = 平滑（解 "转角顿一下 out-leg 突然细" 的问题）
  pressureLPF: 0,
  // shape：
  hardness: 0.75,
  shapeKind: "round",
  shapeAspect: 1.0,
  shapeRotation: 0,
  // spacing：
  spacing: 0.12,
  // buffer 合成模式：
  compositeMode: "wash",  // "wash" = Alpha Darken (JS max), "buildup" = source-over (Canvas2D native)
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
  pressureToOpacity: true,
};

export class BrushSettings {
  constructor(overrides) { Object.assign(this, DEFAULT_SETTINGS, overrides || {}); }
  clone(over) { return new BrushSettings({ ...this, ...over }); }
}

// signed_lerp：coeff ∈ [−1, 1]，p ∈ [0, 1]，返回 ∈ [amp, 1] where amp = 1 − |coeff|。
//   coeff ≥ 0：amp + (1 − amp) × p  →  p=0 → amp，p=1 → 1
//   coeff < 0：1 + (amp − 1) × p    →  p=0 → 1，  p=1 → amp
//   coeff = 0：永远 1（不响应压感）
function signedLerp(coeff, p) {
  const amp = 1 - Math.abs(coeff);
  return coeff >= 0 ? amp + (1 - amp) * p
                    : 1 + (amp - 1) * p;
}

export class BrushEngine {
  constructor() {
    this._stampCache = null;       // {key, canvas, baseSize, radius} —— Build-Up colored stamp cache
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
    const r = d / 2;                          // stamp 中心 = canvas 半宽
    const stamp = document.createElement("canvas");
    stamp.width = d; stamp.height = d;
    const sctx = stamp.getContext("2d");
    const hd = Math.max(0, Math.min(0.999, hardness));
    const innerR = hd * r;                    // 硬芯半径（α=1 内）
    const decayLen = r - innerR;              // 衰减区长度（α 从 1 → 0）

    // 解析 smoothstep：α(dist) = 1 - u²(3-2u)，u = (dist - innerR) / decayLen
    // 每像素直接写 ImageData；不走 Canvas2D gradient → 无 stop 间 linear interp 误差
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
          alpha = 1 - u * u * (3 - 2 * u);    // smoothstep down
        }
        const idx = (py * d + px) * 4;
        data[idx]     = col.r;
        data[idx + 1] = col.g;
        data[idx + 2] = col.b;
        data[idx + 3] = Math.round(alpha * 255);
      }
    }
    sctx.putImageData(img, 0, 0);
    this._stampCache = { key, canvas: stamp, baseSize, radius: r };
    return this._stampCache;
  }

  invalidateStamp() { this._stampCache = null; }

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
    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1.0));
    const sizeMul = signedLerp(s.sizeCoeff || 0, pCurve);
    const effSize = s.size * sizeMul;
    return Math.max(0.5, effSize * s.spacing);
  }

  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    let loaded = null;
    if (mode === "smudge") loaded = this._sampleLayerColor(layer, x, y);
    const isBuildup = (settings.compositeMode || "wash") === "buildup";
    // v102: pressure LPF state；初值 = 当前 pressure（落笔瞬间不 LPF）
    const pLPF0 = pressure;
    this._stroke = {
      layer, settings, mode,
      lastX: x, lastY: y, lastP: pLPF0,
      pLPF: pLPF0,                              // 当前 LPF 态
      lastEventTime: performance.now(),
      accumDist: 0,
      strokeDist: 0,
      dirty: null,
      // Build-Up path：bufferCanvas (RGBA Canvas2D, native source-over)
      // Wash path：bufferData (Uint8ClampedArray, JS per-pixel max)
      isBuildup,
      bufferCanvas: null, bufferCtx: null,    // Build-Up only
      bufferData: null,                       // Wash only
      bufBboxX: layer.bboxX,
      bufBboxY: layer.bboxY,
      bufBboxW: 0,
      bufBboxH: 0,
      overlayCanvas: null,                    // Wash only（Build-Up 直接用 bufferCanvas）
      overlayDirty: false,
      loaded,
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
      if (x0 >= st.bufBboxX && y0 >= st.bufBboxY &&
          x1 <= st.bufBboxX + st.bufBboxW && y1 <= st.bufBboxY + st.bufBboxH) return;
      nx  = Math.floor(Math.min(st.bufBboxX, x0 - m));
      ny  = Math.floor(Math.min(st.bufBboxY, y0 - m));
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
      // Build-Up：移老 canvas 像素到新 canvas
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
      // Wash：复制老 Uint8Array 到新 array
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
      st.overlayCanvas = null;    // size 变 → 重建
    }
    st.bufBboxX = nx;
    st.bufBboxY = ny;
    st.bufBboxW = nw;
    st.bufBboxH = nh;
  }

  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    // NaN/inf 护栏：甩太快 / 坏事件可能传入非有限坐标 → 跳过，别污染 lastX/lastY 与循环
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // v102: 用 raw pressure 更新 LPF state，然后所有插值用 LPF'd pressure
    // 一阶 IIR: α = dt / (dt + τ)；τ=0 时 α=1 → 直传 raw
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
      // step 用 LPF'd 压感算（spacing 也跟着平滑）
      const step = this._stepFor(st.settings, pEff);
      if (st.accumDist + (L - pos) < step) break;
      const need = step - st.accumDist;
      pos += need;
      st.strokeDist += step;
      const t = pos / L;
      const sx = st.lastX + dx * t;
      const sy = st.lastY + dy * t;
      // 段内插值在上次 LPF 值 与 当前 LPF 值 之间
      const sp = st.lastP + (pEff - st.lastP) * t;
      // culling：stamp 中心超出 doc 边缘 > 半径（整颗在画布外）→ 跳过 _stampOne 的逐颗 CPU。
      // 循环仍推进（spacing 不变、回到画布内自然续上）；"slightly offscreen"（半径内）保留 → 边缘描边平滑。
      const r = (st.settings.size || 4) / 2;
      if (sx >= -r && sx <= st.layer.docW + r && sy >= -r && sy <= st.layer.docH + r) {
        this._stampOne(sx, sy, sp);
      }
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

  cancelStroke() { this._stroke = null; }

  _compositeBufferToLayer() {
    const st = this._stroke;
    const layer = st.layer;
    const ctx = layer.ctx;
    const composeCanvas = st.isBuildup ? st.bufferCanvas : this._renderWashToCanvas();
    if (!composeCanvas) return;
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = Math.max(0, Math.min(1, st.settings.opacity ?? 1.0));   // Π 外 × opacity
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
      canvas.width = w; canvas.height = h;
    } else if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    const cctx = canvas.getContext("2d");
    const out = cctx.createImageData(w, h);
    // erase 模式 color 不影响（dst-out 只看 α），还是填黑省得 RGB 漏到合成层
    const color = st.mode === "erase" ? { r: 0, g: 0, b: 0 } : hexToRgbObj(st.settings.color);
    const buf = st.bufferData;
    const n = buf.length;
    const r = color.r, g = color.g, b = color.b;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out.data[o]     = r;
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
      bboxX: st.bufBboxX, bboxY: st.bufBboxY,
      bboxW: st.bufBboxW, bboxH: st.bufBboxH,
      layer: st.layer,
      opacity: Math.max(0, Math.min(1, st.settings.opacity ?? 1.0)),
      mode: st.mode,
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
    } catch (_) { return { r: 0, g: 0, b: 0, a: 0 }; }
  }

  _stampOne(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    let p = Math.max(0, Math.min(1, pressure));

    // 系统级 anti-spike taper（藏起来）：起手 fade-in，缓解 Apple Pencil 落笔 spike → 萝卜尖
    if (s.taperIn > 0) {
      const taperLen = s.size * s.taperIn;
      const t = Math.min(1, st.strokeDist / taperLen);
      const env = s.taperFloor + (1 - s.taperFloor) * t;
      p *= env;
    }

    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1.0));
    const sizeMul = signedLerp(s.sizeCoeff || 0, pCurve);
    const flowMul = signedLerp(s.flowCoeff || 0, pCurve);
    const opaMul  = signedLerp(s.opaCoeff  || 0, pCurve);

    const size = Math.max(0.5, s.size * sizeMul);
    const effFlow = Math.max(0, Math.min(1, s.flow * flowMul));
    // stamp_α = flow × opa_mul（Π 内层）；user.opacity 在 composite 时乘（Π 外层）
    const stampAlpha = effFlow * opaMul;
    if (stampAlpha < 0.001) return;

    const radius = size / 2;
    const x0 = x - radius - 1;
    const y0 = y - radius - 1;
    const x1 = x + radius + 1;
    const y1 = y + radius + 1;

    st.layer.ensureBbox(x0, y0, x1, y1);

    // smudge：sample + blend + 直接 drawImage 到 layer
    if (st.mode === "smudge" && st.loaded) {
      this._smudgeStampDirect(x, y, size, stampAlpha);
      this._markDirty(x0, y0, x1, y1);
      return;
    }
    // pixelMode：整数 snap + fillRect 直接到 layer（不进 buffer）
    if (s.pixelMode) {
      this._pixelStampDirect(x, y, size, stampAlpha);
      this._markDirty(x0, y0, x1, y1);
      return;
    }
    // 进 buffer，按 compositeMode 分支
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
    // erase 模式：buffer 颜色取黑（dst-out 只用 src.α，RGB 不影响）；非 erase 用 brush.color
    const stamp = this._getStamp(s.size, s.hardness, s.color, st.mode);
    const drawD = size + 2 * (size / stamp.baseSize);
    const drawR = drawD / 2;
    const lx = x - st.bufBboxX;
    const ly = y - st.bufBboxY;
    const ctx = st.bufferCtx;
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = stampAlpha;
    // buffer 内部永远 source-over（buildup 累积）；erase 的 dst-out 在 endStroke 用，不在 stamp
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
    const invAspect = useEllipse ? (1 / Math.max(0.01, s.shapeAspect)) : 1;

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
          // v106: smoothstep falloff (derivative 0 at 两端) 取代 linear
          // 解 user 反映「boundary 没 falloff 到 0」+ 两 stamp 间 banding
          const u = (dist - innerR) / decayLen;     // 0 at innerR, 1 at radius
          shapeA = 1 - u * u * (3 - 2 * u);          // 1 → 0 smoothstep
        }
        const dabA = stampA255 * shapeA;
        const idx = rowOff + px;
        if (dabA > buf[idx]) buf[idx] = dabA;     // Alpha Darken = max
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
      a: Math.max(st.loaded.a, cur.a),
    };
    const hex = "#" + [outCol.r, outCol.g, outCol.b]
      .map(v => Math.max(0, Math.min(255, v|0)).toString(16).padStart(2, "0")).join("");
    st.loaded = {
      r: st.loaded.r * (1 - dryness) + cur.r * dryness,
      g: st.loaded.g * (1 - dryness) + cur.g * dryness,
      b: st.loaded.b * (1 - dryness) + cur.b * dryness,
      a: st.loaded.a * (1 - dryness) + cur.a * dryness,
    };
    const stamp = makeRadialStamp(size, s.hardness, hex);
    const drawD = stamp.size;
    const drawR = drawD / 2;
    const layer = st.layer;
    const ctx = layer.ctx;
    const lx = x - layer.bboxX;
    const ly = y - layer.bboxY;
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = stampAlpha * Math.max(0, Math.min(1, s.opacity ?? 1.0));   // smudge 不走 buffer，opacity 这里乘
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
    // v104: 像素中心位置。pixel i 覆盖 [i, i+1)，光标 lx 所在 pixel = floor(lx)。
    // 之前 Math.round(lx) - floor(intSize/2) 在 0.5 边界少偏一个像素（user 反映「差了 0.5」）。
    // 新公式 floor(lx - (intSize-1)/2)：intSize=1 时 = floor(lx) ✓，>1 偶数时左偏 0.5（可接受）
    const ix = Math.floor(lx - (intSize - 1) / 2);
    const iy = Math.floor(ly - (intSize - 1) / 2);
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = stampAlpha * Math.max(0, Math.min(1, s.opacity ?? 1.0));   // pixel 不走 buffer，opacity 这里乘
    ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";
    ctx.fillStyle = st.mode === "erase" ? "#000" : (s.color || "#000");
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
}

// smudge 用的小 radial gradient stamp（每颗 color 不同，不 cache）
function makeRadialStamp(size, hardness, color) {
  const d = Math.max(4, Math.ceil(size + 2));
  const r = d / 2;
  const c = document.createElement("canvas");
  c.width = d; c.height = d;
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
      b: parseInt(hex.slice(5, 7), 16),
    };
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[1] + hex[1], 16),
      g: parseInt(hex[2] + hex[2], 16),
      b: parseInt(hex[3] + hex[3], 16),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

// "#rrggbb" → "rgba(r,g,b,a)"
export function hexToRgba(hex, a = 1) {
  const c = hexToRgbObj(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
