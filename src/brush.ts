// 笔刷引擎 v98（Krita-aligned + 双 path）。详 docs/20260529-brush-architecture.md。
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
// **渲染路径（v351：GL board 唯一）**：
//   buffered（brush/erase，非 pixel）—— 手感数学留 CPU（smoother 中心线 + _walkStamps 间距 + _stampParams
//     压感/taper），但栅格化全走 GPU：live overlay 与 commit 都经 collectStamps（fresh walk 读 sm.C）→
//     board 的 GLStampRasterizer（falloff/buildup/wash 累积在 GPU）。CPU frozen/tail buffer + overlay 合成
//     已归档（→ ARCHIVE/old-brush-cpu-raster.ts；frozen/tail 双 buffer = #4 GPU 缓存 spec）。
//   pixelMode —— immediate（_extendImmediate/_stampOne/_pixelStampDirect 直接 editRegion 进 layer），仍 CPU。
//   平滑核 v249 = 时间常数指数追踪（详 docs/20260613-brush-procreate-smoothing.md）：smoother 给平滑中心线 C；
//     抬笔 finish() 收尾把直线桥换成动量弧尾、钉终点。

import { StrokeSmoother } from "./stroke-smoother.ts";
import type { Layer } from "./doc.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import type { Stamp, StrokeShape } from "./gl/gl-stamp.ts";

// commit canvas 可能是 OffscreenCanvas 或 <canvas>（GPU readback canvas / 像素 editRegion）
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

interface RgbColor { r: number; g: number; b: number; }

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
  // GL board 模式标志（v351 GL-only 后恒 true；GL init 失败的降级态为 false → 不提交，app 显「需 WebGL2」）。
  //   保留作显式语义门：buffered 描边 live+commit 全 GPU（collectStamps→GPU 栅格），CPU 栅格已归档。
  glMode: boolean;
  lastX: number;
  lastY: number;
  lastP: number;
  pLPF: number;
  lastEventTime: number;
  accumDist: number;
  strokeDist: number;
  dirty: Rect | null;
  isBuildup: boolean;
  _taperTotal: number | null;
  sm: StrokeSmoother | null;
  frozenWalk: Walk;   // endStroke 出端 taper 干走（GL 模式停在 ci=0，dry-walk 从 0 走全程算总笔长）
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
  // 位置平滑（时间常数指数追踪，详 docs/20260613-brush-procreate-smoothing.md）：
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
  _stroke: StrokeState | null;
  constructor() {
    this._stroke = null;
  }

  // step = size_eff × spacing；低压感 size 小 → step 小，不会出豆豆链
  _stepFor(s: ResolvedBrush, pressure: number) {
    const p = Math.max(0, Math.min(1, pressure));
    const pCurve = Math.pow(p, Math.max(0.01, s.pressureGamma || 1.0));
    const sizeMul = signedLerp(s.sizeCoeff || 0, pCurve);
    const effSize = s.size * sizeMul;
    return Math.max(0.5, effSize * s.spacing);
  }

  // smooth: { tau(ms), deadzone(doc px) }。t = 起手事件时间戳(ms)。详 docs/20260613-brush-procreate-smoothing.md。
  //   tau=0 & deadzone=0 → 不平滑（直通 raw）。
  beginStroke(layer: Layer, settings: ResolvedBrush, x: number, y: number, pressure: number, mode: string = "brush", smooth: { tau?: number; deadzone?: number; tailBow?: number } = {}, t: number | null = null, glMode: boolean = false) {
    const isBuildup = (settings.compositeMode || "wash") === "buildup";
    // buffered = 走 frozen/tail 平滑（进 buffer）；pixel = immediate（直接进 layer）
    const buffered = !settings.pixelMode;
    const pLPF0 = pressure;
    this._stroke = {
      layer, settings, mode,
      buffered,
      glMode,
      lastX: x, lastY: y, lastP: pLPF0,
      pLPF: pLPF0,                              // 当前 LPF 态
      lastEventTime: performance.now(),
      accumDist: 0,
      strokeDist: 0,
      dirty: null,
      isBuildup,
      _taperTotal: null,                        // endStroke 时填总笔长，给出端 taper 用（live 为 null=不 taper）
      // --- v243 Procreate EMA + 死区 + 贴笔尖（详 docs/20260613-brush-procreate-smoothing.md）---
      sm: buffered ? new StrokeSmoother(smooth) : null,
      // frozen 撒点游标：GL 模式 collectStamps 用 fresh walk，此游标只供 endStroke taper dry-walk 从 ci=0 走全程。
      frozenWalk: { ci: 0, started: false, accumDist: 0, lastP: pLPF0, strokeDist: 0 },
    };
    if (buffered) {
      this._stroke.sm!.push(x, y, pressure, t);   // 第一颗由 tail / endStroke 渲染，begin 不烤
    } else {
      this._stampOne(x, y, pressure);
    }
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
  // buffered（brush/erase）描边推进：raw 进 smoother + 更新中心线 C。GL board 唯一路径下 live overlay/commit
  //   都走 collectStamps（fresh walk 读 sm.C，不碰 frozenWalk）→ 这里不再烤 CPU frozen buffer（已归档）。
  _extendBuffered(x: number, y: number, pEff: number, t: number | null = null) {
    const st = this._stroke!;
    st.sm!.push(x, y, pEff, t);
    st.sm!.update();   // collectStamps 读 sm.C → 必须更新
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

  // 抬笔提交（GL board 路径）：smoother finish + 出端 taper 量算 → collectStamps（含 final tail + taper）
  //   → board 注入的 GPU 栅格器 rasterizeStroke → readback canvas → _commitStrokeCanvas/editRegion。
  //   CPU buffer commit 路径已归档（GL board 唯一）；GL init 失败的降级态无 rasterizeStroke → 不提交（app 已显「需 WebGL2」）。
  endStroke(rasterizeStroke?: (stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number) => { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null) {
    const st = this._stroke;
    const gpu = !!rasterizeStroke && !!st && st.buffered && !st.settings.pixelMode;
    if (st && st.buffered) {
      st.sm!.update();
      st.sm!.finish();                    // 抬笔收尾：把直线桥换成带动量的弧尾、钉终点（画到头）
      const last = st.sm!.count - 1;
      // 出端 taper 需总笔长 → frozenWalk 从 ci=0 干走一遍量 total（不烤），再设 _taperTotal 给 collectStamps。
      if (last >= 0 && st.settings.taperOut > 0) {
        const dry = { ci: st.frozenWalk.ci, started: st.frozenWalk.started, accumDist: st.frozenWalk.accumDist, lastP: st.frozenWalk.lastP, strokeDist: st.frozenWalk.strokeDist };
        this._walkStamps(dry, last, () => {});
        st._taperTotal = dry.strokeDist;
      }
    }
    if (gpu) {
      const cs = this.collectStamps();   // 含 final tail + taper（_taperTotal 已设）
      if (cs && cs.stamps.length) {
        const r = rasterizeStroke!(cs.stamps, cs.shape, cs.bx, cs.by, cs.bw, cs.bh);
        if (r) this._commitStrokeCanvas(r.canvas, r.dstX, r.dstY, r.canvas.width, r.canvas.height);
      }
    }
    this._stroke = null;
  }

  cancelStroke() { this._stroke = null; }

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
    // （tile era：写走 editRegion/putImageData 按需分配 tile，无需预扩容——旧 ensureBbox 调用已删）
    if (s.pixelMode) {
      this._pixelStampDirect(x, y, size, stampAlpha);
    }
    this._markDirty(x0, y0, x1, y1);
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
