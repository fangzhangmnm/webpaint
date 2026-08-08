import { Workpiece, type WorkpieceOpts, type CollectorComponent } from "./workpiece2.ts";
import { LayerTiles, type TilesHost, type Rect } from "./layer-tiles.ts";
import { LayerTree2 } from "./layer-tree2.ts";
import { SelectionComponent } from "./selection-component.ts";
import { FloatLayerComponent } from "./float-component.ts";
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
    readonly selection: SelectionComponent;
    readonly floatLayer: FloatLayerComponent;
    constructor(opts: WorkpieceOpts & {
        host?: TilesHost;
        tree?: {
            width: number;
            height: number;
            maxLeaves?: () => number;
        };
        legacy?: CollectorComponent;
    });
    /** 迁移期后装 legacy 桥组件（T5 拆）：组合根的构造环解法——legacyOps 需要 v1 workpiece，
     *  v1 需要 PaintingView 端口，端口需要本工件 → 桥组件只能在本工件建成后注册。 */
    attachLegacy(c: CollectorComponent): void;
    /** 装载（杀 docRaw/adoptState 的后继）：令牌灌入 → 清栈 → markSaved。 */
    load(data: PaintingData): void;
    /** 编码器读口：冻结快照（bytes 当场拷出；空叶 pixels=null）。 */
    exportData(): PaintingData;
    private _requireTree;
    private _buildNodes;
}
