// 笔粗分段量化测试（UI 深化 candidate 1）。从 .ts 直接 import（node24 strip-types）。
import { describe, it, eq, assert } from "./runner.mjs";
import { segPositions, sliderPosToSize, sizeToSliderPos, sliderMaxPos, stepFor, quantizeSize } from "../src/ui/brush-size.ts";

describe("brush-size 分段量化", () => {
  it("quantizeSize 按段步长 snap", () => {
    eq(quantizeSize(0), 1, "下限 1");
    eq(quantizeSize(7), 7, "20内步1");
    eq(quantizeSize(37), 38, "20..50 步2");
    eq(quantizeSize(73), 75, "50..100 步5");
    eq(quantizeSize(147), 150, "100..200 步10");
    eq(quantizeSize(333), 340, "200..500 步20");
    eq(quantizeSize(777), 800, "500..1000 步50");
  });

  it("stepFor 段步长", () => {
    eq(stepFor(10), 1); eq(stepFor(30), 2); eq(stepFor(80), 5);
    eq(stepFor(150), 10); eq(stepFor(300), 20); eq(stepFor(900), 50);
  });

  it("slider pos ⇄ size 往返（maxPx=200）", () => {
    const max = 200;
    for (const px of [1, 12, 20, 50, 100, 200]) {
      const pos = sizeToSliderPos(px, max);
      eq(sliderPosToSize(pos, max), px, `往返 ${px}`);
    }
  });

  it("sliderMaxPos = 总刻度-1，pos 0 = 1px", () => {
    const max = 200;
    eq(sliderPosToSize(0, max), 1, "pos0 → 1px");
    const top = sliderMaxPos(max);
    eq(sliderPosToSize(top, max), 200, "顶 pos → maxPx");
    eq(segPositions(200).total, top + 1, "total = maxPos+1");
  });

  it("segPositions 小 maxPx 不溢出", () => {
    const s = segPositions(8);
    eq(s.a, 8); eq(s.b, 0); eq(s.total, 8);
    assert(sliderPosToSize(99, 8) <= 8, "clamp 到 maxPx 段内");
  });
});
