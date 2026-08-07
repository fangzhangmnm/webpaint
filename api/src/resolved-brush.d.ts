import type { EditorRuntimeState, DialReactive } from "./app-context.ts";
import type { BrushRackController } from "./brush-rack-controller.ts";
export interface BrushPreset {
    shape?: {
        kind?: string;
        aspect?: number;
        rotation?: number;
        hardness?: number;
    };
    taper?: {
        in?: number;
        out?: number;
    };
    taperFloor?: number;
    sizeCoeff?: number;
    opaCoeff?: number;
    flowCoeff?: number;
    pressureGamma?: number;
    pressureLPF?: number;
    compositeMode?: string;
    blendMode?: string;
    spacing?: number | {
        value?: number;
    };
    pixelMode?: boolean;
    smooth?: {
        streamline?: number;
        stabilization?: number;
    };
}
export interface ResolvedBrush {
    size: number;
    opacity: number;
    flow: number;
    color: string;
    shapeKind: string;
    shapeAspect: number;
    shapeRotation: number;
    hardness: number;
    taperIn: number;
    taperOut: number;
    taperFloor: number;
    sizeCoeff: number;
    opaCoeff: number;
    flowCoeff: number;
    pressureGamma: number;
    pressureLPF: number;
    compositeMode: string;
    blendMode: string;
    spacing: number;
    pixelMode: boolean;
    streamline: number;
    stabilization: number;
    [k: string]: unknown;
}
export interface ResolveBrushArgs {
    preset?: BrushPreset | null;
    size?: number;
    opacity?: number;
    color?: string;
}
export declare function resolveBrush({ preset, size, opacity, color, }?: ResolveBrushArgs): ResolvedBrush;
interface CurrentBrushDeps {
    state: EditorRuntimeState;
    dialReactive: DialReactive;
    rack: BrushRackController;
}
export declare function makeCurrentBrush({ state, dialReactive, rack }: CurrentBrushDeps): {
    currentBrush: import("../vendor/vue/vue.esm-browser.prod.js").ComputedRef<ResolvedBrush>;
};
export {};
