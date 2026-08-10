export type FilterParams = Record<string, unknown>;
export interface Filter {
    id: string;
    title: string;
    category?: string;
    modes?: string[];
    bleedRadius?(params: FilterParams): number;
    defaults?(): FilterParams;
    buildBody?(container: HTMLElement, state: unknown, onChange: () => void): void;
    bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, params: FilterParams, mask: Uint8Array | null, w: number, h: number): void;
    beginBrushStroke?(layer: BrushLayer, params: FilterParams, brushSettings: BrushSettings, selection: BrushSelection | null, x: number, y: number, p: number): ColorBrushState;
    extendBrushStamp?(state: ColorBrushState, x: number, y: number, p: number): void;
    endBrushStroke?(state: ColorBrushState): void;
    flushDirty?(state: ColorBrushState): DirtyRect | null;
}
export interface BrushLayer {
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    getImageData(docX: number, docY: number, w: number, h: number): ImageData;
    putImageData(docX: number, docY: number, img: ImageData): void;
}
export interface BrushSettings {
    size: number;
    spacingValue?: number;
    hardness?: number;
    flow?: number;
    opacity?: number;
}
export interface BrushSelection {
    bboxX: number;
    bboxY: number;
    materializeMaskRegion(x0: number, y0: number, w: number, h: number): Uint8Array;
}
export type DirtyRect = [number, number, number, number];
export interface ColorBrushState {
    layer: BrushLayer;
    params: FilterParams;
    brushSettings: BrushSettings;
    selection: BrushSelection | null;
    FilterClass: Filter;
    lastX: number;
    lastY: number;
    pendingDist: number;
    dirty: DirtyRect | null;
}
export declare function registerFilter(FilterClass: Filter): void;
export declare function getFilter(id: string): Filter | null;
export declare function listFilters(): Filter[];
export declare function onFilterRegistered(fn: (item: Filter) => void): () => void;
export declare function clamp8(v: number): number;
export interface SliderRowOpts {
    fmt?: (value: number) => string;
    gradient?: string;
}
export declare function makeSliderRow(label: string, key: string, min: number, max: number, step: number, init: number, onChange: (key: string, value: number) => void, opts?: SliderRowOpts): HTMLLabelElement;
export declare function makeSectionTitle(text: string): HTMLDivElement;
export declare function attachColorBrushBehavior(FilterClass: Filter): void;
export interface SelectOption {
    value: string;
    label: string;
}
export declare function makeSelectRow(label: string, key: string, options: SelectOption[], init: string, onChange: (key: string, value: string) => void): HTMLLabelElement;
