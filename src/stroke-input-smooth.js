// 四件套位置平滑（K3 live·切片2，从 input.js 抽出）。
// Procreate 链式：raw → Motion Filter(角速度) → Stabilization(滑动平均) → Pull-Stabilizer(速度上限) → StreamLine(IIR LPF)。
// v148: 只剩 smudge/pixel/liquify/filterBrush 走这条；buffered brush/erase 改引擎 lookahead（stroke-smoother.js）。
//
// 纯函数（唯一外部依赖 = SMOOTH.vref 配置）：**mutates rec 的平滑状态**
// （lastDirX/Y, filtX/Y, stabBuf, pullX/Y, smX/Y, _prevEvtTs），返回平滑后的 screen 点 {x,y}。
// 调用前 rec 须已锚（input._down 起手时 filtX/Y=raw、smX/Y=raw、stabBuf=[] 等）。
// drx/dry = 本 event 的 raw screen 位移。原是 input.js 的方法、无 this 依赖、零测——抽出可单测。
import { SMOOTH } from "./smooth-config.js";

export function fourStageSmooth(rec, ev, settings, drx, dry) {
  const sl = settings?.streamline ?? 0;
  const stab = settings?.stabilization ?? 0;
  const pull = settings?.pullStabilizer ?? 0;
  const mf = settings?.motionFilter ?? 0;

  // 1) Motion Filter：限制 (drx, dry) 相对 (lastDirX, lastDirY) 的角度。mf=1 → 硬锁方向。
  let fdx = drx, fdy = dry;
  if (mf > 0) {
    const nLen = Math.hypot(fdx, fdy);
    const oLen = Math.hypot(rec.lastDirX, rec.lastDirY);
    if (nLen > 0 && oLen > 0) {
      const dot = (fdx * rec.lastDirX + fdy * rec.lastDirY) / (nLen * oLen);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      const maxAng = (1 - mf) * Math.PI;
      if (ang > maxAng && maxAng > 0.001) {
        const cross = fdx * rec.lastDirY - fdy * rec.lastDirX;
        const sign = cross < 0 ? 1 : -1;
        const ca = Math.cos(maxAng), sa = sign * Math.sin(maxAng);
        const ux = rec.lastDirX / oLen, uy = rec.lastDirY / oLen;
        fdx = (ux * ca - uy * sa) * nLen;
        fdy = (ux * sa + uy * ca) * nLen;
      }
    }
  }
  rec.lastDirX = fdx;
  rec.lastDirY = fdy;
  rec.filtX += fdx;
  rec.filtY += fdy;
  const rx = rec.filtX, ry = rec.filtY;

  // 2) Stabilization：滑动平均，window = 1 + stab × 16
  let sx = rx, sy = ry;
  if (stab > 0) {
    const cap = 1 + Math.round(stab * 16);
    rec.stabBuf.push([rx, ry]);
    if (rec.stabBuf.length > cap) rec.stabBuf.shift();
    let mx = 0, my = 0;
    for (const p of rec.stabBuf) { mx += p[0]; my += p[1]; }
    sx = mx / rec.stabBuf.length;
    sy = my / rec.stabBuf.length;
  } else if (rec.stabBuf.length) {
    rec.stabBuf.length = 0;
  }

  // 3) Pull-Stabilizer：速度上限 follower。pull→1 时 maxStep → 0.5 px/event
  if (pull > 0) {
    const maxStep = Math.max(0.5, (1 - pull) * 64);
    const ddx = sx - rec.pullX, ddy = sy - rec.pullY;
    const d = Math.hypot(ddx, ddy);
    if (d > maxStep) { rec.pullX += ddx * maxStep / d; rec.pullY += ddy * maxStep / d; }
    else { rec.pullX = sx; rec.pullY = sy; }
  } else {
    rec.pullX = sx; rec.pullY = sy;
  }

  // 4) StreamLine：一阶 IIR LPF + 速度自适应（详 docs/streamline-velocity-math.md，已漂移）
  const V_REF = (SMOOTH.vref > 0) ? SMOOTH.vref : 0.1;
  const alphaBase = Math.max(0.05, 1 - sl);
  const _evtDt = Math.max(1, ev.timeStamp - (rec._prevEvtTs ?? ev.timeStamp - 16));
  rec._prevEvtTs = ev.timeStamp;
  const v = Math.hypot(fdx, fdy) / _evtDt;
  const t = Math.min(1, v / V_REF);
  const ramp = t * t * (3 - 2 * t);
  const adaptStrength = Math.max(0, 1 - sl);
  const alphaPos = alphaBase + adaptStrength * (1 - ramp) * (1 - alphaBase);
  rec.smX = rec.smX + alphaPos * (rec.pullX - rec.smX);
  rec.smY = rec.smY + alphaPos * (rec.pullY - rec.smY);
  return { x: rec.smX, y: rec.smY };
}
