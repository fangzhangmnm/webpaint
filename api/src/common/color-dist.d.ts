export type ColorMetric = "oklab" | "rgb";
/** 8-bit sRGB → OKLab（标准系数）。色名/距离共用一份（原 color-name.ts 私有实现收拢至此）。 */
export declare function srgbToOklab(r8: number, g8: number, b8: number): [number, number, number];
/**
 * 以种子色为锚的距离闭包：`(r,g,b,a) => [0,1]`。flood barrier / 同色全图逐像素调用。
 * 直读 tiles 的 RGBA 是 straight alpha（v0.6.39）；α=0 处 RGB 可能是烂值，但 α 差先顶满 → 不受污染
 * （与经典 max 通道语义一致：透明↔不透明恒 barrier，除非容差极大）。
 */
export declare function makeSeedDist(metric: ColorMetric, sr: number, sg: number, sb: number, sa: number): (r: number, g: number, b: number, a: number) => number;
