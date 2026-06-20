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

import type { Layer } from "./doc.ts";
import type { Selection } from "./selection.ts";

interface LiquifySettings {
  bleed?: string;
  size: number;
  strength: number;
  mode: string;
}

interface DispField {
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  data: Float32Array;
}

interface LayerSnapshot {
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  imageData?: ImageData | null;
}

interface LiquifyStroke {
  layer: Layer;
  settings: LiquifySettings;
  bleed: string;
  lastX: number;
  lastY: number;
  dirty: [number, number, number, number] | null;
  startSnap: LayerSnapshot;
  dispField: DispField;
  maskData: Uint8ClampedArray | null;
  maskBbox: { x: number; y: number; w: number; h: number } | null;
}

export class LiquifyEngine {
  _stroke: LiquifyStroke | null;

  constructor() {
    this._stroke = null;
  }

  // v124 selection 参数：{ maskCanvas, bboxX, bboxY, bboxW, bboxH } 来自 doc.selection。
  // 给了就在每个 stamp 内 mask 外像素**保留 startSnap**（不液化）→ live preview 立刻
  // 看到选区限制，跟 brush 一致；commit 时 Selection.applyMaskPostStroke 兜底也无害。
  //
  // v147 选区边界取样模式 settings.bleed（仅在有选区时生效，处理 dest 在选区内但位移源落选区外）：
  //   "import" — 源不夹：位移源落选区外仍照采 → 真把外部内容拉进来
  //   "clip"   — 设墙：源落选区外 → 保留 dest 原像素（无位移），什么都不进
  //   "edge"   — (默认) 沿 dest→source 射线 march 到刚离开选区的边界点采样
  //              → 边界像素沿拉拽方向被无限拉长，无外部内容、无中轴接缝（见 docs/liquify-blur.md）
  beginStroke(layer: Layer, settings: LiquifySettings, x: number, y: number, selection: Selection | null) {
    const lbW = Math.max(1, layer.bboxW);
    const lbH = Math.max(1, layer.bboxH);
    const bleed = settings.bleed || "edge";
    // 把 selection mask 烤进一个 Uint8 array 与 layer.bbox 对齐 (mask alpha 通道 0..255)
    let maskData: Uint8ClampedArray | null = null;
    if (selection) {
      const c = document.createElement("canvas");
      c.width = lbW; c.height = lbH;
      const cctx = c.getContext("2d")!;
      cctx.drawImage(selection.maskCanvas, selection.bboxX - layer.bboxX, selection.bboxY - layer.bboxY);
      maskData = cctx.getImageData(0, 0, lbW, lbH).data;   // RGBA, 看 [i*4+3]
    }
    this._stroke = {
      layer,
      settings,
      bleed,
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
      maskData,
      maskBbox: selection ? { x: layer.bboxX, y: layer.bboxY, w: lbW, h: lbH } : null,
    };
  }

