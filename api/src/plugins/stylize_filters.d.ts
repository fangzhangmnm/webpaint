import type { FilterParams } from "../filters.ts";
interface FilterBuildState {
    params: Record<string, unknown>;
}
export declare class MosaicFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(): number;
    static defaults(): {
        cellSize: number;
    };
    static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void): void;
    static bake(src: Uint8ClampedArray, dst: Uint8ClampedArray, p: {
        cellSize: number;
    }, mask: Uint8Array | null, w: number, h: number): void;
}
export declare class HalftoneFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(): number;
    static defaults(): {
        cellSize: number;
        dotScale: number;
        mode: string;
    };
    static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void): void;
    static bake(src: Uint8ClampedArray, dst: Uint8ClampedArray, p: {
        cellSize: number;
        dotScale: number;
        mode: string;
    }, mask: Uint8Array | null, w: number, h: number): void;
}
export declare class StainedGlassFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius(p: FilterParams | null): number;
    static defaults(): {
        cellSize: number;
        leadWidth: number;
    };
    static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void): void;
    static bake(src: Uint8ClampedArray, dst: Uint8ClampedArray, p: {
        cellSize: number;
        leadWidth: number;
    }, mask: Uint8Array | null, w: number, h: number): void;
}
export {};
