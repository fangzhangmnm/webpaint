// 指针路由决策（K3：把「这个 pointer 是什么意思」从 input.js 的 live 事件流里劈出来）。
// 纯函数（无 DOM / 无 this / 无副作用）：给输入位 → role。过去这段决策树内联在 _down，
// 且 effectiveTool→role 的映射在 mouse/pen/touch 三处**各抄一份**。抽出 = 决策可单测、改一处。
// 行为矩阵沿用 ScratchPad（见 input.js 顶部注释）；live 事件流 / pointers Map / 手势仍在 input.js。

// 当前工具 → 有效工具：transform 抢画布路由走 gizmo（机械上 role=lasso）；alt+brush 临时取色。
export function effectiveTool(tool, altDown) {
  if (tool === "transform") return "lasso";
  if (altDown && tool === "brush") return "picker";
  return tool;   // crop/adjust 等 fall-through，由 input 的 canDraw gate 兜
}

// 有效工具 → 引擎 role（mouse 左键 / pen 主笔 / touch 无 pen 时共用这张表）。
export function toolToRole(et) {
  switch (et) {
    case "eraser": return "erase";
    case "picker": return "pick";
    case "liquify": return "liquify";
    case "filterBrush": return "filterBrush";
    case "lasso": return "lasso";
    case "smudge": return "draw";   // v85+ smudge 引擎实装前先按 draw 走
    default: return "draw";         // brush / 未知 → draw
  }
}

// 完整 pointerdown 角色决策。输入位：
//   tool, pointerType('mouse'|'pen'|'touch'), button, buttons, spaceDown, altDown, penEverSeen
// 顺序与设备语义沿用原 _down：hand/space=pan 优先 → 按 pointerType 分支。
export function assignRole({ tool, pointerType, button, buttons, spaceDown, altDown, penEverSeen }) {
  if (tool === "hand" || spaceDown) return "pan";
  const et = effectiveTool(tool, altDown);
  if (pointerType === "mouse") return button === 0 ? toolToRole(et) : "pan";          // 中/右键 = pan
  if (pointerType === "pen")   return (button === 2 || (buttons & 2)) ? "erase" : toolToRole(et);  // 副按钮强制橡皮
  if (pointerType === "touch") return penEverSeen ? "pan" : toolToRole(et);           // 见过 pen 的设备：手指只 pan
  return null;
}
