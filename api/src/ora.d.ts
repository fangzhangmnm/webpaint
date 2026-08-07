import { PaintDoc } from "./doc.ts";
import type { FrozenNode } from "./doc.ts";
type EncodeDoc = {
    width: number;
    height: number;
    layers: ReadonlyArray<PaintDoc["layers"][number]> | FrozenNode[];
    activeId: number | null;
    referenceLayerId: number | null;
};
interface EncodeOpts {
    mergedCanvas?: OffscreenCanvas | HTMLCanvasElement | null;
    referenceImage?: Blob;
    webpaintState?: object;
    editorState?: object;
}
type DecodedDoc = PaintDoc & {
    _referenceBlob?: Blob;
    _webpaintState?: unknown;
    _editorState?: unknown;
    _wroteWith: string | null;
};
/** doc → Blob (.ora)
 *
 * WebPaint 私有扩展（都在 webpaint/ 命名空间下，第三方 reader 会忽略或剥离）：
 *   webpaint/state.json        — 杂七杂八的应用状态（palette / activeLayerIndex / 未迁字段；ref 位图指针）
 *   webpaint/reference.png     — ref 小窗当前显示的图（原 Blob bytes）
 *   .webpaint/editor-state.json — editorState struct（desk per-doc；2026-07-14，不向后兼容旧 state.json 的被迁字段）
 *
 * opts.referenceImage: optional Blob
 * opts.webpaintState:  optional object（直接 JSON.stringify）
 */
export declare function encodeDocToOra(doc: EncodeDoc, opts?: EncodeOpts): Promise<any>;
/** Blob (.ora 明文) → PaintDoc */
export declare function decodeOraToDoc(blob: Blob): Promise<DecodedDoc>;
export declare function parseAppVersion(s: string | null | undefined): number | null;
export {};
