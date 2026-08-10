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
/** ResolvedBrush 快照（begin 冻结一笔；画一半动笔=下一笔生效）。C7 先按不透明 JSON-able 对象
 *  过墙（真形状 = resolved-brush.ts ResolvedBrush，全标量已满足纪律；C8 接通引擎时钉细）。 */
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
