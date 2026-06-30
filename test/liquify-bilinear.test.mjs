// liquify bilinearSample —— 预乘 + 越界记 0（替 v136 clamp-to-edge）。
// 问题陈述（真机：画个圆往下推，圆顶端被拉出一条）：
//   旧 clamp-to-edge 把内容紧边界的不透明像素复制到越界采样处 → 推动时沿拉拽方向"拉丝"。
//   且当年改 clamp 是为避免直值混合把透明边拖暗（"防黑边"）——预乘混合才是正解，两个都治。
import { describe, it, assert, eq } from "./runner.mjs";
const { bilinearSample } = await import("../src/plugins/liquify-engine.ts");

const sample = (sdat, w, h, sx, sy) => {
  const d = new Uint8ClampedArray(4);
  bilinearSample(sdat, w, h, sx, sy, d, 0);
  return [d[0], d[1], d[2], d[3]];
};
const RED = [255, 0, 0, 255];

describe("liquify · bilinearSample 预乘 + 越界记 0", () => {
  it("界内不透明 → 原色原 α（双线性核不变，不变糊）", () => {
    const s = new Uint8ClampedArray([...RED, ...RED, ...RED, ...RED]);  // 2×2 全红
    eq(sample(s, 2, 2, 0.5, 0.5).join(), "255,0,0,255", "界内中心 = 红不透明");
  });

  it("完全越界 → 透明(0,0,0,0)，不黑不复制", () => {
    const s = new Uint8ClampedArray([...RED, ...RED, ...RED, ...RED]);
    eq(sample(s, 2, 2, -5, -5).join(), "0,0,0,0", "越界 = 透明");
  });

  it("【拉丝修】采样在不透明内容上方(全越界 tap) → 透明，不复制边像素", () => {
    const s = new Uint8ClampedArray([...RED]);   // 1×1 不透明红（紧边界）
    // sy=-2：两个 y-tap(iy=-2,-1)都越界 → 旧 clamp 会取 (0,0)=红不透明=拉丝；新版=透明
    const r = sample(s, 1, 1, 0, -2);
    eq(r[3], 0, `上方采样应透明(α=0)，实得 α=${r[3]}（旧 clamp 会是 255=拉丝）`);
  });

  it("【防黑边修】不透明红 ⊗ 界内透明 tap → 色保持红(不拖暗)、α 减半", () => {
    const s = new Uint8ClampedArray([...RED, 0, 0, 0, 0]);   // 2×1：红不透明 | 透明
    const r = sample(s, 2, 1, 0.5, 0);                       // 两者中间
    eq(r[0], 255, `R 应保持 255(预乘不拖暗)，实得 ${r[0]}（旧直值混合=128 暗红）`);
    assert(r[3] >= 127 && r[3] <= 128, `α 应≈128(减半)，实得 ${r[3]}`);
    eq(r[1], 0, "G=0"); eq(r[2], 0, "B=0");
  });

  it("整数坐标 → 退化点采样（v147 选区整数 march 不受影响）", () => {
    const s = new Uint8ClampedArray([...RED, 0, 0, 0, 0]);   // 2×1
    eq(sample(s, 2, 1, 0, 0).join(), "255,0,0,255", "整数 (0,0) = 该像素原值");
  });
});
