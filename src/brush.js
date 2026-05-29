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
  // === 四件套位置平滑（对标 Procreate 全套）===
  // 都在 input.js _move 内按 raw → MF → Stab → Pull → SL 顺序串联：
  // - StreamLine：一阶 IIR LPF（指数时间衰减）。0=raw 直传，1=完全跟不上。
  //   默认 0.3 微开 —— 手抖 / 整数量化不进笔触，又几乎没可感延迟。
  // - Stabilization：滑动平均（最近 N 点平均），N = 1 + stabilization × 16。
  //   高值笔感"团稳"，转向时切方向慢。Procreate 同名参数。
  // - Pull-Stabilizer：速度上限 follower。pullStab=1 时每帧最多动 maxStep×0.05 px。
  //   "实笔感" / 重笔；和 IIR 互补。Procreate "Stabilization" 实际包含这一档。
  // - Motion Filtering：角速度 clamp。motionFilter=1 时新方向不能偏离旧方向超过
  //   阈值（瞬尖被钝化）。Procreate 同名参数。
  // 默认除 StreamLine 外都为 0（行为同 v40）。
  streamline: 0.3,
  stabilization: 0,
  pullStabilizer: 0,
  motionFilter: 0,
  // taperIn：起手 fade-in 长度 = size × taperIn doc-px。
  // - 0 = 关（marker / 硬尖钢笔之类的 preset 用 0）
  // - 默认 1.5 微 taper：减弱 Apple Pencil 碰撞瞬间的 pressure spike 鼓"萝卜尖"
  // - taperOut 不做：抬笔时机不可预知，回溯改像素不值得（Pencil 物理 pressure
  //   抬笔本来就会掉）
  taperIn: 1.5,
  taperFloor: 0.4,            // touchdown 时 envelope = 0.4 而非 0；dot tap 仍可见
  color: "#1b1b1b",
  // v83 新加：从 brush preset 同步过来的 shape 描述（applyBrushPresetFrozen 写）
  // round → 圆；ellipse → 用 ctx.transform scale + rotate 绘 stamp（cache 仍是圆）
  shapeKind: "round",         // "round" | "ellipse" | "texture" (texture 待实装)
  shapeAspect: 1.0,           // ellipse 短轴 / 长轴比 (0.1..1.0)
  shapeRotation: 0,           // ellipse 旋转 radians（preset 里是度，apply 时换算）
  // v84 airbrush：time-stamp + direct-layer
  spacingKind: "distance",    // "distance" | "time"
  spacingValueMs: 16,         // 当 spacingKind="time" 用；distance 仍走 spacing 标量
  bufferMode: "stroke-buffer",// "stroke-buffer" | "direct-layer"
                              // direct-layer：跳过 stroke buffer，stamp 直接 source-over 到 layer
                              // 配合 time-stamp = 喷枪 hover 累积加深
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

  // step 走"当前 stamp 的有效半径"：低压感时 effSize 小，step 也小 →
  // 不再因为 stamp 直径远小于 step 而看到一颗颗豆豆。
  // 旧版（v19~v28）step 是整笔常量 = size × spacing，低压感时 stamp 缩成豆。
  _stepFor(s, pressure) {
    const p = Math.max(0, Math.min(1, pressure));
    const effSize = s.size * (s.pressureToSize ? Math.pow(p, s.sizeCurve) : 1);
    return Math.max(0.5, effSize * s.spacing);
  }

  beginStroke(layer, settings, x, y, pressure, mode = "brush") {
    // v84：两条路径
    //   stroke-buffer（默认 brush / eraser）：buffer + endStroke composite，opacity cap
    //   direct-layer（喷枪）：跳 buffer，stamp 直接 source-over 到 layer
    //     + time-stamp（spacingKind="time"）→ hover 时 setInterval 累积 stamp
    const direct = settings.bufferMode === "direct-layer";
    const timeStamp = settings.spacingKind === "time";
    let buffer = null, bufferCtx = null;
    if (!direct) {
      buffer = document.createElement("canvas");
      buffer.width = Math.max(1, layer.bboxW);
      buffer.height = Math.max(1, layer.bboxH);
      bufferCtx = buffer.getContext("2d");
    }
    this._stroke = {
      layer, settings, mode,
      lastX: x, lastY: y, lastP: pressure,
      accumDist: 0,
      strokeDist: 0,
      dirty: null,
      buffer, bufferCtx,
      bufBboxX: layer.bboxX,
      bufBboxY: layer.bboxY,
      bufBboxW: layer.bboxW,
      bufBboxH: layer.bboxH,
      direct,
      timeStamp,
      timer: null,
    };
    this._stampOne(x, y, pressure);
    // time-stamp：每 ms 间隔从最新 pos 喷一颗
    if (timeStamp) {
      const ms = Math.max(8, settings.spacingValueMs || 16);
      this._stroke.timer = setInterval(() => {
        const st = this._stroke;
        if (!st) return;
        this._stampOne(st.lastX, st.lastY, st.lastP);
      }, ms);
    }
  }

  // stamp 落在 buffer bbox 外 → 扩 buffer 到能容纳，clamp 在 doc 范围内
  _ensureBufferBbox(x0, y0, x1, y1) {
    const st = this._stroke;
    if (x0 >= st.bufBboxX && y0 >= st.bufBboxY &&
        x1 <= st.bufBboxX + st.bufBboxW && y1 <= st.bufBboxY + st.bufBboxH) return;
    const m = 32;
    let nx  = Math.floor(Math.min(st.bufBboxX, x0 - m));
    let ny  = Math.floor(Math.min(st.bufBboxY, y0 - m));
    let nx1 = Math.ceil(Math.max(st.bufBboxX + st.bufBboxW, x1 + m));
    let ny1 = Math.ceil(Math.max(st.bufBboxY + st.bufBboxH, y1 + m));
    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    nx1 = Math.min(st.layer.docW, nx1);
    ny1 = Math.min(st.layer.docH, ny1);
    const nw = nx1 - nx, nh = ny1 - ny;
    if (nw <= 0 || nh <= 0) return;
    const nb = document.createElement("canvas");
    nb.width = nw;
    nb.height = nh;
    const nctx = nb.getContext("2d");
    if (st.bufBboxW > 0 && st.bufBboxH > 0) {
      nctx.drawImage(st.buffer, st.bufBboxX - nx, st.bufBboxY - ny);
    }
    st.buffer = nb;
    st.bufferCtx = nctx;
    st.bufBboxX = nx;
    st.bufBboxY = ny;
    st.bufBboxW = nw;
    st.bufBboxH = nh;
  }

  extendStroke(x, y, pressure) {
    const st = this._stroke;
    if (!st) return;
    // time-stamp：不算距离，只更新 last，让 timer 在最新位置喷
    if (st.timeStamp) {
      st.lastX = x; st.lastY = y; st.lastP = pressure;
      return;
    }
    const dx = x - st.lastX;
    const dy = y - st.lastY;
    const L = Math.hypot(dx, dy);
    if (L === 0) return;
    let pos = 0;
    while (true) {
      // step 用本次 event 的目标 pressure 算（在 event 内常量）。
      // 想再精确可在 lerp 后用 sp 重算，但 240Hz event 之间 p 变化很小，差别看不出。
      const step = this._stepFor(st.settings, pressure);
      if (st.accumDist + (L - pos) < step) break;
      const need = step - st.accumDist;
      pos += need;
      st.strokeDist += step;          // 新 stamp 比上一颗远 step
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
    if (st && st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st && st.buffer) {
      // stroke-buffer 路径：buffer → layer composite at endStroke
      const layer = st.layer;
      const ctx = layer.ctx;
      const prevA = ctx.globalAlpha;
      const prevC = ctx.globalCompositeOperation;
      ctx.globalAlpha = st.settings.opacity;
      ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";
      ctx.drawImage(st.buffer, st.bufBboxX - layer.bboxX, st.bufBboxY - layer.bboxY);
      ctx.globalAlpha = prevA;
      ctx.globalCompositeOperation = prevC;
    }
    // direct-layer 路径：stamps 已经直接进 layer，endStroke 无 composite 步骤
    this._stroke = null;
  }

  cancelStroke() {
    const st = this._stroke;
    if (st && st.timer) { clearInterval(st.timer); st.timer = null; }
    // direct-layer cancel：layer 已经写脏了，没法回滚（除非外面有 snapshot）。
    // brush 用户基本不会主动 cancel airbrush，触屏中断走 history undo。
    this._stroke = null;
  }

  // 给 board 用：返回当前笔触的 live overlay，让 render 每帧在 layer 之上
  // 再画一遍 buffer，预览不立即写进 layer。endStroke 才把 buffer 烧进 layer。
  getLiveOverlay() {
    const st = this._stroke;
    if (!st || !st.buffer) return null;     // direct-layer 无 buffer → null（stamp 已在 layer 上，board 渲染时已包含）
    return {
      canvas: st.buffer,
      bboxX: st.bufBboxX, bboxY: st.bufBboxY,
      bboxW: st.bufBboxW, bboxH: st.bufBboxH,
      layer: st.layer,
      opacity: st.settings.opacity,
      mode: st.mode,
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
    let p = Math.max(0, Math.min(1, pressure));

    // Taper-in：起手 fade-in 减弱 Apple Pencil 碰撞瞬间的 pressure spike。
    // envelope = floor + (1-floor) × min(1, strokeDist / (size × taperIn))
    // 同时影响 size 和 opacity（乘进 p）→ 实际 stamp 更小、更淡。
    // floor > 0 保证 dot tap（strokeDist=0）仍然画得出一颗 mark。
    if (s.taperIn > 0) {
      const taperLen = s.size * s.taperIn;
      const t = Math.min(1, st.strokeDist / taperLen);
      const env = s.taperFloor + (1 - s.taperFloor) * t;
      p *= env;
    }

    const sizeMul = s.pressureToSize ? Math.pow(p, s.sizeCurve) : 1;
    const opaMul = s.pressureToOpacity ? Math.pow(p, s.opacityCurve) : 1;
    const size = Math.max(0.5, s.size * sizeMul);
    // **per-stamp alpha 不含 s.opacity**：opacity 在 endStroke 一次性乘进去，
    // 保证笔触折返 alpha 在 buffer 内 source-over 封顶 1.0 → 出 layer 时封顶 s.opacity。
    // paint / erase 都走 buffer；erase 的 dst-out 在 endStroke 应用，buffer 内永远 source-over。
    const alpha = Math.max(0, Math.min(1, opaMul));
    if (alpha < 0.001) return;

    // stamp 按 s.size 烤一次（缓存），这里按 actual size 缩放 drawImage
    const stamp = this._getStamp(s.size, s.hardness, s.color, st.mode);

    // 目标直径 = size + 2px 给 AA 边和源贴图一致比例
    const drawD = size + 2 * (size / stamp.baseSize);
    const drawR = drawD / 2;
    const x0 = x - drawR, y0 = y - drawR, x1 = x + drawR, y1 = y + drawR;

    // 确保 layer 覆盖（buffer 路径下也 ensureBuffer）
    st.layer.ensureBbox(x0, y0, x1, y1);
    let ctx, lx, ly;
    if (st.direct) {
      // direct-layer：直接写 layer.ctx；坐标 = doc - layer.bbox
      ctx = st.layer.ctx;
      lx = x - st.layer.bboxX;
      ly = y - st.layer.bboxY;
    } else {
      this._ensureBufferBbox(x0, y0, x1, y1);
      ctx = st.bufferCtx;
      lx = x - st.bufBboxX;
      ly = y - st.bufBboxY;
    }
    const prevAlpha = ctx.globalAlpha;
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalAlpha = alpha;
    // direct-layer 喷枪用 source-over；direct-layer + eraser 用 dst-out
    ctx.globalCompositeOperation = (st.direct && st.mode === "erase") ? "destination-out" : "source-over";

    // v83：ellipse scale Y + rotate；round 走快路径
    if (s.shapeKind === "ellipse" && (s.shapeAspect !== 1 || s.shapeRotation !== 0)) {
      ctx.save();
      ctx.translate(lx, ly);
      if (s.shapeRotation) ctx.rotate(s.shapeRotation);
      if (s.shapeAspect !== 1) ctx.scale(1, s.shapeAspect);
      ctx.drawImage(stamp.canvas, -drawR, -drawR, drawD, drawD);
      ctx.restore();
    } else {
      ctx.drawImage(stamp.canvas, lx - drawR, ly - drawR, drawD, drawD);
    }

    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevComp;

    // 累积 dirty bbox（doc-px），给 dirty-rect render 用
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
