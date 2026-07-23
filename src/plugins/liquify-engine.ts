// 液化引擎 (v48 / path A: accumulated displacement field)。
//
// 核心思想（论证见 docs/20260528-liquify-blur.md）：
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
//     startSnap: layer.snapshotImageData(),  // { bboxX, bboxY, bboxW, bboxH, imageData }（只读物化，非 undo 包）
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

import type { Layer } from "../doc.ts";
import type { Selection } from "../selection.ts";

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

// Layer.snapshotImageData() 产物（CPU 算法读者的只读物化——不是 undo 包，别拿去 restore）。
interface LayerSnapshot {
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  imageData?: ImageData | null;
}

// doc-space 选区 mask 平面：与 dispField 同 bbox 同步增长（S8 · charter H7 根治）。
//   判定基底 = doc 空间（不再 tie layer.bbox）——内容被推出旧内容包围盒的像素照常按选区裁剪。
interface MaskPlane { x: number; y: number; w: number; h: number; data: Uint8Array }

interface LiquifyStroke {
  layer: Layer;
  settings: LiquifySettings;
  bleed: string;
  lastX: number;
  lastY: number;
  dirty: [number, number, number, number] | null;
  startSnap: LayerSnapshot;
  dispField: DispField;
  selection: Selection | null;
  mask: MaskPlane | null;   // selection 非空时非空；覆盖 dispField bbox；平面外查 selection.sampleAt
}

export class LiquifyEngine {
  _stroke: LiquifyStroke | null;

  constructor() {
    this._stroke = null;
  }

