// v0.9.13 导出 defringe（贴图防黑边）行为锚 + PNG 往返保底。
// 语义：α=0 像素 RGB 回填最近（BFS 层序）不透明像素色；α 一个字节不动；α>0 像素不碰。
// PNG 往返是存在意义本体：encodePngFromBytes 直写 straight RGBA（不过 canvas premult），
// α=0 处的回填色必须活到最终文件——活不过就是白做（游戏引擎采样看的就是这些字节）。
import { describe, it } from "./runner.mjs";
import assert from "node:assert/strict";
import { defringeAlphaZero } from "../src/backend/algorithms/defringe.ts";
import { encodePngFromBytes, decodePngToBytes } from "../src/backend/png-codec.ts";

describe("defringe（v0.9.13 贴图防黑边）", () => {
  it("α=0 区回填边缘色；α 不动；源像素不碰", () => {
    const w = 8, h = 1;
    const d = new Uint8ClampedArray(w * h * 4);
    d.set([200, 30, 10, 255], 0);   // 最左一颗红，其余全透明
    defringeAlphaZero(d, w, h);
    for (let x = 1; x < w; x++) {
      assert.deepEqual([d[x * 4], d[x * 4 + 1], d[x * 4 + 2]], [200, 30, 10], `x=${x} RGB 回填红`);
      assert.equal(d[x * 4 + 3], 0, `x=${x} α 仍 0`);
    }
    assert.deepEqual([d[0], d[1], d[2], d[3]], [200, 30, 10, 255], "源像素原样");
  });

  it("两源竞争：各自就近（BFS 层序）", () => {
    const w = 5, h = 1;
    const d = new Uint8ClampedArray(w * h * 4);
    d.set([255, 0, 0, 255], 0);            // 左端红
    d.set([0, 0, 255, 255], 4 * 4);        // 右端蓝
    defringeAlphaZero(d, w, h);
    assert.equal(d[1 * 4 + 0], 255, "x=1 近左 → 红");
    assert.equal(d[3 * 4 + 2], 255, "x=3 近右 → 蓝");
  });

  it("全透明 / 全不透明 = no-op", () => {
    for (const alpha of [0, 255]) {
      const d = new Uint8ClampedArray(2 * 2 * 4);
      for (let p = 0; p < 4; p++) { d[p * 4] = 7; d[p * 4 + 3] = alpha; }
      const before = new Uint8ClampedArray(d);
      defringeAlphaZero(d, 2, 2);
      assert.deepEqual([...d], [...before], `alpha=${alpha} 不动`);
    }
  });

  it("PNG 往返：α=0 处回填的 RGB 活过 encode/decode", async () => {
    const w = 4, h = 4;
    const d = new Uint8ClampedArray(w * h * 4);
    d.set([10, 200, 60, 255], 0);   // 一颗绿源，其余透明
    defringeAlphaZero(d, w, h);
    const png = await encodePngFromBytes(d, w, h);
    const back = await decodePngToBytes(png);
    assert.equal(back.w, w);
    for (let p = 1; p < w * h; p++) {
      assert.equal(back.data[p * 4 + 3], 0, `p=${p} α=0`);
      assert.deepEqual(
        [back.data[p * 4], back.data[p * 4 + 1], back.data[p * 4 + 2]],
        [10, 200, 60],
        `p=${p} 回填色活过 PNG 往返`,
      );
    }
  });
});
