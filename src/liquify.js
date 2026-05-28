// 液化引擎 (v48 / path A: accumulated displacement field)。
//
// 核心思想（论证见 docs/liquify-blur.md）：
//   不在 layer 像素上 in-place 迭代 bilinear（v46 / v47 这么干会糊）。
//   改成：
//     1. beginStroke 拍一张 startSnap = layer 当前像素（不变，只读）
//     2. dispField[x, y] = (dx, dy) 累积本笔触至今的总位移场
//     3. 每个 event 在 footprint 内累加 dispField += smoothstep * mode-formula
//     4. 同一 footprint 内每像素：dst[x,y] = startSnap[x - dispField[x,y]]
//                                          ↑ bilinear 只过一次低通；多次 event 也不糊
//
//   bonus: reconstruct 模式天然就有 —— 把 dispField 在 footprint 内乘 (1 - α)
//   就是"渐隐位移、回归 startSnap"。
//
// 数据结构：
//   _stroke = {
//     layer, settings,
//     lastX, lastY,
//     dirty,
//     startSnap: layer.snapshot(),       // { bboxX, bboxY, bboxW, bboxH, imageData }
//     dispField: {                       // 和 layer.bbox 同步（ensureBbox 后 _regrow）
//       bboxX, bboxY, bboxW, bboxH,
//       data: Float32Array(2 * W * H),   // 交错 [dx0,dy0,dx1,dy1,...]
//     },
//   }
//
// 五种 mode（reconstruct = 新增，path A 几乎免费）：
//   push (推):       dispField += vel * f * strength
//   pinch (收):      dispField += (center - p) * f * strength
//   bloat (胀):      dispField += (p - center) * f * strength
//   twirl (旋):      dispField += perp(p - center) * f * strength
//   reconstruct (还原): dispField *= (1 - f * strength)     // 朝 0 衰减
//
// 性能：每个 event 约 N 像素 × (2 写 dispField + 4 读 startSnap bilinear) ≈ 6N 操作。
// R=60 → N ≈ 14400 → ~86K typed-array ops / event。和 v47 同量级，仍跑 16ms。
//
// dx 坑保护：跟 v46/v47 一样，extendStroke 拿 input.js 已过 timeStamp + 平滑
// 管线的 (x, y)，自身不再过滤 raw。

export class LiquifyEngine {
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
        bboxX: layer.bboxX, bboxY: layer.bboxY,
        bboxW: lbW, bboxH: lbH,
        data: new Float32Array(2 * lbW * lbH),
      },
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

    // 1) layer bbox 扩到包住 footprint（被推到边外的像素能落地）
    const fx0 = Math.floor(cx - R), fy0 = Math.floor(cy - R);
    const fx1 = Math.ceil(cx + R),  fy1 = Math.ceil(cy + R);
    layer.ensureBbox(fx0, fy0, fx1, fy1);
    if (layer.bboxW <= 0 || layer.bboxH <= 0) {
      // doc 外的笔，跳
      st.lastX = x; st.lastY = y;
      return;
    }
    // 2) dispField 同步 layer bbox（layer ensureBbox 只扩不缩 → 旧 ⊆ 新）
    this._syncDispFieldToLayer();

    const lbX = layer.bboxX, lbY = layer.bboxY;
    const lbW = layer.bboxW, lbH = layer.bboxH;
    // footprint clamped 到 layer
    const x0 = Math.max(lbX, fx0);
    const y0 = Math.max(lbY, fy0);
    const x1 = Math.min(lbX + lbW, fx1);
    const y1 = Math.min(lbY + lbH, fy1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) {
      st.lastX = x; st.lastY = y;
      return;
    }

    // velocity（push mode）
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

    // 目标 footprint 像素（要 putImageData 回 layer 的）
    const dst = new ImageData(w, h);
    const ddat = dst.data;

    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const wx = x0 + px, wy = y0 + py;
        const dxc = wx - cx, dyc = wy - cy;
        const r2 = dxc * dxc + dyc * dyc;
        const fIdx = ((wy - fbY) * fw + (wx - fbX)) * 2;

        // (a) 累加本 event 的位移（圈外 f=0 不变）
        if (r2 < R2) {
          const r = Math.sqrt(r2);
          const t = 1 - r / R;
          const ff = t * t * (3 - 2 * t);          // smoothstep
          if (mode === "reconstruct") {
            // 朝 0 衰减：dispField *= (1 - α)，α = ff * strength 被夹到 [0,1]
            const alpha = Math.min(1, ff * strength);
            fdata[fIdx]     *= (1 - alpha);
            fdata[fIdx + 1] *= (1 - alpha);
          } else {
            let ddx, ddy;
            switch (mode) {
              case "pinch": ddx = -dxc * ff * strength; ddy = -dyc * ff * strength; break;
              case "bloat": ddx =  dxc * ff * strength; ddy =  dyc * ff * strength; break;
              case "twirl": ddx = -dyc * ff * strength; ddy =  dxc * ff * strength; break;
              case "push":
              default:      ddx =  vx  * ff * strength; ddy =  vy  * ff * strength;
            }
            fdata[fIdx]     += ddx;
            fdata[fIdx + 1] += ddy;
          }
        }

        // (b) 从 startSnap 重采样（用累积 dispField，**不**从 layer）
        const tdx = fdata[fIdx];
        const tdy = fdata[fIdx + 1];
        const idx = (py * w + px) * 4;
        if (ssData) {
          const sx = (wx - tdx) - ssX;
          const sy = (wy - tdy) - ssY;
          bilinearSample(ssData, ssW, ssH, sx, sy, ddat, idx);
        }
        // 空 startSnap → ddat 默认 0（透明黑），液化空层无源可推 = 不变
      }
    }
    layer.ctx.putImageData(dst, x0 - lbX, y0 - lbY);

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
    // 释放 startSnap（一张 ImageData 可能 16MB）+ dispField（最多 32MB）
    this._stroke = null;
  }

  cancelStroke() {
    // 调用方（input.js _abortLiquify）会用 _liquifyPreSnap 还原 layer，
    // 这里只清状态
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
    if (f.bboxX === layer.bboxX && f.bboxY === layer.bboxY &&
        f.bboxW === layer.bboxW && f.bboxH === layer.bboxH) return;
    const nx = layer.bboxX, ny = layer.bboxY;
    const nw = layer.bboxW, nh = layer.bboxH;
    const newData = new Float32Array(2 * nw * nh);
    // 旧 dispField bbox ⊆ 新（layer.ensureBbox 永远扩不缩），整行 set 拷
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
      bboxX: nx, bboxY: ny, bboxW: nw, bboxH: nh,
      data: newData,
    };
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
