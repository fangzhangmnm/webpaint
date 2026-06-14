// 指针路由决策验收（K3 live-dispatch 切片）。纯函数，过去内联在 _down 且 map 抄 3 份、零测。
import { describe, it, eq } from "./runner.mjs";
import { effectiveTool, toolToRole, assignRole } from "../src/pointer-route.js";

describe("pointer-route · effectiveTool", () => {
  it("transform → lasso（抢画布路由走 gizmo）", () => eq(effectiveTool("transform", false), "lasso"));
  it("alt + brush → picker（临时取色）", () => eq(effectiveTool("brush", true), "picker"));
  it("alt 只对 brush 生效", () => { eq(effectiveTool("eraser", true), "eraser"); eq(effectiveTool("lasso", true), "lasso"); });
  it("其余原样", () => { eq(effectiveTool("brush", false), "brush"); eq(effectiveTool("crop", false), "crop"); });
});

describe("pointer-route · toolToRole", () => {
  it("各工具 → role", () => {
    eq(toolToRole("eraser"), "erase"); eq(toolToRole("picker"), "pick");
    eq(toolToRole("liquify"), "liquify"); eq(toolToRole("filterBrush"), "filterBrush");
    eq(toolToRole("lasso"), "lasso"); eq(toolToRole("smudge"), "draw");
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

  it("touch：见过 pen 的设备单指=hold（不拖画布，双指才 pan）；没见过 = toolToRole", () => {
    eq(role({ pointerType: "touch", penEverSeen: true }), "hold");
    eq(role({ pointerType: "touch", penEverSeen: false, tool: "lasso" }), "lasso");
    eq(role({ pointerType: "touch", penEverSeen: false, tool: "brush" }), "draw");
  });

  it("transform → lasso；alt+brush → pick（经 effectiveTool）", () => {
    eq(role({ tool: "transform", button: 0 }), "lasso");
    eq(role({ tool: "brush", altDown: true, button: 0 }), "pick");
  });

  it("回归锁：三设备分支对同一非特殊工具给同一 role（旧 map 抄 3 份的去重）", () => {
    for (const t of ["brush", "eraser", "picker", "liquify", "filterBrush", "lasso", "smudge"]) {
      const expected = toolToRole(effectiveTool(t, false));
      eq(role({ tool: t, pointerType: "mouse", button: 0 }), expected, `mouse ${t}`);
      eq(role({ tool: t, pointerType: "pen", button: 0, buttons: 1 }), expected, `pen ${t}`);
      eq(role({ tool: t, pointerType: "touch", penEverSeen: false }), expected, `touch ${t}`);
    }
  });
});
