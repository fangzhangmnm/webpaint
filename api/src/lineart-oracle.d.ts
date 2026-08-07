import type { LineartPartition } from "./lineart/partition.ts";
import { Selection } from "./selection.ts";
/** 结构化最小依赖（≈ floodSelectFrom 的 mock 面）：node 直测不拖 doc.ts */
export interface OracleSourceLayer {
    id: number;
    contentRev: number;
    getImageData(x: number, y: number, w: number, h: number): {
        data: Uint8ClampedArray;
    };
}
export declare class LineartOracle {
    private _cache;
    private _params;
    /** 命中缓存则查表即回；否则同步重建分区（调用方自行决定要不要 busy 提示）。 */
    selectAt(doc: {
        width: number;
        height: number;
    }, sourceLayer: OracleSourceLayer | null, x: number, y: number): Selection | null;
    /** 分区是否已就绪（UI 可据此决定首次 tap 前要不要提示「分析中」）。 */
    isReady(doc: {
        width: number;
        height: number;
    }, sourceLayer: OracleSourceLayer | null): boolean;
    /** 换文档 / 明确要丢缓存时调（16MB 级 label map，别赖着）。 */
    invalidate(): void;
    /** 闭合距离 dmax（px，8..256）；补段上限 smax 跟随 = 0.75·dmax（一个旋钮管两种闭合笔画）。 */
    setCloseDist(px: number): void;
    getCloseDist(): number;
    /** 墨线判定（0..100%）：白底合成亮度 ≤ pct·2.55 判为笔画。浅色线稿往上调。 */
    setInkThreshold(pct: number): void;
    getInkThreshold(): number;
    /** 碎区下限（0..128px）：闭合笔画不许切出比这小的背景碎片区；0 = 关守卫。 */
    setMinRegion(px: number): void;
    getMinRegion(): number;
    /** 端点灵敏度（0..100，默认 25）：越高越能抓收尖/圆润的线头（曲率阈值越低），
     *  代价是钝角/紧凑小弧处冒假端点。映射 θκ = 0.30 − 0.0024·pct（不随默认值重排——
     *  数值跨版本可比，v0.7.7 真机校准：25 ↔ 0.24 = 转角带(≤~0.25)与钝头带(≥~0.3)之间；
     *  旧默认 50 ↔ 0.18 在真实画作上会把关节小弧当端点）。 */
    setTipSensitivity(pct: number): void;
    getTipSensitivity(): number;
    private _tipSensPct;
    /** 蔓延距离（v0.7.17）：-1=自动（填到中线）；0=像素画模式（真墨水一个不碰）；1..16=最多陷 n px。
     *  **query-time 参数**——不作废分区缓存，拨了即时生效（比构建类旋钮便宜）。 */
    setBleed(px: number): void;
    getBleed(): number;
    private _bleed;
    /** 调试视图数据：分区已缓存（同层同版本）才返回，绝不在渲染路径里触发重建。 */
    debugInfo(doc: {
        width: number;
        height: number;
    }, sourceLayer: OracleSourceLayer | null): {
        w: number;
        h: number;
        keypoints: LineartPartition["keypoints"];
        bridges: LineartPartition["bridges"];
    } | null;
    private _ensurePartition;
}
