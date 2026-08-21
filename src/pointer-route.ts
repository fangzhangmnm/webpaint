// 指针路由决策（K3：把「这个 pointer 是什么意思」从 input.ts 的 live 事件流里劈出来）。
// 纯函数（无 DOM / 无 this / 无副作用）：给输入位 → role。过去这段决策树内联在 _down，
// 且 effectiveTool→role 的映射在 mouse/pen/touch 三处**各抄一份**。抽出 = 决策可单测、改一处。
// 行为矩阵沿用 ScratchPad（见 input.ts 顶部注释）；live 事件流 / pointers Map / 手势仍在 input.ts。

// 当前工具 → 有效工具：transform 抢画布路由走 gizmo（机械上 role=lasso）；alt+brush/fill/shapeBrush 临时取色。
export function effectiveTool(tool: string, altDown: boolean): string {
  if (tool === "transform") return "lasso";
  // alt 吸色白名单：brush（原初）；fill（v0.7.8 吸预览色，WYSIWYG）；shapeBrush（user：「形状笔的
  //   时候应该也能alt取色」——只加 user 点名的，eraser/filterBrush 不扩权）。已知正确副作用：
  //   input._paintIntent 同函数判定 → alt+形状笔在组/隐藏层上直接吸色而不是报「组不能画」，与 brush 一致。
  if (altDown && (tool === "brush" || tool === "fill" || tool === "shapeBrush")) return "picker";
  return tool;   // crop/adjust 等 fall-through，由 input 的 canDraw gate 兜
}

// 有效工具 → 引擎 role（mouse 左键 / pen 主笔 / touch 无 pen 时共用这张表）。
export function toolToRole(et: string): string {
  switch (et) {
    case "eraser": return "erase";
    case "picker": return "pick";
    case "filterBrush": return "filterBrush";
    case "shapeBrush": return "shapeBrush";   // ADR-0005：形状笔 = 第四个 pixel-stroke 引擎
    case "lasso": return "lasso";
    case "fill": return "lasso";      // v0.5.12：fill 第一类工具，指针行为 = 选区机器（零新指针代码）
    default: return "draw";         // brush / 未知 → draw
  }
}

export interface PointerDownInput {
  tool: string;
  pointerType: string;       // 'mouse' | 'pen' | 'touch'
  button: number;
  buttons: number;
  spaceDown: boolean;
  altDown: boolean;
  penEverSeen: boolean;
  singleFingerDraw: boolean;
}

// 完整 pointerdown 角色决策。输入位：
//   tool, pointerType('mouse'|'pen'|'touch'), button, buttons, spaceDown, altDown, penEverSeen, singleFingerDraw
// 顺序与设备语义沿用原 _down：hand/space=pan 优先 → 按 pointerType 分支。
// 单指语义（touch）：单指走当前工具作画 ⟺ 无笔路径(penEverSeen=false) 且「单指绘画」开关 ON；
//   否则一律 hold（不画不 pan，仍计入双指手势 + 长按吸色）。开关默认 OFF → 单指永不作画。
//   pen 路径永远屏蔽（见过 pen 的设备恒 hold），开关只影响无笔路径。
export function assignRole({ tool, pointerType, button, buttons, spaceDown, altDown, penEverSeen, singleFingerDraw }: PointerDownInput): string | null {
  if (tool === "hand" || spaceDown) return "pan";
  const et = effectiveTool(tool, altDown);
  if (pointerType === "mouse") return button === 0 ? toolToRole(et) : "pan";          // 中/右键 = pan
  if (pointerType === "pen")   return (button === 2 || (buttons & 2)) ? "erase" : toolToRole(et);  // 副按钮强制橡皮
  // touch：无笔 + 开关 ON 才作画；否则 hold（不画不 pan，双指才 pan/zoom/rotate；长按吸色仍生效）
  if (pointerType === "touch") return (!penEverSeen && singleFingerDraw) ? toolToRole(et) : "hold";
  return null;
}

// ── 按住 E = 临时橡皮（spring-loaded，PS 惯例；2026-08-21 拍板取 hold 语义，Krita 的 E toggle 不取）──
// tap/hold 分辨：_keydown 只置位 eraserHold（不再立即切工具）；_keyup 时「短按且期间没落过笔」
//   才执行原「切到橡皮」（工具切换从 keydown 延迟到 keyup，<350ms 无感）。长按 = 临时橡皮，松开回原工具。
// 决策抽纯函数（同 assignRole 的理由：可单测、改一处）；置位/清位的 live 事件流在 input.ts。

export const ERASER_HOLD_TAP_MS = 350;   // keyup 距 keydown < 此值且未落笔 → 判 tap（= 切到橡皮工具）

// pointerdown 落笔一刻的 stroke mode 判定。mode 进引擎（beginStroke）即锁定在 st.mode，
//   mid-stroke 按/松 E 不影响当前笔——这正是取 hold 而非 mid-stroke 切换语义的原因。
// 只对 draw/shapeBrush 生效：erase 恒橡皮（工具已是橡皮时 hold 自然无操作）；
//   filterBrush/lasso/fill/pick 等不吃 E（滤镜笔/选区没有「橡皮化」语义）。
export function strokeMode(role: string, eraserHold: boolean): "erase" | "brush" {
  if (role === "erase") return "erase";
  if (eraserHold && (role === "draw" || role === "shapeBrush")) return "erase";
  return "brush";
}

// keyup 一刻的 tap 判定：按住时长 < ERASER_HOLD_TAP_MS 且按住期间没落过笔。
//   落过笔 = hold 已被消费成临时橡皮，keyup 不再切工具（不然一笔擦完工具莫名变橡皮）。
export function eraserTapOnRelease(heldMs: number, holdUsed: boolean): boolean {
  return heldMs < ERASER_HOLD_TAP_MS && !holdUsed;
}
