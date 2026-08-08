import type { AppContext } from "./app-context.ts";
export interface ColorTarget {
    get(): string;
    set(hex: string): void;
}
export declare function registerColorTarget(p: () => ColorTarget | null): void;
/** 色板当前显示/编辑的颜色（target 优先，否则笔刷色）。 */
export declare function currentPanelColor(): string;
/** 显示面重同步（target 生灭/undo 换色后调；只写 DOM/色轮，不写任何状态）。 */
export declare function refreshColorDisplay(): void;
export declare function setColor(hex: string): void;
export declare function toggleColorPanel(force?: boolean): void;
export declare function initColorPanel(ctx: AppContext): void;
