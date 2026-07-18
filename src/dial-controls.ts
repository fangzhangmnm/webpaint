// dial-controls.ts —— 工具 dial（toolStates）的程序化 + 键盘写入（从组合根 app.js 下沉，survey rec #3）。
//
// setSize/setOpacity = 写当前工具 dial SSoT（rack.writeCurrentTool*）+ LS 持久化；<LeftDial> 绑 dial 自动反映。
// currentDials = 当前工具的 dial（按 editMode 当前工具取，shapes/airbrush alias 到 brush）。
// wp:adjsize = 键盘 [ ] 调粗（tool-aware，max 从活动预设取，段量化）。
//
// editMode 用 thunk：setSize 要早于 leftDial 构造可用，而 editMode const 晚于 leftDial 才声明
// （与 brush-rack 构造里的 editMode:()=>editMode 同款）。board/leftDial 也晚 → bindKeyboard 分离调。

import { stepFor, quantizeSize } from "./ui/brush-size.ts";
import { editorState } from "./editor-state.ts";   // brush dial → editorState.brushTool SSoT（binding 写反应式）
import type { EditorRuntimeState } from "./app-context.ts";
import type { BrushRackController } from "./brush-rack-controller.ts";
import type { EditMode } from "./edit-mode.ts";
import type { Board } from "./board.ts";

interface DialControlsDeps { state: EditorRuntimeState; rack: BrushRackController; getEditMode: () => EditMode; }
interface DialKeyboardDeps { board: Board; leftDial: { flashSize: () => void }; }

export function makeDialControls({ state, rack, getEditMode }: DialControlsDeps) {
  // brush 工具的 size/opacity 归 editorState.brushTool SSoT（per-doc；desk 不标脏，见 editor-state.ts:117）；其他工具 dial（eraser/filterBrush）
  //   未进 editorState（留下一轮）→ 仍走 rack.writeCurrentTool*。editorState.brushTool.size 经 binding 写同一 reactive dial，
  //   与 writeCurrentToolSize（ts.size=v）等价 + 额外标脏。删 webpaint.size/opacity 设备级 LS 种子。
  const isBrushTool = () => rack.getRackToolKey(getEditMode().current()) === "brush";
  const setSize = (v: number) => {
    v = Math.max(1, Math.round(v));        // clamp to int
    if (isBrushTool()) editorState.brushTool.size = v;
    else rack.writeCurrentToolSize(v);     // 反应式 → currentBrush + <LeftDial> 自动跟随
  };
  const setOpacity = (v: number) => {
    if (isBrushTool()) editorState.brushTool.opacity = v;
    else rack.writeCurrentToolOpacity(v);
  };
  const currentDials = () => state.toolStates[rack.getRackToolKey(getEditMode().current())] || state.toolStates.brush;

  // 键盘 [ ] 调粗（v132 tool-aware dispatch）。max 从活动预设取；段量化（20内1/50内2/100内5/200内10/500内20/1000内50）。
  //   返回 disposer（真 app 调一次无所谓；测试 + 防泄漏用）。
  const bindKeyboard = ({ board, leftDial }: DialKeyboardDeps): (() => void) => {
    const handler = (e: Event) => {
      const t = getEditMode().current();
      if (t === "brush" || t === "eraser" || t === "filterBrush") {
        const maxPx = rack.findToolBrushPure(currentDials())?.size?.max || 200;
        const dir = Math.sign((e as CustomEvent<number>).detail) || 1;
        const curSize = currentDials().size;
        const next = Math.max(1, Math.min(maxPx, quantizeSize(curSize + dir * stepFor(curSize))));
        setSize(next);
        leftDial.flashSize();   // 闪 size popup（组件自持）
        if (board._cursor) board.setCursor({ ...board._cursor, size: next });
      }
      // 其他工具忽略（液化已 migrate 进 filterBrush）
    };
    window.addEventListener("wp:adjsize", handler);
    return () => window.removeEventListener("wp:adjsize", handler);
  };

  return { setSize, setOpacity, currentDials, bindKeyboard };
}
