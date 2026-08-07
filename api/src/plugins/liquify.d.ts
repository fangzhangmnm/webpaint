import type { FilterParams, BrushLayer, BrushSettings, BrushSelection, DirtyRect } from "../filters.ts";
import { LiquifyEngine } from "./liquify-engine.ts";
interface LiquifyBrushState {
    engine: LiquifyEngine;
}
export declare class LiquifyFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(p: FilterParams): number;
    static defaults(): {
        mode: string;
    };
    static brushVariants: {
        id: string;
        title: string;
        params: {
            mode: string;
            strengthScale: number;
        };
    }[];
    static boundaryModes: {
        id: string;
        title: string;
    }[];
    static sampleModes: boolean;
    static beginBrushStroke(layer: BrushLayer, params: FilterParams, brushSettings: BrushSettings, selection: BrushSelection | null, x: number, y: number, pressure: number): LiquifyBrushState;
    static extendBrushStamp(state: LiquifyBrushState, x: number, y: number, _pressure: number): void;
    static endBrushStroke(state: LiquifyBrushState): void;
    static cancelBrushStroke(state: LiquifyBrushState): void;
    static flushDirty(state: LiquifyBrushState): DirtyRect | null;
}
export {};
