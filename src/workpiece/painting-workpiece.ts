// painting-workpiece —— PaintingWorkpiece（ADR-0008 §3；T2 起步形态）。
// 目标终态（提案 .h）：layerTree/layerTiles/selection/floatLayer/pendingFill/persp (recorded)
// + referenceGallery/palette (silent) + load()/exportData()。
// T2 只落 layerTiles + 过渡期 legacyOps（旧 operator 桥组件，T5 拆）；其余组件按 T3/T4 逐片迁入。

import { Workpiece, type WorkpieceOpts, type CollectorComponent } from "./workpiece2.ts";
import { LayerTiles, type TilesHost } from "./layer-tiles.ts";

export class PaintingWorkpiece extends Workpiece {
  readonly layerTiles: LayerTiles;

  constructor(opts: WorkpieceOpts & { host: TilesHost; legacy?: CollectorComponent }) {
    super(opts);
    this.layerTiles = new LayerTiles(this, opts.host);
    this.register(this.layerTiles, { undo: "recorded" });
    if (opts.legacy) this.register(opts.legacy, { undo: "recorded" });   // 迁移期（T5 拆）
  }
}
