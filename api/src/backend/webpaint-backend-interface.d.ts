export interface BackendLayerNode {
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha?: boolean;
    children?: BackendLayerNode[];
}
export interface BackendDocInfo {
    width: number;
    height: number;
    backgroundColor: string;
    activeId: number | null;
    referenceLayerId: number | null;
    layerCount: number;
}
export interface BackendChangeEvent {
    canUndo: boolean;
    canRedo: boolean;
    isDirty: boolean;
}
export type BackendOpResult = {
    ok: true;
} | {
    ok: false;
    msg?: string;
};
export type BackendAddResult = {
    ok: true;
    id: number;
} | {
    ok: false;
    msg?: string;
};
export type StrokeId = number;
export type FilterSessionId = number;
/** ResolvedBrush 快照（begin 冻结一笔；画一半动笔=下一笔生效）。C8 钉细：**扁平 ResolvedBrush
 *  字段**（common/resolved-brush.ts，全标量）+ 可选 `mode: "brush" | "erase"`（缺省 brush）；
 *  缺字段一律 DEFAULT_CONFIG 兜底（common/current-brush-config.ts——MCP 只传 {size,color} 也出
 *  完整可画的笔）。平滑推导在 backend 内（streamline/stabilization × SMOOTH_DEFAULTS 常数，
 *  deadzone 单位 doc px）——同一快照+同一 (x,y,p,t) 序列 → 同一输出（ADR-0009 决定论）。 */
export type ResolvedBrushSnapshot = Record<string, unknown>;
export interface WebPaintBackendInterface {
    dispose(): void;
    readonly disposed: boolean;
    encodeOra(opts?: {
        /** 壳 sidecar（不透明携带，backend 不解释）：desk struct → .webpaint/editor-state.json。 */
        editorSidecar?: object;
        /** 参考窗图 bytes → webpaint/reference.png。 */
        referencePng?: Uint8Array;
    }): Promise<Uint8Array>;
    exportImage(fmt: "png" | "jpg"): Promise<Uint8Array>;
    docInfo(): BackendDocInfo;
    layerTree(): BackendLayerNode[];
    isDirty(): boolean;
    markSaved(): void;
    layerAdd(name?: string): BackendAddResult;
    layerDuplicate(id: number): BackendAddResult;
    layerRemove(id: number): BackendOpResult;
    layerMove(id: number, delta: number): BackendOpResult;
    layerMergeDown(id: number): BackendOpResult;
    layerSetProp(id: number, prop: "name" | "visible" | "opacity" | "mode" | "clippingMask" | "lockAlpha", value: string | number | boolean): BackendOpResult;
    layerSetActive(id: number): boolean;
    layerClear(id: number): BackendOpResult;
    setReferenceLayer(id: number | null): BackendOpResult;
    undo(): boolean;
    redo(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    strokeBegin(leafId: number, brush: ResolvedBrushSnapshot): StrokeId;
    strokeAppend(id: StrokeId, points: Float32Array): void;
    strokeEnd(id: StrokeId): boolean;
    strokeCancel(id: StrokeId): void;
    filterBegin(leafId: number, filterId: string): FilterSessionId;
    filterSetParams(id: FilterSessionId, params: Record<string, unknown>): void;
    filterCommit(id: FilterSessionId): boolean;
    filterCancel(id: FilterSessionId): void;
    onChange(cb: (ev: BackendChangeEvent) => void): () => void;
}
