// dial-controls.ts —— 工具 dial（toolStates）的程序化 + 键盘写入（从组合根 app.js 下沉，survey rec #3）。
//
// setSize/setOpacity = 写当前工具 dial SSoT（rack.writeCurrentTool*）+ LS 持久化；<LeftDial> 绑 dial 自动反映。
// currentDials = 当前工具的 dial（按 editMode 当前工具取，shapes/airbrush alias 到 brush）。
// wp:adjsize = 键盘 [ ] 调粗（tool-aware，max 从活动预设取，段量化）。
//
// editMode 用 thunk：setSize 要早于 leftDial 构造可用，而 editMode const 晚于 leftDial 才声明
// （与 brush-rack 构造里的 editMode:()=>editMode 同款）。board/leftDial 也晚 → bindKeyboard 分离调。

import { safeLSSet } from "./safe-ls.ts";
import { stepFor, quantizeSize } from "./ui/brush-size.ts";

export function makeDialControls({ state, rack, getEditMode }: any) {
  const setSize = (v: number) => {
    v = Math.max(1, Math.round(v));        // clamp to int
    rack.writeCurrentToolSize(v);          // dial SSoT（反应式 → currentBrush + <LeftDial> 自动跟随）
    safeLSSet("webpaint.size", String(v));
  };
  const setOpacity = (v: number) => {
    rack.writeCurrentToolOpacity(v);       // dial SSoT（反应式）
    safeLSSet("webpaint.opacity", String(v));
  };
  const currentDials = () => state.toolStates[rack.getRackToolKey(getEditMode().current())] || state.toolStates.brush;

  // 键盘 [ ] 调粗（v132 tool-aware dispatch）。max 从活动预设取；段量化（20内1/50内2/100内5/200内10/500内20/1000内50）。
  const bindKeyboard = ({ board, leftDial }: any) => {
    window.addEventListener("wp:adjsize", (e: any) => {
      const t = getEditMode().current();
      if (t === "brush" || t === "eraser" || t === "smudge" || t === "filterBrush") {
        const maxPx = rack.findToolBrushPure(currentDials())?.size?.max || 200;
        const dir = Math.sign(e.detail) || 1;
        const curSize = currentDials().size;
        const next = Math.max(1, Math.min(maxPx, quantizeSize(curSize + dir * stepFor(curSize))));
        setSize(next);
        leftDial.flashSize();   // 闪 size popup（组件自持）
        if (board._cursor) board.setCursor({ ...board._cursor, size: next });
      }
      // 其他工具忽略（液化已 migrate 进 filterBrush）
    });
  };

  return { setSize, setOpacity, currentDials, bindKeyboard };
}
