export interface BrushSize {
    base: number;
    max?: number;
}
export interface BrushShape {
    kind?: string;
    aspect?: number;
    rotation?: number;
    hardness?: number;
}
export interface BrushTaper {
    in?: number;
    out?: number;
}
export interface BrushSmooth {
    streamline?: number;
    stabilization?: number;
}
export interface Brush {
    id: string;
    name: string;
    tool: string;
    folder?: string;
    size: BrushSize;
    shape?: BrushShape;
    sizeCoeff?: number;
    opaCoeff?: number;
    flowCoeff?: number;
    pressureGamma?: number;
    pressureLPF?: number;
    defaultOpa?: number;
    compositeMode?: string;
    blendMode?: string;
    spacing?: number | {
        value?: number;
    };
    pixelMode?: boolean;
    taper?: BrushTaper;
    smooth?: BrushSmooth;
    creation_time?: number;
    [k: string]: unknown;
}
export interface BrushRackData {
    version?: number;
    brushes: Brush[];
    [k: string]: unknown;
}
