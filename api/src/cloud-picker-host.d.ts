import type { AppContext } from "./app-context.ts";
/**
 * 打开云盘图片选择器，resolve 选中的图片 File（取消/关闭 → null）。
 * 初始夹 = 图库当前夹（user 拍板「跟随当前夹」，零持久化字段）。重入安全：旧 promise 先以 null 收口。
 */
export declare function pickCloudImage(): Promise<File | null>;
export declare function initCloudPickerHost(ctx: AppContext): void;
