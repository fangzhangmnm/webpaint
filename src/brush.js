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
  hardness: 0.6,      // 0=完全软（径向渐变到边缘）；1=硬边（无渐变）
  spacing: 0.12,      // stamp 间距 = spacing × size（doc-px）
  // 压感映射：开 → 用 pressure；关 → 一律 1
  pressureToSize: true,
  pressureToOpacity: false,   // 默认只调粗细，opacity 由 size 间接体现（更像油画/铅笔）
  sizeCurve: 0.6,     // size = size_max × p^sizeCurve
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
  _getStamp(size, hardness, color, mode) {
    // mode 影响是否需要预乘 color（橡皮模式我们走 destination-out，stamp 颜色无所谓）
    const useColor = mode === "erase" ? "#000" : color;
    const key = `${size}|${hardness}|${useColor}`;
    if (this._stampCache && this._stampCache.key === key) return this._stampCache;

    // size 是直径；canvas 再外扩 2px 给抗锯齿
    const d = Math.max(2, Math.ceil(size) + 2);
    const r = d / 2;
    const stamp = document.createElement("canvas");
    stamp.width = d; stamp.height = d;
    const sctx = stamp.getContext("2d");
    const inner = r * Math.max(0, Math.min(1, hardness));
    const g = sctx.createRadialGradient(r, r, inner, r, r, r);
    g.addColorStop(0, useColor);
    g.addColorStop(1, hexToRgba(useColor, 0));
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, d, d);

    this._stampCache = { key, canvas: stamp, radius: r };
    return this._stampCache;
  }

  // 失效缓存（颜色 / size / hardness 大幅改 → 下次自动重做）
  invalidateStamp() { this._stampCache = null; }

  // settings 中的 color 也可以单独切（更轻量）
  setColor(color) {
    if (this._stroke) this._stroke.settings.color = color;
    this.invalidateStamp();
  }

  // 开始一笔。pressure=1 表示满压（包括"压感关"的情况下也传 1）。
  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    this._stroke = {
      layer,
      settings,
      mode, // "brush" or "erase"
      accumDist: 0,
      lastX: x, lastY: y, lastP: pressure,
    };
    // 起手第一个点落一颗（避免短笔/单点不画）
    this._stampOne(x, y, pressure);
  }

  // 加点。x,y 是 *doc 坐标*。
  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const dx = x - st.lastX, dy = y - st.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;

    const baseSize = st.settings.size;
    const step = Math.max(0.5, baseSize * st.settings.spacing);
    // 累计距离 + 沿线插值 stamp
    let traveled = -st.accumDist;
    let nextAt = step;
    while (traveled + dist >= nextAt) {
      const t = (nextAt - traveled) / dist;
      const px = st.lastX + dx * t;
      const py = st.lastY + dy * t;
      const pp = st.lastP + (pressure - st.lastP) * t;
      this._stampOne(px, py, pp);
      nextAt += step;
    }
    st.accumDist = (st.accumDist + dist) % step;
    st.lastX = x; st.lastY = y; st.lastP = pressure;
  }

  endStroke() {
    this._stroke = null;
  }
  cancelStroke() {
    this._stroke = null;
  }

  _stampOne(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    const p = Math.max(0, Math.min(1, pressure));

    const sizeMul = s.pressureToSize ? Math.pow(p, s.sizeCurve) : 1;
    const opaMul = s.pressureToOpacity ? Math.pow(p, s.opacityCurve) : 1;
    const size = Math.max(0.5, s.size * sizeMul);
    const alpha = Math.max(0, Math.min(1, s.opacity * opaMul));
    if (alpha < 0.001) return;

    const stamp = this._getStamp(size, s.hardness, s.color, st.mode);
    const ctx = st.layer.ctx;

    const prevAlpha = ctx.globalAlpha;
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalAlpha = alpha;
    if (st.mode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
    } else {
      ctx.globalCompositeOperation = "source-over";
    }

    // stamp.canvas 是直径 size+2 的位图；居中 draw
    const r = stamp.radius;
    ctx.drawImage(stamp.canvas, x - r, y - r);

    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevComp;
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
