import type { FilterParams } from "../filters.ts";
interface HsbParams extends FilterParams {
    brightness: number;
    contrast: number;
    saturation: number;
    hue: number;
    satMode: string;
}
interface HsbState {
    params: HsbParams;
}
export declare class HsbFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(): number;
    static defaults(): {
        brightness: number;
        contrast: number;
        saturation: number;
        hue: number;
        satMode: string;
    };
    static buildBody(container: HTMLElement, state: HsbState, onChange: () => void): void;
    static bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, p: HsbParams, mask: Uint8Array | null): void;
}
export {};
