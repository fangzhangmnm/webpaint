export declare function setOraLogReporter(fn: (msg: string) => void): void;
import type { PaintingData } from "./workpiece/painting-workpiece.ts";
export interface EncodeLeaf {
    isGroup: false;
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha: boolean;
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    getImageData(x: number, y: number, w: number, h: number): ImageData;
}
export interface EncodeGroup {
    isGroup: true;
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    children: EncodeNode[];
}
export type EncodeNode = EncodeLeaf | EncodeGroup;
type EncodeDoc = {
    width: number;
    height: number;
    layers: readonly EncodeNode[];
    activeId: number | null;
    referenceLayerId: number | null;
};
/** exportData 冻结快照 → encode 消费面（保存路径的 freezeDocForEncode 后继；bytes 已当场拷出，
 *  getImageData = 纯切片，无 canvas、无追写风险）。 */
export declare function paintingDataToEncodeDoc(data: PaintingData): EncodeDoc;
interface EncodeOpts {
    wroteWith: string;
    mergedBytes?: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null;
    referenceImage?: Blob;
    desk?: object;
    timelapse?: {
        json: string;
        mp4: Uint8Array;
    } | null;
}
export interface DecodedPainting {
    data: PaintingData;
    _referenceBlob?: Blob;
    _webpaintState?: unknown;
    _editorState?: unknown;
    _timelapseJson?: string;
    _timelapseMp4?: Uint8Array;
    _wroteWith: string | null;
}
/** doc → Blob (.ora)
 *
 * WebPaint 私有扩展（都在 webpaint/ 命名空间下，第三方 reader 会忽略或剥离）：
 *   webpaint/reference.png     — ref 小窗当前显示的图（原 Blob bytes）
 *   .webpaint/editor-state.json — desk struct（desk per-doc；含 toolDials/palette/blender 三组）
 *   （旧轨 webpaint/state.json **v0.8.21 起停写**——ADR-0008 §9；decode 读兼容保留存量，拔除另议）
 *
 * opts.referenceImage: optional Blob
 */
export declare function encodeDocToOra(doc: EncodeDoc, opts: EncodeOpts): Promise<any>;
/** Blob (.ora 明文) → DecodedPainting（json 形 + 内联 tile 字节 + sidecar）。 */
export declare function decodeOraToPainting(blob: Blob): Promise<DecodedPainting>;
export declare function parseAppVersion(s: string | null | undefined): number | null;
export {};
