import type { EditorRuntimeState, DialReactive } from "./app-context.ts";
import type { BrushRackController } from "./brush-rack-controller.ts";
export { resolveBrush } from "./common/resolved-brush.ts";
export type { ResolvedBrush, BrushPreset, ResolveBrushArgs } from "./common/resolved-brush.ts";
interface CurrentBrushDeps {
    state: EditorRuntimeState;
    dialReactive: DialReactive;
    rack: BrushRackController;
}
export declare function makeCurrentBrush({ state, dialReactive, rack }: CurrentBrushDeps): {
    currentBrush: import("../vendor/vue/vue.esm-browser.prod.js").ComputedRef<import("./resolved-brush.ts").ResolvedBrush>;
};
