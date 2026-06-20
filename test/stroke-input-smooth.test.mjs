// 即时路径平滑（像素）inputSmooth：死区 + EMA 二参。screen px。
// 纯函数（mutates rec）：逐参数钉行为。详 docs/brush-procreate-smoothing.md。
import { describe, it, assert } from "./runner.mjs";
import { inputSmooth } from "../src/stroke-input-smooth.ts";
import { SMOOTH } from "../src/smooth-config.ts";

// 起手锚（同 input._down：rawS/stab/sm = raw 起点）
const rec0 = (x = 100, y = 100) => ({ rawSX: x, rawSY: y, stabX: x, stabY: y, smX: x, smY: y });
const S = (o = {}) => ({ streamline: 0, stabilization: 0, ...o });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe("stroke-input-smooth · inputSmooth（死区 + EMA）", () => {
  it("全 0 = 直通（输出 = 累积 raw，无平滑）", () => {
    const r = rec0(100, 100);
    const out = inputSmooth(r, S(), 10, 0);
    assert(near(out.x, 110) && near(out.y, 100), `期望(110,100) 实得(${out.x},${out.y})`);
  });

  it("streamline>0 → EMA 滞后逼近（a=sl×0.9）", () => {
    const r = rec0(100, 100);
    const out = inputSmooth(r, S({ streamline: 0.9 }), 100, 0);   // a=0.81 → smX=100+(200-100)*0.19=119
    assert(near(out.x, 119, 0.5), `sl=0.9 应 ≈119，实得 ${out.x}`);
    assert(out.x > 100 && out.x < 200, "在起点与目标之间（滞后）");
  });

  it("stabilization 死区：半径内 raw 不拉动落点", () => {
    const r = rec0(100, 100);
    const out = inputSmooth(r, S({ stabilization: 1 }), 5, 0);    // r=stabMaxPx=8 > 5 → 不动
    assert(near(out.x, 100), `死区内应钉在起点，实得 ${out.x}`);
    assert(near(r.stabX, 100), "stab 锚未动");
  });

  it("stabilization 死区：超半径才按 (d−r) 拉", () => {
    const r = rec0(100, 100);
    const out = inputSmooth(r, S({ stabilization: 1 }), 10, 0);   // d=10>r=8 → stab 前进 (10−8)=2
    assert(near(out.x, 102), `超死区应前进 2px，实得 ${out.x}`);
  });

  it("stabilization=0 → 死区直通（raw 原样）", () => {
    const r = rec0(100, 100);
    inputSmooth(r, S({ stabilization: 0 }), 3, 0);
    assert(near(r.stabX, 103), "stab=0 应直通 raw");
  });

  it("mutates rec（rawS 累积 raw 位移）", () => {
    const r = rec0(100, 100);
    inputSmooth(r, S(), 10, 5);
    assert(near(r.rawSX, 110) && near(r.rawSY, 105), "rawS 累积 raw");
  });

  it("stabMaxPx 是 dev 面板暴露的真旋钮（×0 → 死区消失）", () => {
    const saved = SMOOTH.stabMaxPx;
    try {
      SMOOTH.stabMaxPx = 0;
      const r = rec0(100, 100);
      inputSmooth(r, S({ stabilization: 1 }), 5, 0);
      assert(near(r.stabX, 105), "stabMaxPx=0 → 死区半径 0 → 直通");
    } finally { SMOOTH.stabMaxPx = saved; }
  });
});
