import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";
import type { LayerTiles, Rect } from "./layer-tiles.ts";
export interface TreeLeaf {
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha: boolean;
    pixelsRef: number;
}
export interface TreeGroup {
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    children: TreeNode[];
}
export type TreeNode = TreeLeaf | TreeGroup;
export interface TreeJson {
    nodes: TreeNode[];
    activeId: number | null;
    referenceLayerId: number | null;
    backgroundColor: string;
    width: number;
    height: number;
}
export declare const isGroupNode: (n: TreeNode) => n is TreeGroup;
export type LayerPropKey = "name" | "visible" | "opacity" | "mode" | "clippingMask" | "lockAlpha";
export declare class LayerTree2 implements CollectorComponent {
    readonly kind = "layerTree";
    private _wp;
    private _tiles;
    private _json;
    private _collectedRoot;
    private _nextId;
    private _maxLeaves;
    constructor(deps: {
        wp: Workpiece;
        tiles: LayerTiles;
        initial: TreeJson;
        maxLeaves?: () => number;
    });
    /** 不可变值约定：发出去的引用永不被改（每次写换新根）。 */
    view(): Readonly<TreeJson>;
    nodeById(id: number | null): TreeNode | null;
    leafById(id: number | null): TreeLeaf | null;
    countLeaves(): number;
    eachLeaf(cb: (leaf: TreeLeaf) => void): void;
    /** 插到 active 同级上方（无 active → 顶层最上）；active = 新层。null = 已到 maxLeaves。 */
    addLayer(name?: string): TreeLeaf | null;
    /** 新建**空**组（v1 addGroup 语义）：active 是组 → 嵌进去；否则同级之上。active = 新组。
     *  组不计 maxLeaves（只数叶）。 */
    addGroup(name?: string): TreeGroup | null;
    /** 换整根（load 的令牌写；ADR-0008：解码器产 plain data 灌入）。
     *  调用方负责新根 tileset 的净移交（createTileset 后 release）；旧根照常进 collector/record，
     *  load 收尾清栈时旧 doc 资源随 record 驱逐释放。nextId 重播种。 */
    loadRoot(json: TreeJson): void;
    /** 复制叶（props 原样、tileset 句柄共享零拷贝）；插到源上方，active = 副本。null = maxLeaves/源不在。 */
    duplicateLayer(id: number): TreeLeaf | null;
    /** 删叶（keep-one 守卫：最后一叶不删）。active 被删 → 就近换（下方优先）。 */
    removeLayer(id: number): boolean;
    /** 删组连带 children；删空补一叶。 */
    removeGroupAndFillEmpty(id: number): boolean;
    /** 解组：children 提到原位（顺序保持）。 */
    explodeGroupInPlace(id: number): boolean;
    /** 同级移动 delta（越界 → false 不动）。 */
    moveLayer(id: number, delta: number): boolean;
    /** 移入组（放组内最上）。组不存在/自嵌套 → false。 */
    moveIntoGroup(id: number, gid: number): boolean;
    /** 移出组：提到组的同级、组上方。不在组内 → false。 */
    moveOutOfGroup(id: number): boolean;
    /** 向下合并：合成字节外部烤好递入（零 GL）。under 归一化（opacity=1/source-over/resultClipping）、
     *  top 移除、active=under。守卫：同级正下方必须是叶、under 剪裁而 top 不剪 → false（语义不清）。 */
    mergeDown(id: number, merged: {
        bytes: Uint8ClampedArray;
        rect: Rect;
        resultClipping: boolean;
    }): boolean;
    setLayerProp(id: number, prop: LayerPropKey, value: unknown): boolean;
    /** 元规则相同才合并动词（提案 .h）：doc 级 unique 值。 */
    setTreeProp(key: "referenceLayerId" | "backgroundColor", value: number | null | string): void;
    /** 唯一不记账 verb（焦点=导航）：无需令牌、不收集；换根共享 nodes（records 不受扰）。 */
    setActive(id: number): boolean;
    sealRecord(): RecordData | null;
    swapRecord(data: RecordData): RecordData;
    recordBytes(data: RecordData): number;
    disposeRecord(data: RecordData): void;
    private _swapRoot;
    private _acquireRoot;
    private _releaseRoot;
    private _eachNode;
    private _contains;
    private _clone;
    /** 定位 id 所在的 children 数组（parentGroup=null 表示顶层）。 */
    private _locate;
    /** 删除位置的就近叶（同级下方优先，其次上方，再全树第一叶）。 */
    private _nearestLeafId;
}
