// 指针路由决策验收（K3 live-dispatch 切片）。纯函数，过去内联在 _down 且 map 抄 3 份、零测。
import { describe, it, eq, assert } from "./runner.mjs";
import { effectiveTool, toolToRole, assignRole, strokeMode, eraserTapOnRelease, ERASER_HOLD_TAP_MS } from "../src/pointer-route.ts";

describe("pointer-route · effectiveTool", () => {
  it("transform → lasso（抢画布路由走 gizmo）", () => eq(effectiveTool("transform", false), "lasso"));
  it("alt + brush → picker（临时取色）", () => eq(effectiveTool("brush", true), "picker"));
  it("alt + fill → picker（v0.7.8 油漆桶吸色，吸预览色）", () => eq(effectiveTool("fill", true), "picker"));
  it("alt + shapeBrush → picker（user：形状笔也能 alt 取色）", () => eq(effectiveTool("shapeBrush", true), "picker"));
  it("alt 只对 brush/fill/shapeBrush 生效（eraser/filterBrush 不扩权）", () => {
    eq(effectiveTool("eraser", true), "eraser"); eq(effectiveTool("lasso", true), "lasso");
    eq(effectiveTool("filterBrush", true), "filterBrush");
  });
  it("其余原样", () => { eq(effectiveTool("brush", false), "brush"); eq(effectiveTool("crop", false), "crop"); });
});

describe("pointer-route · toolToRole", () => {
  it("各工具 → role", () => {
    eq(toolToRole("eraser"), "erase"); eq(toolToRole("picker"), "pick");
    eq(toolToRole("filterBrush"), "filterBrush");   // 液化 = filterBrush payload（S8 删直连 role）
    eq(toolToRole("lasso"), "lasso");
    eq(toolToRole("brush"), "draw"); eq(toolToRole("未知"), "draw");
  });
});

describe("pointer-route · assignRole", () => {
  const base = { tool: "brush", pointerType: "mouse", button: 0, buttons: 1, spaceDown: false, altDown: false, penEverSeen: false };
  const role = (o) => assignRole({ ...base, ...o });

  it("hand / space 优先 = pan（任何 pointer）", () => {
    eq(role({ tool: "hand" }), "pan");
    eq(role({ spaceDown: true }), "pan");
    eq(role({ tool: "hand", pointerType: "pen" }), "pan");
  });

  it("mouse：左键=toolToRole；中/右键=pan", () => {
    eq(role({ tool: "eraser", button: 0 }), "erase");
    eq(role({ tool: "lasso", button: 0 }), "lasso");
    eq(role({ button: 1 }), "pan");
    eq(role({ button: 2 }), "pan");
  });

  it("pen：副按钮(button2 / buttons&2)强制 erase；否则 toolToRole", () => {
    eq(role({ pointerType: "pen", button: 0, buttons: 1 }), "draw");
    eq(role({ pointerType: "pen", button: 2 }), "erase");
    eq(role({ pointerType: "pen", button: 0, buttons: 2 }), "erase");
    eq(role({ pointerType: "pen", tool: "picker", button: 0, buttons: 1 }), "pick");
  });

  it("touch：单指作画 ⟺ 无笔 + 开关ON；pen 路径恒 hold；开关默认OFF=hold", () => {
    // 见过 pen 的设备：恒 hold，不论开关
    eq(role({ pointerType: "touch", penEverSeen: true }), "hold");
    eq(role({ pointerType: "touch", penEverSeen: true, singleFingerDraw: true }), "hold");
    eq(role({ pointerType: "touch", penEverSeen: true, singleFingerDraw: true, tool: "brush" }), "hold");
    // 无笔 + 开关 OFF（默认）：hold
    eq(role({ pointerType: "touch", penEverSeen: false, tool: "brush" }), "hold");
    eq(role({ pointerType: "touch", penEverSeen: false, singleFingerDraw: false, tool: "lasso" }), "hold");
    // 无笔 + 开关 ON：toolToRole（作画）
    eq(role({ pointerType: "touch", penEverSeen: false, singleFingerDraw: true, tool: "lasso" }), "lasso");
    eq(role({ pointerType: "touch", penEverSeen: false, singleFingerDraw: true, tool: "brush" }), "draw");
  });

  it("transform → lasso；alt+brush / alt+shapeBrush → pick（经 effectiveTool）", () => {
    eq(role({ tool: "transform", button: 0 }), "lasso");
    eq(role({ tool: "brush", altDown: true, button: 0 }), "pick");
    eq(role({ tool: "shapeBrush", altDown: true, button: 0 }), "pick");
  });

  it("回归锁：三设备分支对同一非特殊工具给同一 role（旧 map 抄 3 份的去重）", () => {
    for (const t of ["brush", "eraser", "picker", "filterBrush", "lasso"]) {
      const expected = toolToRole(effectiveTool(t, false));
      eq(role({ tool: t, pointerType: "mouse", button: 0 }), expected, `mouse ${t}`);
      eq(role({ tool: t, pointerType: "pen", button: 0, buttons: 1 }), expected, `pen ${t}`);
      eq(role({ tool: t, pointerType: "touch", penEverSeen: false, singleFingerDraw: true }), expected, `touch ${t}`);
    }
  });
});

describe("pointer-route · 按住 E = 临时橡皮（spring-loaded，2026-08-21）", () => {
  it("strokeMode：hold → draw/shapeBrush 变 erase；松开 → brush", () => {
    eq(strokeMode("draw", true), "erase", "hold + 画笔 → 临时橡皮");
    eq(strokeMode("shapeBrush", true), "erase", "hold + 形状笔 → 临时橡皮（erase 链经 _inner 透传）");
    eq(strokeMode("draw", false), "brush", "松开 → 回画笔");
    eq(strokeMode("shapeBrush", false), "brush", "松开 → 回形状笔");
  });
  it("strokeMode：橡皮工具恒 erase（hold 无操作）；其它 role 不吃 E", () => {
    eq(strokeMode("erase", false), "erase");
    eq(strokeMode("erase", true), "erase", "工具已是橡皮 → hold no-op");
    for (const r of ["filterBrush", "lasso", "pick", "pan", "hold"]) {
      eq(strokeMode(r, true), "brush", `${r} 不被 E 橡皮化`);
    }
  });
  it("eraserTapOnRelease：<350ms 且未落笔 = tap（切橡皮）；长按或落过笔 = 不切", () => {
    assert(eraserTapOnRelease(100, false), "短按未落笔 → tap");
    assert(eraserTapOnRelease(ERASER_HOLD_TAP_MS - 1, false), "349ms 仍是 tap");
    assert(!eraserTapOnRelease(ERASER_HOLD_TAP_MS, false), "350ms 起算长按");
    assert(!eraserTapOnRelease(100, true), "落过笔 → 即使短按也不切（hold 已被消费）");
    assert(!eraserTapOnRelease(1000, true), "长按 + 落笔 → 不切");
  });
  // mid-stroke 按/松 E 不影响当前笔：mode 由 input._down 求值**一次**进 beginStroke，
  //   引擎侧锁定钉在 shape-brush.test.mjs「erase mode 透传链」用例（collectStamps().mode 全程不变）。
});
