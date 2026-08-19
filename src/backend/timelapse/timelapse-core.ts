// Timelapse 核心域：取景框几何 / 调和衰减采样 / 帧合成（纯数学，node 可测）。
// spec = ai-docs/20260819-timelapse-spec.md。翻案史勿回 docs/20260727 旧案（分段/预算/consolidation 全废）。
import { areaResampleBytes } from "../algorithms/resample-bytes.ts";

// ---- 取景框（开录 pin 死，中途不可改；改 = 清除重录） ----

/** 比例 chips（UI 顺序即此顺序；默认 1:1）。 */
export const TIMELAPSE_ASPECTS: ReadonlyArray<readonly [number, number]> =
  [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16]];

/** 最长边档位（默认 512）。 */
export const TIMELAPSE_LONG_EDGES: ReadonlyArray<number> = [64, 128, 256, 512, 720, 1080];

export interface TimelapseSettings {
  aspectW: number;      // 比例分子/分母（如 4:3 → 4,3）
  aspectH: number;
  longEdge: number;     // TIMELAPSE_LONG_EDGES 之一
}

export const TIMELAPSE_DEFAULT_SETTINGS: TimelapseSettings = { aspectW: 1, aspectH: 1, longEdge: 512 };

/** 取景框像素尺寸：最长边给比例的长轴，短边取偶（编码器只要求偶数）。 */
export function timelapseFrameDims(s: TimelapseSettings): { w: number; h: number } {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  if (s.aspectW >= s.aspectH) return { w: even(s.longEdge), h: even(s.longEdge * s.aspectH / s.aspectW) };
  return { w: even(s.longEdge * s.aspectW / s.aspectH), h: even(s.longEdge) };
}

/** fit-居中：画布等比放进取景框（允许放大——诚实，小画布就是要占满）。整数像素。 */
export function timelapseFitRect(cw: number, ch: number, fw: number, fh: number):
    { dx: number; dy: number; dw: number; dh: number } {
  const scale = Math.min(fw / cw, fh / ch);
  const dw = Math.max(1, Math.round(cw * scale));
  const dh = Math.max(1, Math.round(ch * scale));
  return { dx: (fw - dw) >> 1, dy: (fh - dh) >> 1, dw, dh };
}

// ---- 每档常数（⚠️ 发版前须用 dogfood 真录像实测校准，spec §4 硬前置；现值=H.264 经验估计） ----
// 数据/契约层一律裸字节数（单位双层制，UX 显示才走 KiB/MiB）。

interface TierConst {
  n0: number;           // 调和衰减常数：全速录 1 个参考 MiB 的 commit 数
  motionBps: number;    // 运动编码器 M 目标码率（10fps 虚拟节奏下的 bps）
  tailBps: number;      // 尾帧编码器 F 码率（1fps 单帧，全部码字给一张 IDR）
  refBytes: number;     // 选单参考体积（一位有效数字口径；「约」不是承诺）
}

const TIERS: Record<number, TierConst> = {
  64:   { n0: 5000, motionBps: 10_000,   tailBps: 60_000,    refBytes: 0.1 * 1048576 },
  128:  { n0: 2000, motionBps: 25_000,   tailBps: 150_000,   refBytes: 0.2 * 1048576 },
  256:  { n0: 700,  motionBps: 80_000,   tailBps: 400_000,   refBytes: 0.5 * 1048576 },
  512:  { n0: 330,  motionBps: 250_000,  tailBps: 1_000_000, refBytes: 2 * 1048576 },
  720:  { n0: 170,  motionBps: 500_000,  tailBps: 2_000_000, refBytes: 4 * 1048576 },
  1080: { n0: 90,   motionBps: 1_000_000, tailBps: 4_000_000, refBytes: 8 * 1048576 },
};

export function timelapseTier(longEdge: number): TierConst {
  const t = TIERS[longEdge];
  if (!t) throw new Error(`unknown timelapse long-edge tier: ${longEdge}`);
  return t;
}

// ---- 调和衰减采样（spec §2 核心公式；按 commit 数不按时间——time-is-ticking 焦虑，user 拍板） ----

export const TIMELAPSE_BASE_DEBOUNCE_MS = 2000;
/** 每 N 帧强制一张 IDR（seek 保底）。 */
export const TIMELAPSE_FORCED_KEY_INTERVAL = 300;
/** 回放虚拟节奏：每帧 100ms（10fps）。 */
export const TIMELAPSE_FRAME_US = 100_000;
/** 尾帧定格 5s（常数不做旋钮，user 2026-08-19）。 */
export const TIMELAPSE_TAIL_HOLD_US = 5_000_000;

/** debounce 窗口 = 2s × (1 + n/N₀)。体积走 log 曲线，无预算无 consolidation。 */
export function timelapseDebounceMs(n: number, longEdge: number): number {
  return TIMELAPSE_BASE_DEBOUNCE_MS * (1 + n / timelapseTier(longEdge).n0);
}

/**
 * 采样闸门（leading-edge：窗口开头的 commit 采，其余合并进下一帧；
 * 收尾状态永远由 F 尾帧兜底，不怕漏掉安静期前的最后一笔）。
 * n 计数所有见过的 commit（含被合并的）——衰减的自变量是干活量。
 */
export class TimelapseSampler {
  n: number;
  private lastCaptureAt: number | null = null;
  private readonly longEdge: number;
  constructor(longEdge: number, n = 0) { this.longEdge = longEdge; this.n = n; }
  /** 每次有可见变化的 commit 调一次；返回「这个 commit 要不要采帧」。 */
  noteCommit(nowMs: number): boolean {
    this.n++;
    if (this.lastCaptureAt !== null && nowMs - this.lastCaptureAt < timelapseDebounceMs(this.n, this.longEdge)) return false;
    this.lastCaptureAt = nowMs;
    return true;
  }
}

// ---- 帧合成：画布 RGBA → 取景框 RGBA（白底白边；不走 canvas——字节进出不走 canvas 家规） ----

/**
 * src = 画布合成图 straight-alpha RGBA。输出 = fw×fh 不透明帧（内容 over 白，白边填充）。
 * 缩放走 areaResampleBytes（面积平均，缩小专业对口；放大=块状，诚实）。
 */
export function composeTimelapseFrame(src: Uint8ClampedArray, cw: number, ch: number,
                                      fw: number, fh: number): Uint8ClampedArray {
  const { dx, dy, dw, dh } = timelapseFitRect(cw, ch, fw, fh);
  const scaled = (dw === cw && dh === ch) ? src : areaResampleBytes(src, cw, ch, dw, dh);
  const out = new Uint8ClampedArray(fw * fh * 4).fill(255);   // 全白不透明
  for (let y = 0; y < dh; y++) {
    let si = y * dw * 4;
    let di = ((dy + y) * fw + dx) * 4;
    for (let x = 0; x < dw; x++, si += 4, di += 4) {
      const a = scaled[si + 3] / 255;
      out[di] = scaled[si] * a + 255 * (1 - a);
      out[di + 1] = scaled[si + 1] * a + 255 * (1 - a);
      out[di + 2] = scaled[si + 2] * a + 255 * (1 - a);
      // out alpha 保持 255
    }
  }
  return out;
}
