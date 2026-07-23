// Engine dispatch 表验收（K1，见 docs/reports/20260606-fresh-geological-survey.html）。
// 这张表是 input.js 的 dispatch 决策 SSoT —— 历史上 bug 藏在「怎么被调」而非引擎内部，
// 所以决策本身就是测试面。纯数据 + 谓词，无需 canvas / DOM。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  PIXEL_STROKE_SPECS, isPixelStroke, pixelStrokeSpec,
} from "../src/engine-registry.ts";

// 重构前散在 input.js 各处的字面成员集合（_down/_move/_up/_discardPointer/gesture-abort）。
// 把它们当 oracle：新谓词必须对**所有可能 role**与旧字面表达式逐一相等（回归锁）。
const ALL_ROLES = [
  "draw", "erase", "filterBrush",              // pixel-stroke（液化 = filterBrush payload，S8 删直连 role）
  "lasso",                                      // 各有专门生命周期
  "pick", "pan", "gesture", "ignore",           // 非绘制
  null, undefined, "",                          // 边界（pointer 还没定角色 / 被清）
];
const oldPixelStrokeChain = (r) =>
  r === "draw" || r === "erase" || r === "filterBrush";
const oldCoalesceLatest = (r) => r === "filterBrush";
const oldUsesBrushSettings = (r) => !(r === "filterBrush");

describe("engine-registry · dispatch 决策", () => {
  it("isPixelStroke 与旧字面成员链对所有 role 逐一相等（回归锁）", () => {
    for (const r of ALL_ROLES) {
      eq(isPixelStroke(r), oldPixelStrokeChain(r), `isPixelStroke(${JSON.stringify(r)})`);
    }
  });

  it("spec.coalesceLatest（丢帧策略）只对 filterBrush（含液化 payload）为真", () => {
    for (const r of ALL_ROLES) {
      const spec = pixelStrokeSpec(r);
      const v = spec ? spec.coalesceLatest : false;
      // 非 pixel-stroke 不进 _move 的该分支，等价于 false
      eq(v, isPixelStroke(r) ? oldCoalesceLatest(r) : false, `coalesceLatest(${JSON.stringify(r)})`);
    }
  });

  it("spec.usesResolvedBrush（喂四件套平滑）只对 draw / erase 为真", () => {
    for (const r of ["draw", "erase", "filterBrush"]) {
      eq(pixelStrokeSpec(r).usesResolvedBrush, oldUsesBrushSettings(r), `usesResolvedBrush(${r})`);
    }
  });

  it("finalize：draw/erase=true（按选区收尾），filterBrush=false（begin 已吃选区）", () => {
    eq(pixelStrokeSpec("draw").finalize, true);
    eq(pixelStrokeSpec("erase").finalize, true);
    eq(pixelStrokeSpec("filterBrush").finalize, false);
  });

  it("historyType：全部走 'stroke'（液化独立 'liquify' 事务随直连 role 一起退役）", () => {
    for (const r of ["draw", "erase", "filterBrush"]) {
      eq(pixelStrokeSpec(r).historyType, "stroke", `historyType(${r})`);
    }
  });

  it("engineKey：draw/erase 共用 brush；filterBrush→filterBrush", () => {
    eq(pixelStrokeSpec("draw").engineKey, "brush");
    eq(pixelStrokeSpec("erase").engineKey, "brush");
    eq(pixelStrokeSpec("filterBrush").engineKey, "filterBrush");
  });

  it("pixelStrokeSpec 对非 pixel-stroke role 返回 null", () => {
    for (const r of ["lasso", "pick", "pan", null, "nope"]) {
      eq(pixelStrokeSpec(r), null, `pixelStrokeSpec(${JSON.stringify(r)})`);
    }
  });

  it("表与谓词不漂移：PIXEL_STROKE_SPECS 的每个 key 都 isPixelStroke", () => {
    const keys = Object.keys(PIXEL_STROKE_SPECS);
    eq(keys.length, 3, "恰好 3 个 pixel-stroke role（draw/erase/filterBrush）");
    for (const k of keys) assert(isPixelStroke(k), `${k} 应 isPixelStroke`);
  });

  it("表是冻结的（防运行时被改写造成 dispatch 漂移）", () => {
    assert(Object.isFrozen(PIXEL_STROKE_SPECS), "PIXEL_STROKE_SPECS 应冻结");
    assert(Object.isFrozen(PIXEL_STROKE_SPECS.draw), "spec 条目应冻结");
  });
});
