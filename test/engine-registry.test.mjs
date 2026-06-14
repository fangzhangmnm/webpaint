// Engine dispatch 表验收（K1，见 docs/reports/20260606-fresh-geological-survey.html）。
// 这张表是 input.js 的 dispatch 决策 SSoT —— 历史上 bug 藏在「怎么被调」而非引擎内部，
// 所以决策本身就是测试面。纯数据 + 谓词，无需 canvas / DOM。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  PIXEL_STROKE_SPECS, isPixelStroke, pixelStrokeSpec,
} from "../src/engine-registry.js";

// 重构前散在 input.js 各处的字面成员集合（_down/_move/_up/_discardPointer/gesture-abort）。
// 把它们当 oracle：新谓词必须对**所有可能 role**与旧字面表达式逐一相等（回归锁）。
const ALL_ROLES = [
  "draw", "erase", "liquify", "filterBrush",   // pixel-stroke
  "lasso",                                      // 各有专门生命周期
  "pick", "pan", "gesture", "ignore",           // 非绘制
  null, undefined, "",                          // 边界（pointer 还没定角色 / 被清）
];
const oldPixelStrokeChain = (r) =>
  r === "draw" || r === "erase" || r === "liquify" || r === "filterBrush";
const oldCoalesceLatest = (r) => r === "liquify" || r === "filterBrush";
const oldUsesBrushSettings = (r) => !(r === "liquify" || r === "filterBrush");

describe("engine-registry · dispatch 决策", () => {
  it("isPixelStroke 与旧字面成员链对所有 role 逐一相等（回归锁）", () => {
    for (const r of ALL_ROLES) {
      eq(isPixelStroke(r), oldPixelStrokeChain(r), `isPixelStroke(${JSON.stringify(r)})`);
    }
  });

  it("spec.coalesceLatest（丢帧策略）只对液化 / filterBrush 为真", () => {
    for (const r of ALL_ROLES) {
      const spec = pixelStrokeSpec(r);
      const v = spec ? spec.coalesceLatest : false;
      // 非 pixel-stroke 不进 _move 的该分支，等价于 false
      eq(v, isPixelStroke(r) ? oldCoalesceLatest(r) : false, `coalesceLatest(${JSON.stringify(r)})`);
    }
  });

  it("spec.usesBrushSettings（喂四件套平滑）只对 draw / erase 为真", () => {
    for (const r of ["draw", "erase", "liquify", "filterBrush"]) {
      eq(pixelStrokeSpec(r).usesBrushSettings, oldUsesBrushSettings(r), `usesBrushSettings(${r})`);
    }
  });

  it("finalize：draw/erase/liquify=true（按选区收尾），filterBrush=false（begin 已吃选区）", () => {
    eq(pixelStrokeSpec("draw").finalize, true);
    eq(pixelStrokeSpec("erase").finalize, true);
    eq(pixelStrokeSpec("liquify").finalize, true);
    eq(pixelStrokeSpec("filterBrush").finalize, false);
  });

  it("historyType：liquify 走独立 'liquify' 事务，其余走 'stroke'", () => {
    eq(pixelStrokeSpec("liquify").historyType, "liquify");
    for (const r of ["draw", "erase", "filterBrush"]) {
      eq(pixelStrokeSpec(r).historyType, "stroke", `historyType(${r})`);
    }
  });

  it("engineKey：draw/erase 共用 brush；liquify→liquify；filterBrush→filterBrush", () => {
    eq(pixelStrokeSpec("draw").engineKey, "brush");
    eq(pixelStrokeSpec("erase").engineKey, "brush");
    eq(pixelStrokeSpec("liquify").engineKey, "liquify");
    eq(pixelStrokeSpec("filterBrush").engineKey, "filterBrush");
  });

  it("pixelStrokeSpec 对非 pixel-stroke role 返回 null", () => {
    for (const r of ["lasso", "pick", "pan", null, "nope"]) {
      eq(pixelStrokeSpec(r), null, `pixelStrokeSpec(${JSON.stringify(r)})`);
    }
  });

  it("表与谓词不漂移：PIXEL_STROKE_SPECS 的每个 key 都 isPixelStroke", () => {
    const keys = Object.keys(PIXEL_STROKE_SPECS);
    eq(keys.length, 4, "恰好 4 个 pixel-stroke role");
    for (const k of keys) assert(isPixelStroke(k), `${k} 应 isPixelStroke`);
  });

  it("表是冻结的（防运行时被改写造成 dispatch 漂移）", () => {
    assert(Object.isFrozen(PIXEL_STROKE_SPECS), "PIXEL_STROKE_SPECS 应冻结");
    assert(Object.isFrozen(PIXEL_STROKE_SPECS.draw), "spec 条目应冻结");
  });
});