  // v124 selection 参数：Selection（gray8 tile mask）来自 doc.selection。
  // 给了就在每个 stamp 内 mask 外像素**保留 startSnap**（不液化）→ live preview 立刻
  // 看到选区限制，跟 brush 一致；commit 时 Selection.applyMaskPostStroke 兜底也无害。
  //
  // v147 选区边界取样模式 settings.bleed（仅在有选区时生效，处理 dest 在选区内但位移源落选区外）：
  //   "import" — 源不夹：位移源落选区外仍照采 → 真把外部内容拉进来
  //   "clip"   — 设墙：源落选区外 → 保留 dest 原像素（无位移），什么都不进
  //   "edge"   — (默认) 沿 dest→source 射线 march 到刚离开选区的边界点采样
  //              → 边界像素沿拉拽方向被无限拉长，无外部内容、无中轴接缝（见 docs/20260528-liquify-blur.md）
  beginStroke(layer: Layer, settings: LiquifySettings, x: number, y: number, selection: Selection | null) {
    const lbW = Math.max(1, layer.bboxW);
    const lbH = Math.max(1, layer.bboxH);
    const bleed = settings.bleed || "edge";
    // S8（charter H7 根治）：mask 是 **doc-space 平面**，初始覆盖 dispField 起始 bbox，随
    //   _growDispField 同步增长；平面外的查询（位移源可能落在扫过区之外）直查 selection tile。
    const mask: MaskPlane | null = selection
      ? { x: layer.bboxX, y: layer.bboxY, w: lbW, h: lbH, data: selection.materializeMaskRegion(layer.bboxX, layer.bboxY, lbW, lbH) }
      : null;
    this._stroke = {
      layer,
      settings,
      bleed,
      lastX: x,
      lastY: y,
      dirty: null,
      // startSnap = layer 当前像素的只读物化（笔触全程只读源头）
      startSnap: layer.snapshotImageData(),
      // dispField 和 layer bbox 对齐；空层 bbox=0 时占位 1×1 全 0
      dispField: {
        bboxX: layer.bboxX, bboxY: layer.bboxY,
        bboxW: lbW, bboxH: lbH,
        data: new Float32Array(2 * lbW * lbH),
      },
      selection,
      mask,
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

    // 1) footprint 夹到 **doc 边界**（不是 layer.bbox）。tile era：layer.ensureBbox 已是 no-op、
    //    layer.bbox 是「现有内容」包围盒、扩不动——靠它夹会把推出旧内容边的像素截掉（degeneration，
    //    canvas 时代 ensureBbox 会把图层画布扩大让像素落地）。tile putImageData 按需分配 tile，写哪都行。
    const fx0 = Math.floor(cx - R), fy0 = Math.floor(cy - R);
    const fx1 = Math.ceil(cx + R),  fy1 = Math.ceil(cy + R);
    const x0 = Math.max(0, fx0);
    const y0 = Math.max(0, fy0);
    const x1 = Math.min(layer.docW, fx1);
    const y1 = Math.min(layer.docH, fy1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) {
      // 全在 doc 外
      st.lastX = x; st.lastY = y;
      return;
    }
    // 2) dispField 长到覆盖本 footprint（不再 tie layer.bbox；只扩不缩，doc 内有界）
    this._growDispField(x0, y0, x1, y1);

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
    // v124 (user：「预览的时候没有 apply 选区」) selection mask —— S8 起 doc-space（charter H7）。
    const mask = st.mask;
    const maskData = mask ? mask.data : null;   // 有选区与否的开关（下方分支沿用旧名）
    const bleed = st.bleed;
    // 整数 cell (ix,iy) 是否在选区内（alpha>=128）。doc 坐标判定：平面内读平面（热路径），
    //   平面外直查选区 tile（sampleAt 自带出 doc = 0）——不再有「layer.bbox 外一律 false」的半拉。
    const cellIn = (ix: number, iy: number) => {
      const m = mask!;
      const mx = ix - m.x, my = iy - m.y;
      if (mx < 0 || my < 0 || mx >= m.w || my >= m.h) return st.selection!.sampleAt(ix, iy) >= 128;
      return m.data[my * m.w + mx] >= 128;
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
    layer.putImageData(x0, y0, dst);   // doc 坐标写回 tile

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

  // 液化 stroke 进行中？（input.isStrokeActive 等用它判活动笔画）
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

  // dispField（+ doc-space mask 平面）长到覆盖 [x0,y0,x1,y1)（= 当前 ∪ 该矩形；只扩不缩，
  //   调用方已夹到 doc）。tile era 取代 _syncDispFieldToLayer：位移场跟「笔触扫过的区域」走，
  //   不再 tie 现有内容 bbox（否则推出旧内容边的像素被截，见 extendStroke 注释）。
  _growDispField(x0: number, y0: number, x1: number, y1: number) {
    const st = this._stroke!;
    const f = st.dispField;
    const nx = Math.min(f.bboxX, x0), ny = Math.min(f.bboxY, y0);
    const ex = Math.max(f.bboxX + f.bboxW, x1), ey = Math.max(f.bboxY + f.bboxH, y1);
    const nw = ex - nx, nh = ey - ny;
    if (nx === f.bboxX && ny === f.bboxY && nw === f.bboxW && nh === f.bboxH) return;
    const newData = new Float32Array(2 * nw * nh);
    // 旧 dispField bbox ⊆ 新（只扩不缩），整行 set 拷保留已累积位移
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
    // mask 平面同步长到同一 bbox（重烤 = 一次 tile 读，O(新面积)，与拷旧+补边同阶但零缝隙 bug 面）。
    if (st.selection) {
      st.mask = { x: nx, y: ny, w: nw, h: nh, data: st.selection.materializeMaskRegion(nx, ny, nw, nh) };
    }
  }
}

// bilinear 取样 sdat[sx, sy] → ddat[dstIdx..+3]（straight RGBA）。sx/sy 浮点。
// **预乘空间累加 + 越界 tap 记 0（不 clamp）**——逐位对齐 GL warp 采样器（gl-compositor WARP_FUNCS）：
//   · 越界不 clamp → 不会把内容紧边界的不透明像素复制成"拉丝"（修：画个圆往下推、圆顶端被拉出一条）。
//   · 预乘混合 → 透明 tap 不把直值色拖暗（这才是 v135「防黑边」的正解；当年 clamp 是权宜——避了黑、却换来拉丝）。
//   仍是双线性(同权重核)，锐度与旧版**逐位一致、不变糊**；整数坐标(fx=fy=0)退化成点采样 → v147 选区整数 march 不受影响。
// export 供 test/liquify-bilinear.test.mjs 直接喂数组验（dom-shim canvas no-op，整段引擎跑不了像素）。
export function bilinearSample(sdat: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, ddat: Uint8ClampedArray, dstIdx: number) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  let pr = 0, pg = 0, pb = 0, pa = 0;   // 预乘累加：pr/pg/pb = Σ wt·C·(A/255)，pa = Σ wt·A
  const acc = (px: number, py: number, wt: number) => {
    if (wt === 0 || px < 0 || px >= w || py < 0 || py >= h) return;   // 越界 tap = 0（不 clamp）
    const o = (py * w + px) * 4;
    const a = sdat[o + 3];
    const af = (a / 255) * wt;
    pr += sdat[o] * af; pg += sdat[o + 1] * af; pb += sdat[o + 2] * af; pa += a * wt;
  };
  acc(ix, iy, (1 - fx) * (1 - fy));
  acc(ix + 1, iy, fx * (1 - fy));
  acc(ix, iy + 1, (1 - fx) * fy);
  acc(ix + 1, iy + 1, fx * fy);
  if (pa < 1e-4) { ddat[dstIdx] = ddat[dstIdx + 1] = ddat[dstIdx + 2] = ddat[dstIdx + 3] = 0; return; }
  const afSum = pa / 255;   // Σ wt·(A/255)；反预乘 → 直值色（透明 tap 不拖暗）
  ddat[dstIdx] = pr / afSum;
  ddat[dstIdx + 1] = pg / afSum;
  ddat[dstIdx + 2] = pb / afSum;
  ddat[dstIdx + 3] = pa;
}
