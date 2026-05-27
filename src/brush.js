// 笔刷引擎 v0：圆笔 + 沿线 stamp。
//
// 设计原则（一期手感期）：
// - 数据语义层与渲染语义层分离（沿用 ScratchPad 的洞察）：
//   - "压感关" = 写入 p=1.0 进数据。**不是**渲染分支。
//   - 一期没有"笔画"持久结构 —— 直接 stamp 进 layer.ctx。但 brush settings
//     单独打包 BrushSettings 对象，方便后期接 brush preset / 序列化。
// - 一笔的"质感"由 sample-spacing 决定，不依赖屏幕事件频率。
//   每个 pointermove 拿 coalesced events 后，每两个采样之间按 doc-px 距离
//   走 `spacing × size` 的步长 stamp。这样无论 60Hz 还是 240Hz，落笔密度一致。
// - stamp 是预渲染的 offscreen canvas。颜色 / size / hardness 变了再重做。
//
// 后期会扩展的钩子（写在脑子里，不写在代码里）：
//   * 自定义 stamp 纹理（图片 / 噪声）
//   * dual brush（两个 stamp 叠加）
//   * 抖动（size / opacity / rotation / scatter）
//   * 笔刷 dynamics 曲线（pressure → param 不只是 pow）
//   * 水彩混色（每个 stamp 拉一下底色再吐）
//   * 厚涂（normal map / 法线方向）
//   * WebGPU 加速

const DEFAULT_SETTINGS = {
  type: "round",
  size: 12,           // doc-px 直径（满压）
  opacity: 1,         // 每个 stamp 的 alpha 上限（0..1）
  hardness: 0.75,     // 0=完全软（径向渐变到边缘）；1=硬边（无渐变）。窄一点 rim 累积更不明显
  spacing: 0.12,      // stamp 间距 = spacing × size（doc-px）
  // 压感映射：开 → 用 pressure；关 → 一律 1
  pressureToSize: true,
  pressureToOpacity: true,    // user 2026-05-25：默认笔压也控 alpha
  sizeCurve: 0.6,             // size = size_max × p^sizeCurve
  opacityCurve: 0.6,
  color: "#1b1b1b",
};

export class BrushSettings {
  constructor(overrides) { Object.assign(this, DEFAULT_SETTINGS, overrides || {}); }
  clone(over) { return new BrushSettings({ ...this, ...over }); }
}

export class BrushEngine {
  constructor() {
    this._stampCache = null;       // {key, canvas, radius}
    this._stroke = null;           // { layer, settings, accumDist, lastX, lastY, lastP, mode }
  }

