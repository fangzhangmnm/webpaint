// 线稿分区 oracle——魔棒「线稿闭合」算法的 app 侧接缝（ADR-0004 语义不变：一切算法只产 Selection，
// fill 仍是选区消费视图）。两段式：
//   prepare（贵）：源层整 doc RGBA → src/flat-coloring/partition.ts 论文管线 → label map，
//     按 (layer.id, layer.contentRev, doc 尺寸) 缓存，层一动即失效（contentRev 在
//     Layer._invalidate 汇拢点 bump）。v1 同步构建（2K doc 秒级、后续 tap 查表 ms 级）；
//     worker 化留给后续切片。
//   query（贱）：tap → label 查表 → tight-bbox mask → Selection。
// 该文件不懂论文数学（全在 src/flat-coloring/），也不懂指针/UI；供 LassoEngine 调用。
import {
  buildLineartPartition, regionMaskAt, attachInkDepth, binarizeLuma, DEFAULT_LINEART_PARAMS,
} from "./flat-coloring/partition.ts";
import type { LineartPartition, LineartParams } from "./flat-coloring/partition.ts";
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
    // v0.7.19 懒补墨深：自动档（bleed<0，默认）不算不存（2K 省 4MB 常驻）；
    //   首次拨到显式档才重读像素+一遍 EDT 挂上（同一缓存分区只补一次）。
    if (this._bleed >= 0 && !part.inkDepth) {
      const rgba: Uint8ClampedArray = sourceLayer
        ? sourceLayer.getImageData(0, 0, doc.width, doc.height).data
        : new Uint8ClampedArray(doc.width * doc.height * 4);
      attachInkDepth(part, binarizeLuma(rgba, doc.width, doc.height, this._params.binarizeThreshold));
    }
    const rm = regionMaskAt(part, x, y, this._bleed);
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

  // ---- 可调 knob（v0.7.2 扳手弹出；RAM-only）。改了就丢缓存，下次 tap 重建。 ----
  /** 闭合距离 dmax（px，8..256）；补段上限 smax 跟随 = 0.75·dmax（一个旋钮管两种闭合笔画）。 */
  setCloseDist(px: number): void {
    const v = Math.max(8, Math.min(256, Math.round(px) || 0));
    if (v === this._params.dmax) return;
    this._params = { ...this._params, dmax: v, smax: Math.round(v * 0.75) };
    this.invalidate();
  }
  getCloseDist(): number { return this._params.dmax; }
  /** 墨线判定（0..100%）：白底合成亮度 ≤ pct·2.55 判为笔画。浅色线稿往上调。 */
  setInkThreshold(pct: number): void {
    const v = Math.max(0, Math.min(100, Math.round(pct) || 0));
    if (v === Math.round(this._params.binarizeThreshold / 2.55)) return;
    this._params = { ...this._params, binarizeThreshold: v * 2.55 };
    this.invalidate();
  }
  getInkThreshold(): number { return Math.round(this._params.binarizeThreshold / 2.55); }
  /** 碎区下限（0..128px）：闭合笔画不许切出比这小的背景碎片区；0 = 关守卫。 */
  setMinRegion(px: number): void {
    const v = Math.max(0, Math.min(128, Math.round(px) || 0));
    if (v === this._params.amin) return;
    this._params = { ...this._params, amin: v };
    this.invalidate();
  }
  getMinRegion(): number { return this._params.amin; }
  /** 端点灵敏度（0..100，默认 25）：越高越能抓收尖/圆润的线头（曲率阈值越低），
   *  代价是钝角/紧凑小弧处冒假端点。映射 θκ = 0.30 − 0.0024·pct（不随默认值重排——
   *  数值跨版本可比，v0.7.7 真机校准：25 ↔ 0.24 = 转角带(≤~0.25)与钝头带(≥~0.3)之间；
   *  旧默认 50 ↔ 0.18 在真实画作上会把关节小弧当端点）。 */
  setTipSensitivity(pct: number): void {
    const v = Math.max(0, Math.min(100, Math.round(pct) || 0));
    if (v === this._tipSensPct) return;
    this._tipSensPct = v;
    this._params = { ...this._params, thetaKappa: 0.30 - 0.0024 * v };
    this.invalidate();
  }
  getTipSensitivity(): number { return this._tipSensPct; }
  private _tipSensPct = 25;
  /** 蔓延距离（v0.7.17）：-1=自动（填到中线）；0=像素画模式（真墨水一个不碰）；1..16=最多陷 n px。
   *  **query-time 参数**——不作废分区缓存，拨了即时生效（比构建类旋钮便宜）。 */
  setBleed(px: number): void {
    this._bleed = Math.max(-1, Math.min(16, Math.round(px)));
  }
  getBleed(): number { return this._bleed; }
  private _bleed = -1;

  /** 调试视图数据：分区已缓存（同层同版本）才返回，绝不在渲染路径里触发重建。 */
  debugInfo(
    doc: { width: number; height: number },
    sourceLayer: OracleSourceLayer | null,
  ): { w: number; h: number; keypoints: LineartPartition["keypoints"]; bridges: LineartPartition["bridges"] } | null {
    if (!this.isReady(doc, sourceLayer)) return null;
    const p = this._cache!.part;
    return { w: p.w, h: p.h, keypoints: p.keypoints, bridges: p.bridges };
  }

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
