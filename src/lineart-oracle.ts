// 线稿分区 oracle——魔棒「线稿闭合」算法的 app 侧接缝（ADR-0004 语义不变：一切算法只产 Selection，
// fill 仍是选区消费视图）。两段式：
//   prepare（贵）：源层整 doc RGBA → src/lineart/partition.ts 论文管线 → label map，
//     按 (layer.id, layer.contentRev, doc 尺寸) 缓存，层一动即失效（contentRev 在
//     Layer._invalidate 汇拢点 bump）。v1 同步构建（2K doc 秒级、后续 tap 查表 ms 级）；
//     worker 化留给后续切片。
//   query（贱）：tap → label 查表 → tight-bbox mask → Selection。
// 该文件不懂论文数学（全在 src/lineart/），也不懂指针/UI；供 LassoEngine 调用。
import {
  buildLineartPartition, regionMaskAt, DEFAULT_LINEART_PARAMS,
} from "./lineart/partition.ts";
import type { LineartPartition, LineartParams } from "./lineart/partition.ts";
import { Selection } from "./selection.ts";

/** 结构化最小依赖（≈ floodSelectFrom 的 mock 面）：node 直测不拖 doc.ts */
export interface OracleSourceLayer {
  id: number;
  contentRev: number;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export class LineartOracle {
  private _cache: {
    layerId: number; rev: number; w: number; h: number; part: LineartPartition;
  } | null = null;
  private _params: LineartParams = DEFAULT_LINEART_PARAMS;

  /** 命中缓存则查表即回；否则同步重建分区（调用方自行决定要不要 busy 提示）。 */
  selectAt(
    doc: { width: number; height: number },
    sourceLayer: OracleSourceLayer | null,
    x: number, y: number,
  ): Selection | null {
    const part = this._ensurePartition(doc, sourceLayer);
    const rm = regionMaskAt(part, x, y);
    if (!rm) return null;
    return Selection.fromGray8Region(rm.x, rm.y, rm.w, rm.h, rm.mask);
  }

  /** 分区是否已就绪（UI 可据此决定首次 tap 前要不要提示「分析中」）。 */
  isReady(doc: { width: number; height: number }, sourceLayer: OracleSourceLayer | null): boolean {
    const c = this._cache;
    const id = sourceLayer ? sourceLayer.id : -1;
    const rev = sourceLayer ? sourceLayer.contentRev : 0;
    return !!c && c.layerId === id && c.rev === rev && c.w === doc.width && c.h === doc.height;
  }

  /** 换文档 / 明确要丢缓存时调（16MB 级 label map，别赖着）。 */
  invalidate(): void { this._cache = null; }

  private _ensurePartition(
    doc: { width: number; height: number },
    sourceLayer: OracleSourceLayer | null,
  ): LineartPartition {
    const id = sourceLayer ? sourceLayer.id : -1;
    const rev = sourceLayer ? sourceLayer.contentRev : 0;
    const c = this._cache;
    if (c && c.layerId === id && c.rev === rev && c.w === doc.width && c.h === doc.height) return c.part;
    // rev 读在 getImageData **之前**：构建期间若有并发写（不该有，但守约束），下次 tap 仍会失效重建
    const rgba: Uint8ClampedArray = sourceLayer
      ? sourceLayer.getImageData(0, 0, doc.width, doc.height).data
      : new Uint8ClampedArray(doc.width * doc.height * 4);
    const part = buildLineartPartition(rgba, doc.width, doc.height, this._params);
    this._cache = { layerId: id, rev, w: doc.width, h: doc.height, part };
    return part;
  }
}
