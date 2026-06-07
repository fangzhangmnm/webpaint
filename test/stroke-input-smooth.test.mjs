// 四件套位置平滑验收（K3 live·切片2）。过去内联 input.js、零测、改一个系数静默跑偏。
// 纯函数（mutates rec）：逐阶段钉行为。screen px 单位。
import { describe, it, assert } from "./runner.mjs";
import { fourStageSmooth } from "../src/stroke-input-smooth.js";

// 起手锚（同 input._down：filt/sm/pull = raw 起点，stabBuf 空）
const rec0 = (x = 100, y = 100) => ({ lastDirX: 0, lastDirY: 0, filtX: x, filtY: y, stabBuf: [], pullX: x, pullY: y, smX: x, smY: y });
const S = (o = {}) => ({ streamline: 0, stabilization: 0, pullStabilizer: 0, motionFilter: 0, ...o });
const ev = (t) => ({ timeStamp: t });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe("stroke-input-smooth · fourStageSmooth", () => {
  it("全 0 = 直通（输出 = 累积 raw，无平滑）", () => {
    const r = rec0(100, 100);
    const out = fourStageSmooth(r, ev(16), S(), 10, 0);     // raw +10x
    assert(near(out.x, 110) && near(out.y, 100), `期望(110,100) 实得(${out.x},${out.y})`);
  });

  it("StreamLine：sl>0 + 快速移动 → 输出按 (1-sl) 滞后逼近（ramp=1 时 α=1-sl）", () => {
    const r = rec0(100, 100);
    const out = fourStageSmooth(r, ev(16), S({ streamline: 0.9 }), 100, 0);   // v=100/16 ≫ vref → ramp=1
    // smX = 100 + (1-0.9)*(200-100) = 110
    assert(near(out.x, 110, 0.5), `sl=0.9 快速应 ≈110，实得 ${out.x}`);
    assert(out.x > 100 && out.x < 200, "在起点与目标之间（滞后）");
  });

  it("Pull-Stabilizer：pull→1 → 单步位移被钳到 maxStep（大跳变只挪一点）", () => {
    const r = rec0(100, 100);
    const out = fourStageSmooth(r, ev(16), S({ pullStabilizer: 0.99 }), 100, 0);  // maxStep=max(0.5,0.01*64)=0.64
    // pullX 只前进 ~0.64；sl=0 → smX=pullX
    assert(out.x > 100 && out.x < 102, `pull=0.99 应钉在起点附近(<102)，实得 ${out.x}`);
  });

  it("Stabilization：滑动平均 → 输出滞后于最新 raw", () => {
    const r = rec0(100, 100);
    fourStageSmooth(r, ev(16), S({ stabilization: 0.5 }), 20, 0);   // filt=120，窗口内
    const out = fourStageSmooth(r, ev(32), S({ stabilization: 0.5 }), 20, 0);   // filt=140
    assert(out.x < 140 && out.x > 100, `均值应落后最新 raw(140)，实得 ${out.x}`);
    assert(r.stabBuf.length === 2, "stabBuf 累了两点");
  });

  it("Stabilization 关闭 → 清空 stabBuf（避免残留污染）", () => {
    const r = rec0(); r.stabBuf = [[1, 1], [2, 2]];
    fourStageSmooth(r, ev(16), S({ stabilization: 0 }), 5, 0);
    assert(r.stabBuf.length === 0, "stab=0 应清空 buf");
  });

  it("Motion Filter：mf 把急转方向往上一笔方向夹（减小转角）", () => {
    const r = rec0(100, 100);
    fourStageSmooth(r, ev(16), S({ motionFilter: 0.5 }), 10, 0);    // 建立方向 +x
    const before = { dx: r.lastDirX, dy: r.lastDirY };
    fourStageSmooth(r, ev(32), S({ motionFilter: 0.5 }), -10, 0);   // 急转 180°
    // mf=0.5 → maxAng=π/2，180° 被夹到 90° → 不再是纯 -x
    assert(!(near(r.lastDirX, -10) && near(r.lastDirY, 0)), "180°急转应被夹（方向不等于纯 -x）");
    assert(before.dx > 0, "首笔方向 +x");
  });

  it("mutates rec 的平滑状态（filt/sm/_prevEvtTs 推进）", () => {
    const r = rec0(100, 100);
    fourStageSmooth(r, ev(50), S(), 10, 5);
    assert(near(r.filtX, 110) && near(r.filtY, 105), "filt 累积 raw");
    assert(r._prevEvtTs === 50, "记录上一 event 时戳给 dt");
  });
});
