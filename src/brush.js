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
    // Debug：累计本笔 stamp 次数，给 HUD 显示用，定位 knot 根因
    this._stampCount = 0;
  }
  // Debug API
  resetStampCount() { this._stampCount = 0; }
  getStampCount() { return this._stampCount; }

  // 预渲染一个 stamp 图。color 直接画进去；后期改纹理时这里换实现即可。
  //
  // **PERF**：cache key 里**不**含 size —— stamp 按 settings.size（最大压感）
  // 烤一次，每颗 stamp 用 drawImage 的 dest-size 缩放下来。否则 size 因压感
  // 每颗都变 → 每颗 cache miss → 每颗都重建 canvas + gradient，200Hz 飘起来
  // GC + GPU 上传立刻爆。color / hardness / mode 才是真正会触发重做的参数。
  //
  // base canvas 内分辨率 = MAX(64, settings.size) + 2px AA 边 —— 太小会让
  // 缩小后的 stamp 锯齿化；64 是个折中（GPU 上的小贴图不贵）。
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
    const inner = r * Math.max(0, Math.min(1, hardness));
    // Safari radial gradient 在 inner circle 内是 implementation-specific（MDN
    // 原话 "undefined inside the inner circle"）。为了不依赖这个行为：先画外环
    // gradient（fillRect 整张），再画 solid 内盘覆盖中心。保证中心 alpha=1。
    const g = sctx.createRadialGradient(r, r, inner, r, r, r);
    g.addColorStop(0, useColor);
    g.addColorStop(1, hexToRgba(useColor, 0));
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, d, d);
    // 显式 solid 内盘
    if (inner > 0) {
      sctx.fillStyle = useColor;
      sctx.beginPath();
      sctx.arc(r, r, inner, 0, Math.PI * 2);
      sctx.fill();
    }

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

  // 开始一笔。pressure=1 表示满压（包括"压感关"的情况下也传 1）。
  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    this._stroke = {
      layer,
      settings,
      mode, // "brush" or "erase"
      accumDist: 0,
      lastX: x, lastY: y, lastP: pressure,
      dirty: null,    // [x0,y0,x1,y1] doc-px；累积所有 stamp 的 bbox，给 dirty-rect render 用
    };
    // 起手第一个点落一颗（避免短笔/单点不画）
    this._stampOne(x, y, pressure);
  }

  // 加点。x,y 是 *doc 坐标*。
  // accumDist 语义 = "上一颗 stamp 到本段起点的距离"（>=0）。
  // 本段第一颗 stamp 落在 segPos = step - accumDist 处；之后每隔 step 一颗。
  // step 用 *当前压感缩放后的 size* 算（与 Procreate 一致 —— spacing 是当前直径
  // 的百分比，不是最大直径），所以低压时间距也会缩小，不会散成点。
  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const dx = x - st.lastX, dy = y - st.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;

    const s = st.settings;
    const pNow = Math.max(0.05, Math.min(1, pressure));
    const sizeMulNow = s.pressureToSize ? Math.pow(pNow, s.sizeCurve) : 1;
    const step = Math.max(0.5, s.size * sizeMulNow * s.spacing);

    // 首颗 stamp 在 segPos 处；accumDist > step 时（step 因压感变小）就立即落一颗
    let segPos = step - st.accumDist;
    if (segPos < 0) segPos = 0;

    while (segPos <= dist) {
      const t = segPos / dist;
      const px = st.lastX + dx * t;
      const py = st.lastY + dy * t;
      const pp = st.lastP + (pressure - st.lastP) * t;
      this._stampOne(px, py, pp);
      segPos += step;
    }
    // 末次落的位置 = segPos - step；它到段尾的距离 = dist - (segPos - step)
    st.accumDist = dist - (segPos - step);
    st.lastX = x; st.lastY = y; st.lastP = pressure;
  }

  endStroke() {
    this._stroke = null;
  }
  cancelStroke() {
    this._stroke = null;
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
    const alpha = Math.max(0, Math.min(1, s.opacity * opaMul));
    if (alpha < 0.001) return;

    // stamp 按 s.size 烤一次（缓存），这里按 actual size 缩放 drawImage
    const stamp = this._getStamp(s.size, s.hardness, s.color, st.mode);
    const ctx = st.layer.ctx;

    const prevAlpha = ctx.globalAlpha;
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";

    // 目标直径 = size + 2px 给 AA 边和源贴图一致比例
    const drawD = size + 2 * (size / stamp.baseSize);
    const drawR = drawD / 2;
    ctx.drawImage(stamp.canvas, x - drawR, y - drawR, drawD, drawD);
    this._stampCount++;

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
