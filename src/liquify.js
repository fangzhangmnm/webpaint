// 液化引擎。和 brush 完全独立（液化是 displacement field 重采样，paint 是 stamp 撒色）。
//
// 数学（详见 docs/artist-priorities.md 里 v46 讨论）：
//   每个 event 在 brush footprint 内生成 displacement (dx, dy)，
//   dest[x, y] = source[x - dx, y - dy]  (bilinear backward sample)
//   source = **本次 event 前** layer 像素的快照（getImageData 拿一份）。
//   反复 event 在 layer 上累加变形 = 天然的 "重复液化让形浮现" 心智。
//
// 五种 mode（先做 4 个，reconstruct 不做）：
//   push (推):  (dx,dy) = velocity * f * strength
//   pinch (收): (dx,dy) = (center - p) * f * strength      朝中心拉
//   bloat (胀): (dx,dy) = (p - center) * f * strength      外推
//   twirl (旋): (dx,dy) = perp(p - center) * f * strength  切向旋
// f = smoothstep(1 - r/R)，中心 1 边缘 0，hardness 自然圆边。
//
// **dx 坑保护**（v26 教训）：液化的速度 / displacement 全靠 (smX, smY) delta
// 算。这俩在 input.js _move 已经走完 timeStamp 单调过滤 + 四件套平滑，所以
// liquify.extendStroke 直接吃 doc 坐标 (x, y, dt)，**不需要**自己再过滤 raw。
// 详见 docs/ipad-coalesced-events.md。
//
// 性能：R=50 → ~7850 像素/event × 4 bilinear tap ≈ 31K typed-array reads/event。
// JS 在 16ms 帧预算内能跑。R=100 翻 4 倍。未来升 WebGL 时 mode 公式不变，只
// 把循环换成 fragment shader。

export class LiquifyEngine {
  constructor() {
    this._stroke = null;   // { layer, settings, lastX, lastY, dirty }
  }

  beginStroke(layer, settings, x, y) {
    this._stroke = {
      layer,
      settings,
      lastX: x,
      lastY: y,
      dirty: null,      // 累积 doc-px bbox，给 board 用
    };
    // 第一次 down 不变形（没有 velocity）。等下一个 move event。
  }

  // 每个 event 一次重采样。x, y 已经是 input.js 处理过的 smX/smY 转 doc 坐标。
  extendStroke(x, y) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    const R = Math.max(2, s.size);                       // 半径 (doc-px)
    const strength = Math.max(0, Math.min(2, s.strength)); // 0..1 主区间，上限 2 给极端
    const cx = x, cy = y;

    const layer = st.layer;
    if (layer.bboxW <= 0 || layer.bboxH <= 0) {
      // 空层无像素可液化，跳
      st.lastX = x; st.lastY = y;
      return;
    }
    // 让 layer bbox 包住 brush footprint（被推到边缘外的像素能落地）
    // ensureBbox 会 clamp 到 doc 边界；ensure 后再读 bbox 才对
    layer.ensureBbox(
      Math.floor(cx - R), Math.floor(cy - R),
      Math.ceil(cx + R),  Math.ceil(cy + R),
    );
    const lbX = layer.bboxX, lbY = layer.bboxY;
    const lbW = layer.bboxW, lbH = layer.bboxH;
    // brush footprint bbox（doc 坐标），clamp 到 layer 实际像素区
    const x0 = Math.max(lbX, Math.floor(cx - R));
    const y0 = Math.max(lbY, Math.floor(cy - R));
    const x1 = Math.min(lbX + lbW, Math.ceil(cx + R));
    const y1 = Math.min(lbY + lbH, Math.ceil(cy + R));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) {
      st.lastX = x; st.lastY = y;
      return;
    }

    // velocity（push mode）
    const vx = x - st.lastX;
    const vy = y - st.lastY;

    // 拿 source ImageData（layer 当前像素，转 layer-local 坐标）
    const ctx = layer.ctx;
    const src = ctx.getImageData(x0 - lbX, y0 - lbY, w, h);
    const dst = new ImageData(w, h);
    const sdat = src.data, ddat = dst.data;

    const mode = s.mode;
    const R2 = R * R;

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const wx = x0 + px, wy = y0 + py;        // world (doc) coords
        const dxc = wx - cx, dyc = wy - cy;
        const r2 = dxc * dxc + dyc * dyc;
        const idx = (py * w + px) * 4;
        if (r2 >= R2) {
          // 圈外：原样 copy
          ddat[idx]     = sdat[idx];
          ddat[idx + 1] = sdat[idx + 1];
          ddat[idx + 2] = sdat[idx + 2];
          ddat[idx + 3] = sdat[idx + 3];
          continue;
        }
        const r = Math.sqrt(r2);
        const t = 1 - r / R;
        const f = t * t * (3 - 2 * t);    // smoothstep
        let dx, dy;
        switch (mode) {
          case "pinch": dx = -dxc * f * strength; dy = -dyc * f * strength; break;
          case "bloat": dx =  dxc * f * strength; dy =  dyc * f * strength; break;
          case "twirl": dx = -dyc * f * strength; dy =  dxc * f * strength; break;
          case "push":
          default:      dx =  vx  * f * strength; dy =  vy  * f * strength;
        }
        // backward sample：从 (wx - dx, wy - dy) 取 → 转 src local
        const sx = (wx - dx) - x0;
        const sy = (wy - dy) - y0;
        bilinearSample(sdat, w, h, sx, sy, ddat, idx);
      }
    }
    ctx.putImageData(dst, x0 - lbX, y0 - lbY);

    // dirty bbox 累积
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
}

// bilinear 取样 sdat[sx, sy] → ddat[dstIdx..+3]。sx/sy 浮点；越界 → 透明黑。
function bilinearSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const x0 = ix, x1 = ix + 1;
  const y0 = iy, y1 = iy + 1;
  // 4 个邻居像素的索引（越界 → 各通道 0）
  const p00 = (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h) ? (y0 * w + x0) * 4 : -1;
  const p10 = (x1 >= 0 && x1 < w && y0 >= 0 && y0 < h) ? (y0 * w + x1) * 4 : -1;
  const p01 = (x0 >= 0 && x0 < w && y1 >= 0 && y1 < h) ? (y1 * w + x0) * 4 : -1;
  const p11 = (x1 >= 0 && x1 < w && y1 >= 0 && y1 < h) ? (y1 * w + x1) * 4 : -1;
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
