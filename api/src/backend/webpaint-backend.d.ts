import { History } from "./workpiece/history.ts";
import { PaintingWorkpiece, type PaintingData, type PaintingDataNode } from "./workpiece/painting-workpiece.ts";
import { PaintingView } from "./workpiece/painting-view.ts";
import { LayersFace } from "./layers-face.ts";
import { type RgbaPlane } from "./png-codec.ts";
import type { WebPaintBackendInterface, BackendLayerNode, BackendDocInfo, BackendChangeEvent, BackendOpResult, BackendAddResult, ResolvedBrushSnapshot, StrokeId, FilterSessionId } from "./webpaint-backend-interface.ts";
export interface BackendInject {
    appVersion?: string;
    jpgEncoder?: (plane: RgbaPlane) => Promise<Uint8Array>;
    imageDecoder?: (bytes: Uint8Array) => Promise<RgbaPlane>;
}
export interface BackendOpenResult {
    backend: WebPaintBackend;
    /** open 解出的壳 sidecar（backend 不解释，原样交壳）。 */
    sidecar: {
        editorState?: unknown;
        legacyState?: unknown;
        referencePng?: Uint8Array;
        wroteWith: string | null;
    };
}
export declare class WebPaintBackend implements WebPaintBackendInterface {
    private _history;
    private _wp2;
    private _view;
    private _layers;
    private _inject;
    private _disposed;
    private _listeners;
    /** 进程内协作面（壳迁移期/测试直取引擎；embedding/MCP 只走接口方法——序列化墙那侧不存在这些）。 */
    get wp2(): PaintingWorkpiece;
    get view(): PaintingView;
    get layersFace(): LayersFace;
    get history(): History;
    private constructor();
    static blank(meta: {
        width: number;
        height: number;
        backgroundColor?: string;
    }, inject?: BackendInject): WebPaintBackend;
    /** 魔数嗅探：zip→ora、8BPS→psd（后棒）、png→UPNG 单图成层、其余→注入解码器单图成层。 */
    static open(bytes: Uint8Array, inject?: BackendInject): Promise<BackendOpenResult>;
    get disposed(): boolean;
    dispose(): void;
    private _guard;
    encodeOra(opts?: {
        editorSidecar?: object;
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
    strokeBegin(_leafId: number, _brush: ResolvedBrushSnapshot): StrokeId;
    strokeAppend(_id: StrokeId, _points: Float32Array): void;
    strokeEnd(_id: StrokeId): boolean;
    strokeCancel(_id: StrokeId): void;
    filterBegin(_leafId: number, _filterId: string): FilterSessionId;
    filterSetParams(_id: FilterSessionId, _params: Record<string, unknown>): void;
    filterCommit(_id: FilterSessionId): boolean;
    filterCancel(_id: FilterSessionId): void;
    onChange(cb: (ev: BackendChangeEvent) => void): () => void;
    private _emit;
}
export type { PaintingData, PaintingDataNode };