  // 预渲染一个 stamp 图。color 直接画进去；后期改纹理时这里换实现即可。
  //
  // **PERF**：cache key 里**不**含 size —— stamp 按 settings.size（最大压感）
  // 烤一次，每颗 stamp 用 drawImage 的 dest-size 缩放下来。否则 size 因压感
  // 每颗都变 → 每颗 cache miss → 每颗都重建 canvas + gradient，200Hz 飘起来
  // GC + GPU 上传立刻爆。color / hardness / mode 才是真正会触发重做的参数。
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
    stamp.width = d; stamp.height = d;
    const sctx = stamp.getContext("2d");
    const hd = Math.max(0, Math.min(0.999, hardness));
    // Radial gradient：内圈 hd×r 满 alpha 的 useColor，外圈到 r 时同色 α=0。
    // **关键**：末尾 stop 用同色 α=0（不是 transparent black），bilinear 采
    // 圆边时不会引入 RGB 漂移，避免经典 sprite 白/黑边。
    const g = sctx.createRadialGradient(r, r, hd * r, r, r, r);
    g.addColorStop(0, useColor);
    g.addColorStop(1, hexToRgba(useColor, 0));
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, d, d);

    this._stampCache = { key, canvas: stamp, baseSize, radius: r };
    return this._stampCache;
  }

  // 失效缓存（颜色 / size / hardness 大幅改 → 下次自动重做）
  invalidateStamp() { this._stampCache = null; }

  // settings 中的 color 也可以单独切（更轻量）
  setColor(color) {
    if (this._stroke) this._stroke.settings.color = color;
    this.invalidateStamp();
  }

  // 沿 path arc-length 等距 stamp，标量 accumDist 累加：
  //   beginStroke: 落 touchdown stamp，lastX/Y/P=(x,y,p)，accumDist=0
  //   extendStroke(x,y,p):
  //     L = hypot(x-lastX, y-lastY)
  //     while accumDist + (L - segPos) >= step:
  //       消耗 step - accumDist，在 lerp 点落 stamp，accumDist=0
  //     accumDist += L - segPos
  //     lastX/Y/P=(x,y,p)
  //
  // step = settings.size × spacing （不走 pressure）。
  // 注意：raw event 必须按时间单调到达（见 docs/ipad-coalesced-events.md），
  // 否则 Safari iOS coalesced 边界回放会把反向小段算进 path 长度 → 疏密波。
  // 这一层过滤在 input.js 端做。

  _stepFor(s) {
    return Math.max(0.5, s.size * s.spacing);
  }

  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    // 笔触缓冲：paint 模式下，每个 stamp 写进 layer-size 的 RGBA buffer（per-stamp
    // alpha 不含 s.opacity）。结束时把 buffer 以 s.opacity composite 进 layer。
    // 这样低 opacity 笔触折返不会把 alpha 累计上去 —— 因为 buffer 内 source-over
    // 已经在 1.0 处封顶，composite 时乘 s.opacity 直接得到笔触最大 alpha=s.opacity。
    // 注：erase 模式跳过 buffer（dst-out live preview 不好做），直接 per-stamp 改 layer。
    let buffer = null, bufferCtx = null;
    if (mode !== "erase") {
      buffer = document.createElement("canvas");
      buffer.width = layer.width;
      buffer.height = layer.height;
      bufferCtx = buffer.getContext("2d");
    }
    this._stroke = {
      layer,
      settings,
      mode,
      lastX: x, lastY: y, lastP: pressure,
      accumDist: 0,                        // 距上颗 stamp 的剩余 path 长度
      dirty: null,
      buffer, bufferCtx,                   // null for erase
    };
    this._stampOne(x, y, pressure);
  }

  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const dx = x - st.lastX;
    const dy = y - st.lastY;
    const L = Math.hypot(dx, dy);
    if (L === 0) return;
    const step = this._stepFor(st.settings);
    let pos = 0;
    while (st.accumDist + (L - pos) >= step) {
      const need = step - st.accumDist;
      pos += need;
      const t = pos / L;
      const sx = st.lastX + dx * t;
      const sy = st.lastY + dy * t;
      const sp = st.lastP + (pressure - st.lastP) * t;
      this._stampOne(sx, sy, sp);
      st.accumDist = 0;
    }
    st.accumDist += L - pos;
    st.lastX = x;
    st.lastY = y;
    st.lastP = pressure;
  }

  endStroke() {
    const st = this._stroke;
    if (st && st.buffer) {
      // composite buffer → layer：globalAlpha = s.opacity 就把笔触最大 alpha 钉死在 s.opacity
      const ctx = st.layer.ctx;
      const prevA = ctx.globalAlpha;
      ctx.globalAlpha = st.settings.opacity;
      ctx.drawImage(st.buffer, 0, 0);
      ctx.globalAlpha = prevA;
    }
    this._stroke = null;
  }

  cancelStroke() {
    this._stroke = null;
  }

  // 给 board 用：返回当前笔触的 live overlay，让 render 每帧在 layer 之上
  // 再画一遍 buffer，预览不立即写进 layer。endStroke 才把 buffer 烧进 layer。
  getLiveOverlay() {
    const st = this._stroke;
    if (!st || !st.buffer) return null;
    return {
      canvas: st.buffer,
      layer: st.layer,
      opacity: st.settings.opacity,
    };
  }

  // 取出（并清空）累积的 dirty bbox，给 Board.markDocDirty 用
  flushDirty() {
    const st = this._stroke;
    if (!st || !st.dirty) return null;
    const d = st.dirty;
    st.dirty = null;
    return d;
  }

  _stampOne(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    const p = Math.max(0, Math.min(1, pressure));

    const sizeMul = s.pressureToSize ? Math.pow(p, s.sizeCurve) : 1;
    const opaMul = s.pressureToOpacity ? Math.pow(p, s.opacityCurve) : 1;
    const size = Math.max(0.5, s.size * sizeMul);
    // **per-stamp alpha 不含 s.opacity**（paint 路径）：opacity 在 endStroke 一次性乘进去，
    // 保证笔触折返 alpha 在 buffer 内 source-over 封顶 1.0 → 出 layer 时封顶 s.opacity。
    // erase 路径仍按老规矩 per-stamp 把 s.opacity 算进去（dst-out 直接削 layer，没有 buffer）。
    const alpha = st.buffer
      ? Math.max(0, Math.min(1, opaMul))
      : Math.max(0, Math.min(1, s.opacity * opaMul));
    if (alpha < 0.001) return;

    // stamp 按 s.size 烤一次（缓存），这里按 actual size 缩放 drawImage
    const stamp = this._getStamp(s.size, s.hardness, s.color, st.mode);
    const ctx = st.buffer ? st.bufferCtx : st.layer.ctx;

    const prevAlpha = ctx.globalAlpha;
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";

    // 目标直径 = size + 2px 给 AA 边和源贴图一致比例
    const drawD = size + 2 * (size / stamp.baseSize);
    const drawR = drawD / 2;
    ctx.drawImage(stamp.canvas, x - drawR, y - drawR, drawD, drawD);

    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevComp;

    // 累积 dirty bbox（doc-px），给 dirty-rect render 用
    const d = st.dirty;
    if (d) {
      if (x - drawR < d[0]) d[0] = x - drawR;
      if (y - drawR < d[1]) d[1] = y - drawR;
      if (x + drawR > d[2]) d[2] = x + drawR;
      if (y + drawR > d[3]) d[3] = y + drawR;
    } else {
      st.dirty = [x - drawR, y - drawR, x + drawR, y + drawR];
    }
  }
}

// "#rrggbb" → "rgba(r,g,b,a)"
export function hexToRgba(hex, a = 1) {
  if (!hex || hex[0] !== "#") return `rgba(0,0,0,${a})`;
  let r, g, b;
  if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else {
    return `rgba(0,0,0,${a})`;
  }
  return `rgba(${r},${g},${b},${a})`;
}
