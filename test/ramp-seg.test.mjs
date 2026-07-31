// v0.7.22 ramp-slider 分段步长模式（segValueTable/nearestSegPos）验收。
// 语义锚：位置空间=档位索引 → 无死区/无够不着的值/值恒规格整数；与 brush-size.ts 段表互证
// （将来笔刷 slider 迁移 = 同一实现喂 brush 段表，两边序列必须逐位一致）。
import { describe, it, assert, eq } from "./runner.mjs";

const { segValueTable, nearestSegPos } = await import("../src/ui/ramp-slider.ts");
const { sliderPosToSize, sliderMaxPos } = await import("../src/ui/brush-size.ts");

const TOL_SEGS = [{ upTo: 20, step: 1 }, { upTo: 40, step: 2 }, { upTo: 70, step: 5 }, { upTo: 100, step: 10 }];

describe("ramp-slider · 分段步长表", () => {
  it("容差段表：0..20步1 / 20..40步2 / 40..70步5 / 70..100步10 = 40 档", () => {
    const vals = segValueTable(0, TOL_SEGS);
    eq(vals.length, 40, "档数");
    eq(vals[0], 0, "起点 0（sqrt/log 曲线到不了的那个 0）");
    eq(vals[20], 20, "段界 20");
    eq(vals[21], 22, "第二段步 2");
    eq(vals[vals.length - 1], 100, "终点 100");
    for (let i = 1; i < vals.length; i++) assert(vals[i] > vals[i - 1], "严格递增");
  });

  it("nearestSegPos：每档回灌到自己的索引（无死区/无跳档）；档间值吸最近", () => {
    const vals = segValueTable(0, TOL_SEGS);
    for (let i = 0; i < vals.length; i++) eq(nearestSegPos(vals, vals[i]), i, `档 ${vals[i]} 自回灌`);
    eq(vals[nearestSegPos(vals, 41)], 40, "41 吸 40（邻档 40/45）");
    eq(vals[nearestSegPos(vals, 43)], 45, "43 吸 45（|3| vs |2|）");
    eq(vals[nearestSegPos(vals, 999)], 100, "越界夹到端点");
  });

  it("与 brush-size 段表互证：同规格喂 segValueTable ≡ sliderPosToSize 全序列", () => {
    const BRUSH_SEGS = [
      { upTo: 20, step: 1 }, { upTo: 50, step: 2 }, { upTo: 100, step: 5 },
      { upTo: 200, step: 10 }, { upTo: 500, step: 20 }, { upTo: 1000, step: 50 },
    ];
    const vals = segValueTable(1, BRUSH_SEGS);
    const n = sliderMaxPos(1000) + 1;
    eq(vals.length, n, "档数一致");
    for (let p = 0; p < n; p++) eq(vals[p], sliderPosToSize(p, 1000), `档位 ${p}`);
  });
});