  // 每个 event 一次。x, y 已经是 input.js 处理过的 doc 坐标。
  extendStroke(x: number, y: number) {
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
    // v124 (user：「预览的时候没有 apply 选区」) selection mask
    const maskData = st.maskData;
    const maskBox = st.maskBbox;
    const bleed = st.bleed;
    const maskX = maskBox ? maskBox.x : 0, maskY = maskBox ? maskBox.y : 0;
    const maskW = maskBox ? maskBox.w : 0, maskH = maskBox ? maskBox.h : 0;
    // 整数 cell (ix,iy) 是否在选区内（mask alpha>=128）
    const cellIn = (ix: number, iy: number) => {
      const mx = ix - maskX, my = iy - maskY;
      if (mx < 0 || my < 0 || mx >= maskW || my >= maskH) return false;
      return maskData![(my * maskW + mx) * 4 + 3] >= 128;
    };
    // doc 坐标 (px,py)（四舍五入到最近 cell）是否在选区内
    const inMask = (px: number, py: number) => cellIn(Math.round(px), Math.round(py));
    // 浮点源 (fsx,fsy) 的 bilinear 2×2 footprint 是否**整个**在选区内。
    // v147 修白边：只测中心点不够——中心 in-mask 但某个角 tap 落选区外时，
    // bilinear 会把外面（可能透明）像素混进来 → 边界一条细白线。要求 4 tap 全 in。
    const srcFootprintIn = (fsx: number, fsy: number) => {
      const ix = Math.floor(fsx), iy = Math.floor(fsy);
      return cellIn(ix, iy) && cellIn(ix + 1, iy) && cellIn(ix, iy + 1) && cellIn(ix + 1, iy + 1);
    };

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
              case "twirl":   ddx = -dyc * ff * strength; ddy =  dxc * ff * strength; break;
              case "twirlCW": ddx =  dyc * ff * strength; ddy = -dxc * ff * strength; break;
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
          // 源采样位置（默认 = 位移后位置）。
          let srcX = wx - tdx, srcY = wy - tdy;
          if (maskData) {
            // v124 dest 在选区外 → 不液化，原像素直采（commit 时 applyMaskPostStroke 兜底）
            if (!inMask(wx, wy)) {
              srcX = wx; srcY = wy;
            } else if (bleed !== "import" && !srcFootprintIn(srcX, srcY)) {
              // v147 dest 在选区内但位移源的 bilinear footprint 触及选区外 → 按 bleed 模式处理
              if (bleed === "clip") {
                // 设墙：保留 dest 原像素，外部什么都不进
                srcX = wx; srcY = wy;
              } else {
                // edge：沿 dest→source 射线 march 到刚离开选区的边界点（无中轴接缝）
                const len = Math.hypot(tdx, tdy);
                if (len >= 1e-3) {
                  const dirX = -tdx / len, dirY = -tdy / len;
                  const maxK = Math.min(Math.ceil(len), 4096);
                  // 关键（v147 修斑马）：只走**整数 cell**，srcX/Y 落整数格 →
                  // 下面 bilinear 退化成 point sample，绝不把 2×2 footprint 里的
                  // 选区外像素混进来。否则边界点是浮点，bilinear 跨界混样 +
                  // 浮点抖动 → 选区内外差大时高频条纹（斑马）。wx/wy 本就是整数=dest。
                  let sxi = wx, syi = wy;             // dest（整数，已知 in-mask）
                  for (let k = 1; k <= maxK; k++) {
                    const rxi = Math.round(wx + dirX * k);
                    const ryi = Math.round(wy + dirY * k);
                    if (!inMask(rxi, ryi)) break;     // 越界：sxi/syi 是最后一个 in-mask 整数 cell
                    sxi = rxi; syi = ryi;
                  }
                  srcX = sxi; srcY = syi;
                } else {
                  srcX = wx; srcY = wy;
                }
              }
            }
          }
          bilinearSample(ssData, ssW, ssH, srcX - ssX, srcY - ssY, ddat, idx);
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

  // v131: 给 board 用——液化 stroke 进行中时禁掉 partial render（Windows Skia sliver bug）
  isActive() { return !!this._stroke; }

  cancelStroke() {
    // 调用方（input.js _abortLiquify）会用 PixelEdit 事务 abort() 还原 layer，
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
    const st = this._stroke!;
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
// v135 (user：「液化做一下防黑边」)
//   越界返 0 = 黑透明在 buildup 背景上显实黑。改 clamp-to-edge：
//   越界取边像素 → "重复 / 引力透镜" 视觉保留，但没实黑（边像素=透明的话仍透，不糊黑）
function bilinearSample(sdat: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, ddat: Uint8ClampedArray, dstIdx: number) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const cx0 = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
  const cx1 = (ix + 1) < 0 ? 0 : (ix + 1) >= w ? w - 1 : (ix + 1);
  const cy0 = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
  const cy1 = (iy + 1) < 0 ? 0 : (iy + 1) >= h ? h - 1 : (iy + 1);
  const p00 = (cy0 * w + cx0) * 4;
  const p10 = (cy0 * w + cx1) * 4;
  const p01 = (cy1 * w + cx0) * 4;
  const p11 = (cy1 * w + cx1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 4; c++) {
    ddat[dstIdx + c] = sdat[p00 + c] * w00 + sdat[p10 + c] * w10
                     + sdat[p01 + c] * w01 + sdat[p11 + c] * w11;
  }
}
