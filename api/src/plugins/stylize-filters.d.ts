interface FilterBuildState {
    params: Record<string, unknown>;
}
export declare class MosaicFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius: (params: import("../filters.ts").FilterParams | null) => number;
    static defaults: () => import("../filters.ts").FilterParams;
    static bake: (src: Uint8ClampedArray, dst: Uint8ClampedArray, params: import("../filters.ts").FilterParams, mask: Uint8Array | null, w: number, h: number) => void;
    static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void): void;
}
export declare class HalftoneFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius: (params: import("../filters.ts").FilterParams | null) => number;
    static defaults: () => import("../filters.ts").FilterParams;
    static bake: (src: Uint8ClampedArray, dst: Uint8ClampedArray, params: import("../filters.ts").FilterParams, mask: Uint8Array | null, w: number, h: number) => void;
    static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void): void;
}
export declare class StainedGlassFilter {
    static id: string;
    static title: string;
    static category: string;
    static modes: string[];
    static bleedRadius: (params: import("../filters.ts").FilterParams | null) => number;
    static defaults: () => import("../filters.ts").FilterParams;
    static bake: (src: Uint8ClampedArray, dst: Uint8ClampedArray, params: import("../filters.ts").FilterParams, mask: Uint8Array | null, w: number, h: number) => void;
    static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void): void;
}
export {};
