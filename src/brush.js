// 反煤气灯：硬编码模块版本，app.js 启动时对账。和 src/version.js + 其他
// 模块 lockstep 改。WebXiaoHeiWu 的教训："I forgot it across three bumps
// in a row; the user caught it"。bump.sh 可以一次性 sed 所有 module。
export const MODULE_VERSION = "v24-2026-05-26";

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
    const hd = Math.max(0, Math.min(1, hardness));
    // 第一步：**fillRect 整张 canvas** —— 每个像素 RGB = useColor, α=1。
    // 包括圆外面那些"用不到"的像素也是 useColor，关键是 bilinear 在采圆边时
    // 不会从外面的 transparent black 引入 RGB 漂移（经典 sprite 白边/黑边 bug）。
    sctx.fillStyle = useColor;
    sctx.fillRect(0, 0, d, d);
    // 第二步：destination-out + 反向 alpha gradient 削外圈 alpha。
    // dest-out 只改 alpha 不改 RGB（unpremul 语义），所以源 canvas 的 RGB
    // 保持纯 useColor，只有 alpha 在 hardness×r 到 r 间 falloff，r 之外 α=0。
    // hd 用 Math.min(_, 0.999) 防止两个 stop 在同位置时 stops 序覆盖坑。
    sctx.globalCompositeOperation = "destination-out";
    const safeHd = Math.min(hd, 0.999);
    const g = sctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(0,0,0,0)");       // 圆心：不擦
    g.addColorStop(safeHd, "rgba(0,0,0,0)");  // 到 hardness×r：还是不擦
    g.addColorStop(1, "rgba(0,0,0,1)");       // 到 r：全擦
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, d, d);
    sctx.globalCompositeOperation = "source-over";

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

  // **v23 cache-and-consume 架构**（user 推翻 v19 设计）：
  //   on_new_event(x, y, p):
  //     push 到 cache
  //     consume_cache()
  //   consume_cache():
  //     for segment in cache:
  //       walk segment 每 step 一颗 stamp（沿 path arc-length 严格 step 间距）
  //   raw_stamp(): 此时距上一颗保证 = step（沿 path），无 dedup
  //
  // 之前 v0-v22 用 lastX/Y/accumDist 单 segment 状态。功能等价但 cache 模型
  // 让未来 look-ahead 平滑 / 真曲线 stamping 有地方接。
  //
  // step = settings.size × spacing （v19 起不走 pressure）

  _stepFor(s) {
    return Math.max(0.5, s.size * s.spacing);
  }

  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    const step = this._stepFor(settings);
    this._stroke = {
      layer,
      settings,
      mode,
      cache: [{ x, y, p: pressure }],     // raw events 缓存 (consume 后会被裁)
      segPathPos: [0],                     // 累计 path 长度：segPathPos[i] = cache[i] 离起点的 path 距离
      nextStampPos: step,                  // 下一颗 stamp 应该落在 path 上哪个位置
      dirty: null,
      positions: [],                       // 所有 emit 的 stamp (x, y) 给 debug marker
      rawXY: [x, y],                       // 所有 raw event (x, y) 给 debug marker（不被 consume cleanup 裁）
    };
    this._stampCount = 0;
    // Touchdown stamp 立刻落在 (x, y) (path position 0)
    this._stampOne(x, y, pressure);
  }

  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    const prev = st.cache[st.cache.length - 1];
    const dx = x - prev.x, dy = y - prev.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) return;
    st.cache.push({ x, y, p: pressure });
    st.segPathPos.push(st.segPathPos[st.segPathPos.length - 1] + segLen);
    st.rawXY.push(x, y);
    this._consumeCache();
  }

  _consumeCache() {
    const st = this._stroke;
    const step = this._stepFor(st.settings);
    const totalPath = st.segPathPos[st.segPathPos.length - 1];

    while (st.nextStampPos <= totalPath) {
      // 找包含 nextStampPos 的 segment
      let segIdx = 0;
      while (segIdx + 1 < st.segPathPos.length && st.segPathPos[segIdx + 1] < st.nextStampPos) {
        segIdx++;
      }
      if (segIdx + 1 >= st.cache.length) break;

      const segStart = st.segPathPos[segIdx];
      const segEnd   = st.segPathPos[segIdx + 1];
      const t = (st.nextStampPos - segStart) / (segEnd - segStart);

      const a = st.cache[segIdx];
      const b = st.cache[segIdx + 1];
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const pp = a.p + (b.p - a.p) * t;

      this._stampOne(px, py, pp);
      st.nextStampPos += step;
    }

    // 清理：option A (chord lerp) 没 look-ahead，只需保留最后一个 cache entry
    // 用来算下一段 segment
    while (st.cache.length > 1) {
      st.cache.shift();
      st.segPathPos.shift();
    }
  }

  endStroke() {
    this._stroke = null;
  }

  // Debug：给 input.js endStroke 后调，返回这一笔的诊断信息
  //   uniq    = 不同整数 (x, y) 位置数；若 << stampCount 则坐标真的重复
  //   aMin/aMax = 沿笔触采几点的 layer alpha
  //   dMean/dStd/dMin/dMax = 相邻 stamp 距离统计（doc-px）
  //     - 理想：dMean ≈ step, dStd 接近 0, dMin/dMax 紧贴 dMean
  //     - bead 信号：dStd 大，dMin 远小于 step（聚集），dMax 远大于 step（gap）
  getStrokeDiagnostic() {
    const st = this._stroke;
    if (!st || !st.positions || st.positions.length === 0) return null;
    const pts = st.positions;
    const n = pts.length / 2;
    const uniq = new Set();
    for (let i = 0; i < n; i++) uniq.add(`${Math.round(pts[i*2])},${Math.round(pts[i*2+1])}`);
    // 沿笔触每 ~max(1, n/8) 颗采一点 alpha
    const stride = Math.max(1, Math.floor(n / 8));
    const layer = st.layer;
    let aMin = 1, aMax = 0;
    for (let i = 0; i < n; i += stride) {
      const px = Math.round(pts[i*2]);
      const py = Math.round(pts[i*2+1]);
      if (px < 0 || py < 0 || px >= layer.width || py >= layer.height) continue;
      try {
        const a = layer.ctx.getImageData(px, py, 1, 1).data[3] / 255;
        if (a < aMin) aMin = a;
        if (a > aMax) aMax = a;
      } catch {}
    }
    // 相邻 stamp 距离分布
    let dMin = Infinity, dMax = 0, dSum = 0, dSumSq = 0, dCount = 0;
    for (let i = 1; i < n; i++) {
      const dx = pts[i*2] - pts[(i-1)*2];
      const dy = pts[i*2+1] - pts[(i-1)*2+1];
      const d = Math.hypot(dx, dy);
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
      dSum += d; dSumSq += d * d; dCount++;
    }
    const dMean = dCount > 0 ? dSum / dCount : 0;
    const dVar = dCount > 0 ? (dSumSq / dCount) - dMean * dMean : 0;
    const dStd = Math.sqrt(Math.max(0, dVar));
    if (dCount === 0) { dMin = 0; dMax = 0; }
    return {
      n, uniq: uniq.size, dropped: 0,    // v23 无 dedup，恒 0
      aMin, aMax, dMean, dStd, dMin, dMax,
      // 复制一份 stamp 位置数组给 board 画视觉 marker (红)
      positions: Float32Array.from(pts),
      // raw input 位置数组（蓝），用来 diff "input 进来就抖" vs "brush 把均匀变不均匀"
      rawPositions: Float32Array.from(st.rawXY),
    };
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
    // v23: 无 dedup。距上一颗 path arc-length 严格 = step (consume_cache 保证)
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
    st.positions.push(x, y);

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
