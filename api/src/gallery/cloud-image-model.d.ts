export declare const isDocPath: (p: string) => boolean;
export declare const isImagePath: (p: string) => boolean;
/** path → basename（picker 显示名；File 包装名 =「有名保名」命名规范的上游）。 */
export declare const imageBasename: (p: string) => string;
/** File 包装的 MIME（decodeImageFile 实际按字节嗅探，给对只是礼貌）。 */
export declare function mimeForImageName(name: string): string;
/** 缩略图新鲜度 token（cloud-thumb-cache 同款语义：lastModified 优先，退 size）。变 = 重拉覆盖同 key。 */
export declare function imageThumbToken(it: {
    lastModified?: number;
    size?: number;
}): string;
/** 缩到长边 ≤ max 的目标尺寸（不放大）。 */
export declare function thumbTargetSize(w: number, h: number, max: number): {
    w: number;
    h: number;
};
/** 拿一个不占用的 `${base}.${ext}` / `${base} N.${ext}`（导出到云盘用；兜底加时间戳保证必返回）。
 *  isOccupied = store.files.nameOccupied 注入（本模块保持零 store 依赖可测）。 */
export declare function nextFreeExportName(base: string, ext: string, isOccupied: (name: string) => Promise<boolean>, fallbackStamp?: () => number): Promise<string>;
/** RGBA 平铺到白底（就地写，返回同一 buffer）：jpeg 无 alpha，透明区不平铺会糊成黑。 */
export declare function flattenOntoWhite(data: Uint8ClampedArray): Uint8ClampedArray;
