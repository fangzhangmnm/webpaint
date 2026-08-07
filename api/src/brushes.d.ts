import type { Brush, BrushRackData } from "./brush-types.ts";
export interface BrushInitItem {
    id: string;
    value: unknown;
}
export declare const RACK_META_ID = ".meta";
export interface RackMeta {
    folderOrder: string[];
    order: Record<string, string[]>;
}
interface MakeBrushArgs {
    id?: string;
    name: string;
    tool: string;
    folder?: string;
    size?: number;
    sizeBaseMax?: number;
    sizeCoeff?: number;
    opaCoeff?: number;
    flowCoeff?: number;
    pressureGamma?: number;
    pressureLPF?: number;
    compositeMode?: string;
    blendMode?: string;
    shapeKind?: string;
    aspect?: number;
    rotation?: number;
    hardness?: number;
    spacingValue?: number;
    pixelMode?: boolean;
    taperIn?: number;
    taperOut?: number;
    streamline?: number;
    stabilization?: number;
    defaultOpa?: number;
}
interface LegacyBrush {
    size?: BrushSizeLegacy;
    flow?: {
        min?: number;
        pressureCurve?: number;
        base?: number;
    };
    spacing?: {
        kind?: string;
        value?: number;
    } | number;
    [k: string]: any;
}
interface BrushSizeLegacy {
    base?: number;
    max?: number;
    min?: number;
    pressureCurve?: number;
}
export declare const DEFAULT_FOLDER = "\u6211\u7684\u5E38\u7528";
export declare function newBrushId(): string;
export declare function makeBrush({ id, name, tool, folder, size, sizeBaseMax, sizeCoeff, opaCoeff, flowCoeff, pressureGamma, pressureLPF, // v416 四处统一 50（此前这里是 0，导致**新建笔**没有压感 LPF，而出厂笔/UI 默认都是 50）
compositeMode, blendMode, // v163: per-brush 混合模式（multiply/screen/... ＝ Canvas2D globalCompositeOperation）
shapeKind, aspect, rotation, hardness, // 与 DEFAULT_CONFIG / ensureBrushConfigDefaults / resolveBrush 统一（v415：此前三处 0.75/1.0/1.0 各说各话）
spacingValue, pixelMode, taperIn, taperOut, streamline, stabilization, defaultOpa, }: MakeBrushArgs): Brush;
export declare function loadBuiltinBrushes(): Promise<Brush[] | null>;
export declare function builtinBrushes(): Promise<Brush[]>;
export declare function emptyMeta(): RackMeta;
export declare function metaAppend(meta: RackMeta, folder: string, id: string): RackMeta;
export declare function metaRemove(meta: RackMeta, id: string): RackMeta;
export declare function metaMove(meta: RackMeta, id: string, toFolder: string): RackMeta;
export declare function metaPrependBuiltins(meta: RackMeta, builtinsByFolder: Record<string, string[]>): RackMeta;
export declare function buildInitMeta(brushes: Brush[]): RackMeta;
export declare function builtinBrushInitData(): Promise<BrushInitItem[]>;
export interface CollectionLike {
    entries(): {
        id: string;
        value: unknown;
    }[];
    getItem(id: string, def?: unknown): unknown;
}
export declare function orderBrushesByMeta(brushes: Brush[], meta: RackMeta): Brush[];
export declare function getAllBrushes(coll: CollectionLike): Brush[];
export declare function getMeta(coll: CollectionLike): RackMeta;
export declare function migrateBrush(b: LegacyBrush): LegacyBrush;
export declare function brushToJSON(brush: Brush): string;
export declare function brushFromJSON(text: string): LegacyBrush;
export declare function findBrush(rack: BrushRackData, id: string): Brush | null;
export declare function brushesByTool(rack: BrushRackData, tool: string): Brush[];
export declare function defaultBrushForTool(rack: BrushRackData, tool: string): Brush | null;
export {};
