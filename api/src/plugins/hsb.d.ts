import { type HsbParams } from "../backend/filters/hsb-kernel.ts";
interface HsbState {
    params: HsbParams;
}
export declare class HsbFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius: (params: import("../filters.ts").FilterParams | null) => number;
    static defaults: () => import("../filters.ts").FilterParams;
    static bake: (src: Uint8ClampedArray, dst: Uint8ClampedArray, params: import("../filters.ts").FilterParams, mask: Uint8Array | null, w: number, h: number) => void;
    static buildBody(container: HTMLElement, state: HsbState, onChange: () => void): void;
}
export {};
