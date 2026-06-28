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
//   pixelMode: 直接进 layer（不进 buffer）
//
// **frozen/tail 渲染**（平滑核 v249 = 时间常数指数追踪，详 docs/brush-procreate-smoothing.md）：
//   buffered（brush/erase，非 pixel）的平滑中心线由 stroke-smoother.js 给（out 点串 + 末点 tip）：
//     - frozen 段（已提交 out，因果终值）→ 烤进 stroke buffer，永不再画
//     - tail 段（最近一段 out → tip）→ 每帧清掉重画到 tail buffer；抬笔 finish() 收尾钉终点
//     - overlay = frozen ⊕ tail（wash:max / buildup:over），opacity 只在 composite 时乘一次
//   pixel 仍走 immediate 路径（直接进 layer，无法重画）。

import { StrokeSmoother } from "./stroke-smoother.ts";
import type { Layer } from "./doc.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import type { Stamp, StrokeShape } from "./gl/gl-stamp.ts";

// 2D context（cache canvas / layer ctx 都可能是 OffscreenCanvas 或 <canvas>）
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

interface RgbColor { r: number; g: number; b: number; }

// Build-Up colored stamp cache（按 baseSize 烤一次，drawImage 缩到目标 size）
interface StampCache {
  key: string;
  canvas: HTMLCanvasElement;
  baseSize: number;
  radius: number;
}

interface StampParams { size: number; stampAlpha: number; }

// frozen/tail 沿平滑中心线撒点的游标
interface Walk {
  ci: number;
  started: boolean;
  accumDist: number;
  lastP: number;
  strokeDist: number;
}

type Rect = [number, number, number, number];

// 进行中描边的全部可变态（begin 建、extend/end 改、end 清）
interface StrokeState {
  layer: Layer;
  settings: ResolvedBrush;
  mode: string;
  buffered: boolean;
  lastX: number;
  lastY: number;
  lastP: number;
  pLPF: number;
  lastEventTime: number;
  accumDist: number;
  strokeDist: number;
  dirty: Rect | null;
  isBuildup: boolean;
  bufferCanvas: HTMLCanvasElement | null;
  bufferCtx: Ctx2D | null;
  bufferData: Uint8ClampedArray | null;
  bufBboxX: number;
  bufBboxY: number;
  bufBboxW: number;
  bufBboxH: number;
  overlayCanvas: HTMLCanvasElement | null;
  overlayCtx: Ctx2D | null;
  _composeAtSeq: number;
  _taperTotal: number | null;
  sm: StrokeSmoother | null;
  frozenWalk: Walk;
  tailCanvas: HTMLCanvasElement | null;
  tailCtx: Ctx2D | null;
  tailData: Uint8ClampedArray | null;
  tailCapW: number;
  tailCapH: number;
  tailX: number;
  tailY: number;
  tailW: number;
  tailH: number;
  prevTailX: number;
  prevTailY: number;
  prevTailW: number;
  prevTailH: number;
  frozenDirty: Rect | null;
}

// 引擎默认参数袋 = ResolvedBrush 的 base（resolved-brush.js import 之）。
// 当前笔（state.brush 旧单例）已收敛成不可变 ResolvedBrush（见 docs/CONTEXT [[当前笔]]）；
// 这张表是「无 preset / 无笔架」时也能画的兜底默认（user mental model：console 设工具即可绘画）。
export const DEFAULT_SETTINGS = {
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
  pressureLPF: 50,
  // shape：
  hardness: 0.75,
  shapeKind: "round",
  shapeAspect: 1.0,
  shapeRotation: 0,
  // spacing：
  spacing: 0.12,
  // buffer 合成模式：
  compositeMode: "wash",  // "wash" = Alpha Darken (JS max), "buildup" = source-over (Canvas2D native)
  // 笔刷混合模式：整条 stroke 落到 layer 时的 globalCompositeOperation（multiply/screen/...）。
  //   compositeMode 管 stroke 自身内部重叠；blendMode 管整条 stroke vs 下方 layer 像素。
  blendMode: "source-over",
  // pixel mode：
  pixelMode: false,
  // 位置平滑（时间常数指数追踪，详 docs/brush-procreate-smoothing.md）：
  streamline: 0.15,         // → 时间常数 tau：滞后恒 tau 时长（跟笔/可控/顿涌现）。0.5=满劲 → 默认 0.15=轻
  stabilization: 0,         // 死区拉绳：硬空间阈值去抖（与 tau 频域去抖正交）
  // taper：笔触两端渐细，**纯 stylistic·per-preset**（brushes.js makeBrush 的 taperIn/out → preset.taper）。默认 0=无。
  //   曾有「系统级 anti-spike 硬件 taper 1.5」的设定，但预设永远覆盖它 → 形同虚设且误导，已删（user 2026-06-08）。
  taperIn: 0,
  taperOut: 0,        // 末端渐细长度（× 笔径）。0=无。endStroke 时按到末端距离施加（需总笔长）
  taperFloor: 0.4,    // taper 包络最小压感系数（in/out 两端共用）
  // legacy 字段（applyBrushPresetFrozen 老路径可能 reference，no-op）：
  pressureToSize: true,
  pressureToOpacity: true,
};

