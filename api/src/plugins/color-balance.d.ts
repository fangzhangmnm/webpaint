import { type ColorBalanceParams } from "../backend/filters/color-balance-kernel.ts";
interface ColorBalanceState {
    params: ColorBalanceParams;
}
export declare class ColorBalanceFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius: (params: import("../filters.ts").FilterParams | null) => number;
    static defaults: () => import("../filters.ts").FilterParams;
    static bake: (src: Uint8ClampedArray, dst: Uint8ClampedArray, params: import("../filters.ts").FilterParams, mask: Uint8Array | null, w: number, h: number) => void;
    static buildBody(container: HTMLElement, state: ColorBalanceState, onChange: () => void): void;
}
export {};
