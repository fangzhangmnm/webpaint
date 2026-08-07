import type { PaintDoc } from "../doc.ts";
export interface DocView {
    readonly width: number;
    readonly height: number;
    readonly layers: ReadonlyArray<PaintDoc["layers"][number]>;
    readonly activeId: number | null;
    readonly activeIndex: number;
    readonly backgroundColor: string;
    readonly selection: PaintDoc["selection"];
    readonly referenceLayerId: number | null;
    readonly maxLayers: number;
    readonly activeLayer: PaintDoc["activeLayer"];
    readonly findLayer: PaintDoc["findLayer"];
    readonly locateNode: PaintDoc["locateNode"];
    readonly canMoveLayer: PaintDoc["canMoveLayer"];
    readonly activeEditableLeaf: PaintDoc["activeEditableLeaf"];
    readonly activeNodeHidden: PaintDoc["activeNodeHidden"];
    readonly getReferenceLayer: PaintDoc["getReferenceLayer"];
    readonly getFloodSourceLayer: PaintDoc["getFloodSourceLayer"];
    readonly layerSpec: PaintDoc["layerSpec"];
}
