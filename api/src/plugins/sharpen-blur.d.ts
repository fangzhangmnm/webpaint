import type { FilterParams } from "../filters.ts";
export declare class SharpenBlurFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static brushVariants: {
        id: string;
        title: string;
        params: {
            amount: number;
        };
    }[];
    static bleedRadius(p: FilterParams): number;
    static defaults(): {
        amount: number;
    };
    static buildBody(container: HTMLElement, state: unknown, onChange: () => void): void;
    static bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, p: FilterParams, mask: Uint8Array | null, w: number, h: number): void;
    static _gaussianBlur3(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number): void;
    static _boxBlur3(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, mask: Uint8Array | null): void;
}
