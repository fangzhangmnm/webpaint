// 即时路径位置平滑（smudge / 像素笔）——Procreate 二参 per-event 版。
// 详 docs/brush-procreate-smoothing.md。
//
// 主笔刷（buffered brush/erase）走引擎侧 stroke-smoother.js（重采样 EMA + 贴笔尖 catch-up）。
// 这里只服务**即时笔**：它们直接写 layer、无法重画 tail，所以不做 lookahead/catch-up，
// 只做 ① stabilization 死区去抖 + ② streamline EMA 拉绳。motionFilter / pullStabilizer 已剃除。
//
// 纯函数（唯一外部依赖 = SMOOTH 配置）：**mutates rec 的平滑状态**（rawSX/Y, stabX/Y, smX/Y），
// 返回平滑后 screen 点 {x,y}。调用前 rec 须已锚（input._down 起手 rawS/stab/sm = raw 起点）。
// drx/dry = 本 event 的 raw screen 位移。
import { SMOOTH } from "./smooth-config.js";

export function inputSmooth(rec, settings, drx, dry) {
  const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
  const sl   = clamp01(settings?.streamline);
  const stab = clamp01(settings?.stabilization);

  // 累积 raw（screen px）
  rec.rawSX += drx;
  rec.rawSY += dry;

  // ① stabilization 死区：半径 r 内 raw 不拉动落点（杀手抖）
  const r = stab * SMOOTH.stabMaxPx;
  if (r > 0) {
    const dx = rec.rawSX - rec.stabX, dy = rec.rawSY - rec.stabY;
    const d = Math.hypot(dx, dy);
    if (d > r) { const k = (d - r) / d; rec.stabX += dx * k; rec.stabY += dy * k; }
  } else {
    rec.stabX = rec.rawSX; rec.stabY = rec.rawSY;
  }

  // ② streamline EMA 拉绳（per-event；即时笔非精度笔，帧率无关性让步给简单）
  const a = sl * 0.9;                 // slider → EMA 保留系数
  rec.smX += (rec.stabX - rec.smX) * (1 - a);
  rec.smY += (rec.stabY - rec.smY) * (1 - a);
  return { x: rec.smX, y: rec.smY };
}