export class BrushSettings {
  [k: string]: unknown;
  constructor(overrides?: Record<string, unknown> | null) { Object.assign(this, DEFAULT_SETTINGS, overrides || {}); }
  clone(over?: Record<string, unknown>) { return new BrushSettings({ ...this, ...over }); }
}

// signed_lerp：coeff ∈ [−1, 1]，p ∈ [0, 1]，返回 ∈ [amp, 1] where amp = 1 − |coeff|。
//   coeff ≥ 0：amp + (1 − amp) × p  →  p=0 → amp，p=1 → 1
//   coeff < 0：1 + (amp − 1) × p    →  p=0 → 1，  p=1 → amp
//   coeff = 0：永远 1（不响应压感）
function signedLerp(coeff: number, p: number) {
  const amp = 1 - Math.abs(coeff);
  return coeff >= 0 ? amp + (1 - amp) * p
                    : 1 + (amp - 1) * p;
}

export class BrushEngine {
  _stampCache: StampCache | null;
  _stroke: StrokeState | null;
  constructor() {
    this._stampCache = null;       // {key, canvas, baseSize, radius} —— Build-Up colored stamp cache
    this._stroke = null;
  }

  // 预渲染 colored stamp（Build-Up native path 用，drawImage 当 texture）。
  // PERF：cache key 不含 size —— stamp 按 baseSize 烤一次，每颗 drawImage 缩到目标 size。
  // v107: 撤 createRadialGradient（linear interp，dα/dr 在 boundary 非 0 → C0 不连续），
  // 改 putImageData 用 JS per-pixel 真值 smoothstep 烤。bake 一次的开销换 stamp 完全无 banding。
  _getStamp(size: number, hardness: number, color: string, mode: string): StampCache {
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
    const sctx = stamp.getContext("2d")!;
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

  setColor(color: string) {
    // 注：当前笔已是不可变 ResolvedBrush（settings 被 freeze）；描边中改色不是现行路径
    //   （全仓无调用，颜色随 ResolvedBrush 整体替换）。留此守卫=防 frozen 写崩，非功能路径。
    if (this._stroke && !Object.isFrozen(this._stroke.settings)) {
      // settings 类型上是 Readonly（ResolvedBrush）；此守卫分支仅在未 frozen 时运行（非现行路径）。
      // cast 掉 readonly 以保留原运行时写入，不改行为。
      (this._stroke.settings as { color: string }).color = color;
      // 颜色变 → frozen + tail 都要重画：作废 overlay 强制全幅重建
      this._stroke.overlayCanvas = null;
      this._stroke._composeAtSeq = -1;
    }
    this.invalidateStamp();
  }

  // step = size_eff × spacing；低压感 size 小 → step 小，不会出豆豆链
  _stepFor(s: ResolvedBrush, pressure: number) {
    const p = Math.max(0, Math.min(1, pressure));
    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1.0));
    const sizeMul = signedLerp(s.sizeCoeff || 0, pCurve);
    const effSize = s.size * sizeMul;
    return Math.max(0.5, effSize * s.spacing);
  }

  // smooth: { tau(ms), deadzone(doc px) }。t = 起手事件时间戳(ms)。详 docs/brush-procreate-smoothing.md。
  //   tau=0 & deadzone=0 → 不平滑（直通 raw）。
  beginStroke(layer: Layer, settings: ResolvedBrush, x: number, y: number, pressure: number, mode: string = "brush", smooth: { tau?: number; deadzone?: number; tailBow?: number } = {}, t: number | null = null) {
    const isBuildup = (settings.compositeMode || "wash") === "buildup";
    // buffered = 走 frozen/tail 平滑（进 buffer）；pixel = immediate（直接进 layer）
    const buffered = !settings.pixelMode;
    const pLPF0 = pressure;
    this._stroke = {
      layer, settings, mode,
      buffered,
      lastX: x, lastY: y, lastP: pLPF0,
      pLPF: pLPF0,                              // 当前 LPF 态
      lastEventTime: performance.now(),
      accumDist: 0,
      strokeDist: 0,
      dirty: null,
      isBuildup,
      // frozen stroke buffer（已冻结那段）：Build-Up=bufferCanvas / Wash=bufferData
      bufferCanvas: null, bufferCtx: null,
      bufferData: null,
      bufBboxX: layer.bboxX, bufBboxY: layer.bboxY, bufBboxW: 0, bufBboxH: 0,
      overlayCanvas: null,                     // 合成显示 (frozen ⊕ tail) RGBA
      overlayCtx: null,
      _composeAtSeq: -1,                        // 上次 compose 时的 sm.seq（同帧缓存用）
      _taperTotal: null,                        // endStroke 时填总笔长，给出端 taper 用（live 为 null=不 taper）
      // --- v243 Procreate EMA + 死区 + 贴笔尖（详 docs/brush-procreate-smoothing.md）---
      sm: buffered ? new StrokeSmoother(smooth) : null,
      // frozen 撒点游标（沿平滑中心线 C 的连续走样）
      frozenWalk: { ci: 0, started: false, accumDist: 0, lastP: pLPF0, strokeDist: 0 },
      // tail buffer（预分配 grow-only，覆盖 tail bbox 子区）
      tailCanvas: null, tailCtx: null,         // buildup
      tailData: null,                          // wash (Uint8)
      tailCapW: 0, tailCapH: 0,                // tail buffer 容量
      tailX: 0, tailY: 0, tailW: 0, tailH: 0,  // 本帧 tail 内容 bbox
      prevTailX: 0, prevTailY: 0, prevTailW: 0, prevTailH: 0,   // 上帧 tail bbox（overlay 还原用）
      frozenDirty: null,                       // 自上次 compose 起冻结新烤的区域（overlay 刷新用）
    };
    if (buffered) {
      this._stroke.sm!.push(x, y, pressure, t);   // 第一颗由 tail / endStroke 渲染，begin 不烤
    } else {
      this._stampOne(x, y, pressure);
    }
  }

  _ensureBufferBbox(x0: number, y0: number, x1: number, y1: number) {
    const st = this._stroke!;
    const m = 32;
    let nx: number, ny: number, nx1: number, ny1: number;
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
      const newCtx = newCanvas.getContext("2d")!;
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

  // 压感时间域 LPF（v102）：一阶 IIR，α = dt/(dt+τ)；τ=0 → 直传 raw
  _pressureLPF(pressure: number) {
    const st = this._stroke!;
    const tau = st.settings.pressureLPF || 0;
    const now = performance.now();
    const dt = Math.max(1, now - st.lastEventTime);
    st.lastEventTime = now;
    if (tau > 0) { st.pLPF += (dt / (dt + tau)) * (pressure - st.pLPF); }
    else { st.pLPF = pressure; }
    return st.pLPF;
  }

  extendStroke(x: number, y: number, pressure: number, t: number | null = null) {
    const st = this._stroke;
    if (!st) return;
    // NaN/inf 护栏：甩太快 / 坏事件可能传入非有限坐标 → 跳过
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const pEff = this._pressureLPF(pressure);
    if (st.buffered) this._extendBuffered(x, y, pEff, t);
    else this._extendImmediate(x, y, pEff);
  }

  // pixel：raw 点直接沿段等距撒进 layer（无 frozen/tail，无法重画）
  _extendImmediate(x: number, y: number, pEff: number) {
    const st = this._stroke!;
    const dx = x - st.lastX, dy = y - st.lastY;
    const L = Math.hypot(dx, dy);
    if (L === 0) return;
    let pos = 0;
    while (true) {
      const step = this._stepFor(st.settings, pEff);
      if (st.accumDist + (L - pos) < step) break;
      const need = step - st.accumDist;
      pos += need;
      st.strokeDist += step;
      const t = pos / L;
      const sx = st.lastX + dx * t, sy = st.lastY + dy * t;
      const sp = st.lastP + (pEff - st.lastP) * t;
      const r = (st.settings.size || 4) / 2;
      if (sx >= -r && sx <= st.layer.docW + r && sy >= -r && sy <= st.layer.docH + r) {
        this._stampOne(sx, sy, sp);
      }
      st.accumDist = 0;
    }
    st.accumDist += L - pos;
    st.lastX = x; st.lastY = y; st.lastP = pEff;
  }

  // brush / erase：raw 进 smoother，把新冻结的中心线段烤进 frozen buffer。
  // tail 不在这里画（每帧 getLiveOverlay 时画）。
  _extendBuffered(x: number, y: number, pEff: number, t: number | null = null) {
    const st = this._stroke!;
    st.sm!.push(x, y, pEff, t);
    st.sm!.update();
    const fi = st.sm!.frozenIndex();
    if (fi >= 0) this._walkStamps(st.frozenWalk, fi, (sx, sy, p, sd) => this._emitFrozen(sx, sy, p, sd));
  }

  // 沿平滑中心线 C 从 walk 游标走到 endIdx 顶点，等距撒点，每颗调 emit(x,y,p,strokeDist)。
  // 起点补一颗（continuous walk 否则缺起点）。修改 walk 游标（frozen 用真游标 / tail 用拷贝）。
  _walkStamps(walk: Walk, endIdx: number, emit: (x: number, y: number, p: number, strokeDist: number) => void) {
    const st = this._stroke!;
    const sm = st.sm!;
    if (!walk.started && sm.count > 0) {
      walk.started = true;
      emit(sm.cx[0], sm.cy[0], sm.cp[0], walk.strokeDist);
    }
    while (walk.ci < endIdx) {
      const i = walk.ci;
      const x0 = sm.cx[i], y0 = sm.cy[i], p0 = sm.cp[i];
      const x1 = sm.cx[i + 1], y1 = sm.cy[i + 1], p1 = sm.cp[i + 1];
      const dx = x1 - x0, dy = y1 - y0;
      const L = Math.hypot(dx, dy);
      if (L > 0) {
        let pos = 0;
        while (true) {
          const curP = p0 + (p1 - p0) * (pos / L);
          const step = this._stepFor(st.settings, curP);
          if (walk.accumDist + (L - pos) < step) break;
          pos += step - walk.accumDist;
          walk.strokeDist += step;
          const t = pos / L;
          emit(x0 + dx * t, y0 + dy * t, p0 + (p1 - p0) * t, walk.strokeDist);
          walk.accumDist = 0;
        }
        walk.accumDist += L - pos;
      }
      walk.lastP = p1;
      walk.ci = i + 1;
    }
  }

  // 一颗 → frozen buffer（带 culling + ensureBbox + frozenDirty 累积）
  _emitFrozen(x: number, y: number, p: number, strokeDist: number) {
    const st = this._stroke!;
    const params = this._stampParams(p, strokeDist);
    if (!params) return;
    const { size, stampAlpha } = params;
    const radius = size / 2;
    const x0 = x - radius - 1, y0 = y - radius - 1, x1 = x + radius + 1, y1 = y + radius + 1;
    if (x1 < 0 || y1 < 0 || x0 > st.layer.docW || y0 > st.layer.docH) return;   // culling
    this._ensureBufferBbox(x0, y0, x1, y1);
    if (st.isBuildup) this._buildupOverInto(st.bufferCtx!, st.bufBboxX, st.bufBboxY, x, y, size, stampAlpha);
    else this._washMaxInto(st.bufferData!, st.bufBboxW, st.bufBboxH, st.bufBboxX, st.bufBboxY, x, y, size, stampAlpha);
    this._growRect(st, "frozenDirty", x0, y0, x1, y1);
    this._markDirty(x0, y0, x1, y1);
  }

  // rasterizeStroke 给定（GL 模式，board 注入）→ commit 走 **GPU 栅格 stamp 列表 → readback canvas → editRegion**
  //   （buildup 走解析、与 live 一致）；否则 CPU buffer 路径（不变）。smoother finish + taper 计算两路都做。
  endStroke(rasterizeStroke?: (stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number) => { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null) {
    const st = this._stroke;
    const gpu = !!rasterizeStroke && !!st && st.buffered && !st.settings.pixelMode;
    if (st && st.buffered) {
      st.sm!.update();
      st.sm!.finish();                    // 抬笔收尾：把直线桥换成带动量的弧尾、钉终点（画到头）
      const last = st.sm!.count - 1;
      if (last >= 0) {
        // 出端 taper 需总笔长 → 先用 frozenWalk 拷贝干走一遍量 total（不烤），再设 _taperTotal 真烤。
        if (st.settings.taperOut > 0) {
          const dry = { ci: st.frozenWalk.ci, started: st.frozenWalk.started, accumDist: st.frozenWalk.accumDist, lastP: st.frozenWalk.lastP, strokeDist: st.frozenWalk.strokeDist };
          this._walkStamps(dry, last, () => {});
          st._taperTotal = dry.strokeDist;
        }
        // tail 全部转正（endIdx=last）。GPU 模式跳过 CPU 栅格（collectStamps 重走，buffer 不用）。
        if (!gpu) this._walkStamps(st.frozenWalk, last, (sx, sy, p, sd) => this._emitFrozen(sx, sy, p, sd));
      }
    }
    if (gpu) {
      const cs = this.collectStamps();   // 含 final tail + taper（_taperTotal 已设）
      if (cs && cs.stamps.length) {
        const r = rasterizeStroke!(cs.stamps, cs.shape, cs.bx, cs.by, cs.bw, cs.bh);
        if (r) this._commitStrokeCanvas(r.canvas, r.dstX, r.dstY, r.canvas.width, r.canvas.height);
      }
    } else if (st && (st.bufferCanvas || st.bufferData)) {
      this._compositeBufferToLayer();
    }
    this._stroke = null;
  }

  cancelStroke() { this._stroke = null; }

  _compositeBufferToLayer() {
    const st = this._stroke!;
    const composeCanvas = st.isBuildup ? st.bufferCanvas : this._renderWashToCanvas();
    if (!composeCanvas) return;
    this._commitStrokeCanvas(composeCanvas, st.bufBboxX, st.bufBboxY, st.bufBboxW, st.bufBboxH);
  }

  // 把一张 stroke 像素 canvas（straight RGBA，doc (bx,by) 起 bw×bh）commit 进 layer——CPU buffer 路径与
  //   GPU readback 路径共用。editRegion 物化该区现有像素 → Π-outer opacity × blendMode/erase/lockAlpha
  //   drawImage → 切片回 tile（source-atop/destination-out 对已有像素合成正确）。layer 存储是 bbox 裁剪过的，
  //   editRegion 负责把 bbox 扩到覆盖整条 stroke（否则超旧 bbox 像素 pen-up 才丢）。
  _commitStrokeCanvas(composeCanvas: AnyCanvas, bx: number, by: number, bw: number, bh: number) {
    if (bw <= 0 || bh <= 0) return;
    const st = this._stroke!;
    const layer = st.layer;
    layer.editRegion(bx, by, bw, bh, (ctx, ox, oy) => {
      ctx.globalAlpha = Math.max(0, Math.min(1, st.settings.opacity ?? 1.0));   // Π 外 × opacity
      // v242 锁定不透明度：source-atop = 只在已有 alpha 上画、保留目标 alpha。覆盖 per-brush blendMode。橡皮不锁。
      ctx.globalCompositeOperation = (st.mode === "erase"
        ? "destination-out"
        : (layer.lockAlpha ? "source-atop" : (st.settings.blendMode || "source-over"))) as GlobalCompositeOperation;
      ctx.drawImage(composeCanvas, bx - ox, by - oy);
    });
  }

  // Wash：把 Uint8 buffer 转 RGBA canvas（color × α）。用于 endStroke 合成 + live overlay。
  _renderWashToCanvas(targetCanvas: HTMLCanvasElement | null = null) {
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
    const cctx = canvas.getContext("2d")!;
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
  // opacity 是 user.opacity（Π 外那一层）；board 渲染时会 globalAlpha *= opacity。
  // buffered：每帧重画 tail + 合成 overlay = frozen ⊕ tail（只补 tail/frozenDirty 区域）。
  // immediate（pixel）：无 buffer，返回 null。
  getLiveOverlay() {
    const st = this._stroke;
    if (!st || !st.buffered) return null;
    // board 一帧会调多次（partial/full 判定 + _renderLayers）。tail 只随每个 raw push 变（笔尖移动）→
    // 用 sm.seq（每 push +1）当缓存键：同 seq + overlay 在 → 直接返回缓存，不重算 tail/compose。
    // （不能用 sm.count：慢速 raw 不落新锚点时 count 不变，但笔尖动了、tail 仍需重画。）
    if (st.sm!.seq !== st._composeAtSeq || !st.overlayCanvas) {
      this._renderTail();
      this._composeOverlay();
      st._composeAtSeq = st.sm!.seq;
    }
    if (!st.overlayCanvas) return null;
    return {
      canvas: st.overlayCanvas,
      bboxX: st.bufBboxX, bboxY: st.bufBboxY,
      bboxW: st.bufBboxW, bboxH: st.bufBboxH,
      layer: st.layer,
      opacity: Math.max(0, Math.min(1, st.settings.opacity ?? 1.0)),
      mode: st.mode,
      blendMode: st.settings.blendMode || "source-over",   // v163 board 用它合成 overlay
    };
  }

  // Stage 3：收集当前 stroke 全部 stamp（frozen 0..count-1，含 tail）为列表 + stroke 笔形 —— 给 GPU 栅格器
  //   (GLStampRasterizer，board 消费)。**复用 _walkStamps(手感间距) + _stampParams(压感/taper)**，与 CPU
  //   _emitFrozen 同源 → 手感逐位一致；纯读（传 fresh walk，不碰 live cursor/buffer）。endStroke 后 _taperTotal
  //   有值则自动含出端 taper。pixelMode/未描边 → null（caller 回退）。color 给 0..1；erase 由 caller 用 mode 处理。
  collectStamps(): { stamps: Stamp[]; shape: StrokeShape; layer: Layer; mode: string; opacity: number; blendMode: string; bx: number; by: number; bw: number; bh: number } | null {
    const st = this._stroke;
    if (!st || !st.buffered || !st.sm || st.settings.pixelMode) return null;
    const out: Stamp[] = [];
    const walk: Walk = { ci: 0, started: false, accumDist: 0, lastP: 0, strokeDist: 0 };
    this._walkStamps(walk, st.sm.count - 1, (x, y, p, sd) => {
      const params = this._stampParams(p, sd);
      if (params) out.push({ x, y, size: params.size, alpha: params.stampAlpha });
    });
    // stamp 包围盒（doc 坐标，+1px falloff 余量，clamp 到 doc）——live overlay + commit 共用。
    const docW = st.layer.docW, docH = st.layer.docH;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s2 of out) { const r = s2.size / 2 + 1; if (s2.x - r < x0) x0 = s2.x - r; if (s2.y - r < y0) y0 = s2.y - r; if (s2.x + r > x1) x1 = s2.x + r; if (s2.y + r > y1) y1 = s2.y + r; }
    const bx = out.length ? Math.max(0, Math.floor(x0)) : 0;
    const by = out.length ? Math.max(0, Math.floor(y0)) : 0;
    const bw = out.length ? Math.min(docW, Math.ceil(x1)) - bx : 0;
    const bh = out.length ? Math.min(docH, Math.ceil(y1)) - by : 0;
    const s = st.settings;
    const useEllipse = s.shapeKind === "ellipse" && (s.shapeAspect !== 1 || s.shapeRotation !== 0);
    const col = hexToRgbObj(s.color);
    return {
      stamps: out, bx, by, bw, bh,
      shape: {
        hardness: s.hardness, color: [col.r / 255, col.g / 255, col.b / 255], buildup: st.isBuildup,
        aspect: useEllipse ? s.shapeAspect : 1, rotation: useEllipse ? s.shapeRotation : 0,
      },
      layer: st.layer,
      mode: st.mode,
      opacity: Math.max(0, Math.min(1, s.opacity ?? 1.0)),   // Π-outer（commit/overlay 时一次性乘）
      blendMode: s.blendMode || "source-over",
    };
  }

  // 每帧重画 tail（frozen 前沿 → 笔尖）。两趟：先收集 stamp 算 bbox，再 ensure buffer + 光栅化。
  _renderTail() {
    const st = this._stroke!;
    const sm = st.sm!;
    sm.update();                                // 确保 C 最新（begin 后首帧也对）
    const last = sm.count - 1;
    if (last < 0) { st.tailW = 0; st.tailH = 0; return; }
    // tail walk = frozenWalk 的临时拷贝（不动真游标）
    const walk = {
      ci: st.frozenWalk.ci, started: st.frozenWalk.started,
      accumDist: st.frozenWalk.accumDist, lastP: st.frozenWalk.lastP,
      strokeDist: st.frozenWalk.strokeDist,
    };
    // 1) 收集 tail stamp（culling doc 外）
    const stamps: { x: number; y: number; size: number; stampAlpha: number }[] = [];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    this._walkStamps(walk, last, (x, y, p, sd) => {
      const params = this._stampParams(p, sd);
      if (!params) return;
      const { size, stampAlpha } = params;
      const r = size / 2;
      const sx0 = x - r - 1, sy0 = y - r - 1, sx1 = x + r + 1, sy1 = y + r + 1;
      if (sx1 < 0 || sy1 < 0 || sx0 > st.layer.docW || sy0 > st.layer.docH) return;
      stamps.push({ x, y, size, stampAlpha });
      if (sx0 < bx0) bx0 = sx0; if (sy0 < by0) by0 = sy0;
      if (sx1 > bx1) bx1 = sx1; if (sy1 > by1) by1 = sy1;
    });
    if (!stamps.length) { st.tailW = 0; st.tailH = 0; return; }
    // doc 坐标 tail bbox（整数化 + clamp 到 doc，和 frozen buffer 的 clamp 一致 → overlay 不越界）
    const tx = Math.max(0, Math.floor(bx0));
    const ty = Math.max(0, Math.floor(by0));
    const tx1 = Math.min(st.layer.docW, Math.ceil(bx1));
    const ty1 = Math.min(st.layer.docH, Math.ceil(by1));
    const tw = tx1 - tx, th = ty1 - ty;
    if (tw <= 0 || th <= 0) { st.tailW = 0; st.tailH = 0; return; }
    st.tailX = tx; st.tailY = ty; st.tailW = tw; st.tailH = th;
    // overlay 必须覆盖 tail → 把 frozen bbox 预扩到含 tail（frozen buffer 那块为 0，无害）
    this._ensureBufferBbox(tx, ty, tx + tw, ty + th);
    // 2) ensure tail buffer + 清 + 光栅
    this._ensureTailBbox(tw, th);
    if (st.isBuildup) {
      st.tailCtx!.clearRect(0, 0, tw, th);
      for (const s of stamps) this._buildupOverInto(st.tailCtx!, tx, ty, s.x, s.y, s.size, s.stampAlpha);
    } else {
      st.tailData!.fill(0, 0, tw * th);
      for (const s of stamps) this._washMaxInto(st.tailData!, tw, th, tx, ty, s.x, s.y, s.size, s.stampAlpha);
    }
    this._markDirty(tx, ty, tx + tw, ty + th);
  }

  // tail buffer：预分配 grow-only，复用（不每帧 malloc）。容量 ≥ 当前 tail bbox。
  _ensureTailBbox(tw: number, th: number) {
    const st = this._stroke!;
    if (tw <= st.tailCapW && th <= st.tailCapH && (st.isBuildup ? st.tailCanvas : st.tailData)) return;
    const cw = Math.max(tw, st.tailCapW, 64);
    const ch = Math.max(th, st.tailCapH, 64);
    st.tailCapW = cw; st.tailCapH = ch;
    if (st.isBuildup) {
      st.tailCanvas = document.createElement("canvas");
      st.tailCanvas.width = cw; st.tailCanvas.height = ch;
      st.tailCtx = st.tailCanvas.getContext("2d")!;
    } else {
      st.tailData = new Uint8ClampedArray(cw * ch);
    }
  }

  // 合成 overlay = frozen ⊕ tail（wash:max / buildup:over）。只补 (prevTail ∪ frozenDirty) 与 tail 区。
  _composeOverlay() {
    const st = this._stroke!;
    const W = st.bufBboxW, H = st.bufBboxH;
    if (W <= 0 || H <= 0) return;
    let rebuilt = false;
    if (!st.overlayCanvas) {
      st.overlayCanvas = document.createElement("canvas");
      st.overlayCanvas.width = W; st.overlayCanvas.height = H;
      st.overlayCtx = st.overlayCanvas.getContext("2d")!;
      rebuilt = true;
    } else if (st.overlayCanvas.width !== W || st.overlayCanvas.height !== H) {
      st.overlayCanvas.width = W; st.overlayCanvas.height = H;
      rebuilt = true;
    }
    if (rebuilt) {
      this._blitFrozen(0, 0, W, H);                 // 全幅刷 frozen
      st.prevTailW = 0; st.frozenDirty = null;
    } else {
      // 还原 (上帧 tail ∪ 新冻结) 区域为纯 frozen
      let r: number[] | null = null;
      if (st.prevTailW > 0) r = [st.prevTailX, st.prevTailY, st.prevTailX + st.prevTailW, st.prevTailY + st.prevTailH];
      if (st.frozenDirty) {
        const d = st.frozenDirty;
        r = r ? [Math.min(r[0], d[0]), Math.min(r[1], d[1]), Math.max(r[2], d[2]), Math.max(r[3], d[3])] : d.slice();
      }
      if (r) {
        // doc → overlay 局部，clip 到 bufBbox
        const lx0 = Math.max(0, Math.floor(r[0] - st.bufBboxX));
        const ly0 = Math.max(0, Math.floor(r[1] - st.bufBboxY));
        const lx1 = Math.min(W, Math.ceil(r[2] - st.bufBboxX));
        const ly1 = Math.min(H, Math.ceil(r[3] - st.bufBboxY));
        if (lx1 > lx0 && ly1 > ly0) this._blitFrozen(lx0, ly0, lx1 - lx0, ly1 - ly0);
      }
      st.frozenDirty = null;
    }
    // tail 叠上去（已 ensure bufBbox ⊇ tail）
    if (st.tailW > 0) {
      const lx = st.tailX - st.bufBboxX, ly = st.tailY - st.bufBboxY;
      this._blitTail(lx, ly);
    }
    st.prevTailX = st.tailX; st.prevTailY = st.tailY;
    st.prevTailW = st.tailW; st.prevTailH = st.tailH;
  }

  // 把 frozen buffer 的 (lx,ly,lw,lh)（overlay 局部坐标）刷进 overlay（替换，frozen 权威）
  _blitFrozen(lx: number, ly: number, lw: number, lh: number) {
    const st = this._stroke!;
    const octx = st.overlayCtx!;
    if (st.isBuildup) {
      octx.clearRect(lx, ly, lw, lh);
      if (st.bufferCanvas) octx.drawImage(st.bufferCanvas, lx, ly, lw, lh, lx, ly, lw, lh);
    } else {
      const buf = st.bufferData!;
      const bufW = st.bufBboxW;
      const col = st.mode === "erase" ? { r: 0, g: 0, b: 0 } : hexToRgbObj(st.settings.color);
      const img = octx.createImageData(lw, lh);
      const d = img.data;
      for (let y = 0; y < lh; y++) {
        const srcOff = (ly + y) * bufW + lx;
        let o = y * lw * 4;
        for (let x = 0; x < lw; x++) {
          d[o] = col.r; d[o + 1] = col.g; d[o + 2] = col.b; d[o + 3] = buf[srcOff + x];
          o += 4;
        }
      }
      octx.putImageData(img, lx, ly);
    }
  }

  // 把 tail 叠到 overlay 的 (lx,ly)（overlay 局部坐标）。wash=max(frozen,tail)；buildup=tail over frozen。
  _blitTail(lx: number, ly: number) {
    const st = this._stroke!;
    const octx = st.overlayCtx!;
    const tw = st.tailW, th = st.tailH;
    if (st.isBuildup) {
      octx.drawImage(st.tailCanvas!, 0, 0, tw, th, lx, ly, tw, th);   // source-over
    } else {
      const frozen = st.bufferData!, bufW = st.bufBboxW;
      const tail = st.tailData!;
      const col = st.mode === "erase" ? { r: 0, g: 0, b: 0 } : hexToRgbObj(st.settings.color);
      const img = octx.createImageData(tw, th);
      const d = img.data;
      for (let y = 0; y < th; y++) {
        const fOff = (ly + y) * bufW + lx;
        const tOff = y * tw;
        let o = y * tw * 4;
        for (let x = 0; x < tw; x++) {
          const a = Math.max(frozen[fOff + x], tail[tOff + x]);   // Alpha Darken = max
          d[o] = col.r; d[o + 1] = col.g; d[o + 2] = col.b; d[o + 3] = a;
          o += 4;
        }
      }
      octx.putImageData(img, lx, ly);
    }
  }

  flushDirty() {
    const st = this._stroke;
    if (!st || !st.dirty) return null;
    const d = st.dirty;
    st.dirty = null;
    return d;
  }

  // pressure → {size, stampAlpha}（taper / signedLerp dynamics）。null = 太淡跳过。
  // strokeDist 决定 anti-spike taper 包络（frozen / tail walk 各传自己的）。
  _stampParams(pressure: number, strokeDist: number): StampParams | null {
    const st = this._stroke!;
    const s = st.settings;
    // taperFloor 不在 ResolvedBrush 显式字段（来自 DEFAULT_SETTINGS 兜底），index 签名为 unknown → 断言 number。
    const taperFloor = s.taperFloor as number;
    let p = Math.max(0, Math.min(1, pressure));
    // 入端 taper：起手 fade-in（也兼顾 Apple Pencil 落笔 spike → 萝卜尖）
    if (s.taperIn > 0) {
      const t = Math.min(1, strokeDist / (s.size * s.taperIn));
      p *= taperFloor + (1 - taperFloor) * t;
    }
    // 出端 taper：末端 fade-out。需总笔长 → 只在 endStroke 时 st._taperTotal 有值（live 不 taper）
    if (s.taperOut > 0 && st._taperTotal != null) {
      const distFromEnd = st._taperTotal - strokeDist;
      const taperLen = s.size * s.taperOut;
      if (distFromEnd < taperLen) {
        const t = Math.max(0, distFromEnd / taperLen);
        p *= taperFloor + (1 - taperFloor) * t;
      }
    }
    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1.0));
    const size = Math.max(0.5, s.size * signedLerp(s.sizeCoeff || 0, pCurve));
    const effFlow = Math.max(0, Math.min(1, s.flow * signedLerp(s.flowCoeff || 0, pCurve)));
    const stampAlpha = effFlow * signedLerp(s.opaCoeff || 0, pCurve);
    if (stampAlpha < 0.001) return null;
    return { size, stampAlpha };
  }

  // immediate 路径（pixel）：算 params + 直接进 layer。
  _stampOne(x: number, y: number, pressure: number) {
    const st = this._stroke;
    if (!st) return;
    const s = st.settings;
    const params = this._stampParams(pressure, st.strokeDist);
    if (!params) return;
    const { size, stampAlpha } = params;
    const radius = size / 2;
    const x0 = x - radius - 1, y0 = y - radius - 1, x1 = x + radius + 1, y1 = y + radius + 1;
    st.layer.ensureBbox(x0, y0, x1, y1);
    if (s.pixelMode) {
      this._pixelStampDirect(x, y, size, stampAlpha);
    }
    this._markDirty(x0, y0, x1, y1);
  }

  // 累积一个 grow-only rect 到 st[field]（[x0,y0,x1,y1]）
  _growRect(st: StrokeState, field: "frozenDirty", x0: number, y0: number, x1: number, y1: number) {
    const d = st[field];
    if (d) {
      if (x0 < d[0]) d[0] = x0; if (y0 < d[1]) d[1] = y0;
      if (x1 > d[2]) d[2] = x1; if (y1 > d[3]) d[3] = y1;
    } else st[field] = [x0, y0, x1, y1];
  }

  // Build-Up: 把 cached colored stamp 以 source-over drawImage 进 ctx（bx/by = ctx 的 doc 原点偏移）
  _buildupOverInto(ctx: Ctx2D, bx: number, by: number, x: number, y: number, size: number, stampAlpha: number) {
    const s = this._stroke!.settings;
    const stamp = this._getStamp(s.size, s.hardness, s.color, this._stroke!.mode);
    const drawD = size + 2 * (size / stamp.baseSize);
    const drawR = drawD / 2;
    const lx = x - bx, ly = y - by;
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = stampAlpha;
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

  // Wash: JS per-pixel max blend 进 Uint8 buf（bufW×bufH，bx/by = doc 原点偏移）
  _washMaxInto(buf: Uint8ClampedArray, bufW: number, bufH: number, bx: number, by: number, x: number, y: number, size: number, stampAlpha: number) {
    const s = this._stroke!.settings;
    const cx = x - bx;
    const cy = y - by;
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

  _pixelStampDirect(x: number, y: number, size: number, stampAlpha: number) {
    const st = this._stroke!;
    const s = st.settings;
    const layer = st.layer;
    const intSize = Math.max(1, Math.round(size));
    // v104: 像素中心位置（doc 坐标）。pixel i 覆盖 [i, i+1)；floor(x - (intSize-1)/2)：intSize=1 时=floor(x) ✓。
    const ix = Math.floor(x - (intSize - 1) / 2);
    const iy = Math.floor(y - (intSize - 1) / 2);
    layer.editRegion(ix, iy, intSize, intSize, (ctx, ox, oy) => {
      ctx.globalAlpha = stampAlpha * Math.max(0, Math.min(1, s.opacity ?? 1.0));   // pixel 不走 buffer，opacity 这里乘
      // v242 锁定不透明度：非橡皮走 source-atop（只改已有像素颜色，不增删 alpha）
      ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : (layer.lockAlpha ? "source-atop" : "source-over");
      ctx.fillStyle = st.mode === "erase" ? "#000" : (s.color || "#000");
      ctx.imageSmoothingEnabled = false;
      ctx.fillRect(ix - ox, iy - oy, intSize, intSize);
    });
  }

  _markDirty(x0: number, y0: number, x1: number, y1: number) {
    const st = this._stroke!;
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

function hexToRgbObj(hex: string): RgbColor {
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
export function hexToRgba(hex: string, a: number = 1) {
  const c = hexToRgbObj(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
