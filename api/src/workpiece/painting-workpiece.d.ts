import { Workpiece, type WorkpieceOpts, type CollectorComponent } from "./workpiece2.ts";
import { LayerTiles, type TilesHost, type Rect } from "./layer-tiles.ts";
import { LayerTree2 } from "./layer-tree2.ts";
export interface PaintingDataLeaf {
    id?: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha: boolean;
    pixels: {
        rect: Rect;
        bytes: Uint8ClampedArray;
    } | null;
}
export interface PaintingDataGroup {
    id?: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    children: PaintingDataNode[];
}
export type PaintingDataNode = PaintingDataLeaf | PaintingDataGroup;
export interface PaintingData {
    width: number;
    height: number;
    backgroundColor?: string;
    activeId?: number | null;
    referenceLayerId?: number | null;
    nodes: PaintingDataNode[];
}
export declare class PaintingWorkpiece extends Workpiece {
    readonly layerTiles: LayerTiles;
    readonly layerTree: LayerTree2 | null;
    constructor(opts: WorkpieceOpts & {
        host?: TilesHost;
        tree?: {
            width: number;
            height: number;
            maxLeaves?: () => number;
        };
        legacy?: CollectorComponent;
    });
    /** 装载（杀 docRaw/adoptState 的后继）：令牌灌入 → 清栈 → markSaved。 */
    load(data: PaintingData): void;
    /** 编码器读口：冻结快照（bytes 当场拷出；空叶 pixels=null）。 */
    exportData(): PaintingData;
    private _requireTree;
    private _buildNodes;
}
