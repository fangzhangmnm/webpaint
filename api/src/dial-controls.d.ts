import type { EditorRuntimeState } from "./app-context.ts";
import type { BrushRackController } from "./brush-rack-controller.ts";
import type { EditMode } from "./edit-mode.ts";
import type { Board } from "./board.ts";
interface DialControlsDeps {
    state: EditorRuntimeState;
    rack: BrushRackController;
    getEditMode: () => EditMode;
}
interface DialKeyboardDeps {
    board: Board;
    leftDial: {
        flashSize: () => void;
    };
}
export declare function makeDialControls({ state, rack, getEditMode }: DialControlsDeps): {
    setSize: (v: number) => void;
    setOpacity: (v: number) => void;
    currentDials: () => import("./app-context.ts").ToolDial;
    bindKeyboard: ({ board, leftDial }: DialKeyboardDeps) => (() => void);
};
export {};
