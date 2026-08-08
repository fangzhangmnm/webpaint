import { Workpiece, type WorkpieceOpts, type CollectorComponent } from "./workpiece2.ts";
import { LayerTiles, type TilesHost } from "./layer-tiles.ts";
export declare class PaintingWorkpiece extends Workpiece {
    readonly layerTiles: LayerTiles;
    constructor(opts: WorkpieceOpts & {
        host: TilesHost;
        legacy?: CollectorComponent;
    });
}
