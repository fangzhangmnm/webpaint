export interface InputSenseItem<T> {
    label: string;
    value: T;
    /** 可选前导媒体块（色板 chip / 缩略图 / 图标…）。数据源现建现给，控件只负责摆。 */
    media?: HTMLElement;
}
export interface InputSenseHandle {
    dispose(): void;
}
export declare function attachInputSense<T>(input: HTMLInputElement, opts: {
    search: (query: string) => InputSenseItem<T>[];
    onPick: (item: InputSenseItem<T>) => void;
    /** 可选截断；缺省不设上限（菜单限高滚动，2026-07-30 user 拍板）。 */
    limit?: number;
}): InputSenseHandle;
