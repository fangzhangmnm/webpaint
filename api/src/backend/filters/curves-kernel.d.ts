import { type FilterKernel, type FilterParams } from "./kernel.ts";
export type CurvePoint = [number, number];
export interface CurvesParams extends FilterParams {
    active: string;
    comp: CurvePoint[];
    r: CurvePoint[];
    g: CurvePoint[];
    b: CurvePoint[];
    a: CurvePoint[];
}
export declare function buildCurveLut(points: CurvePoint[]): Uint8Array;
export declare const CurvesKernel: FilterKernel;
