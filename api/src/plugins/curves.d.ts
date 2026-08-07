import type { FilterParams } from "../filters.ts";
type Point = [number, number];
interface CurvesParams extends FilterParams {
    active: string;
    comp: Point[];
    r: Point[];
    g: Point[];
    b: Point[];
    a: Point[];
}
interface CurvesBuildState {
    params: CurvesParams;
}
export declare class CurvesFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(): number;
    static defaults(): CurvesParams;
    static _buildLut(points: Point[]): Uint8Array;
    static buildBody(container: HTMLElement, state: CurvesBuildState, onChange: () => void): void;
    static bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, p: CurvesParams, mask: Uint8Array | null): void;
}
export {};
