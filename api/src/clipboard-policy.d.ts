/** 双击判定窗口（ms）。PS 肌肉记忆的连按节奏 <1s；再长会把两次独立复制误判成升级。 */
export declare const DOUBLE_COPY_WINDOW_MS = 900;
/** 上一次 Ctrl+C 距今在窗口内 → 本次升级为合并复制。lastAt=0（从未按过）永不判双。 */
export declare function isDoubleCopy(lastAt: number, now: number): boolean;
/** 导入护栏边长 = max(2048, 画布长边)。画布本身 >2k 时按 2k 卡会重蹈"进门先糊"，下限托到画布长边。 */
export declare function importGuardLimit(docW: number, docH: number): number;
/** 图片任一边超护栏 → 需要弹"大图片导入"窗口；否则静默原尺寸进。 */
export declare function needsBigImportSheet(ow: number, oh: number, docW: number, docH: number): boolean;
