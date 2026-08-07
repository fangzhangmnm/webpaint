import type { AppContext } from "./app-context.ts";
export declare function closeTransientMenus(): void;
export declare function updateShapeToolbar(): void;
export declare function updateLassoToolbar(): void;
export declare function setTool(tool: string): void;
export declare function _syncEditModeUI(): void;
export declare const RACK_PANEL_BY_TOOL: Record<string, string>;
export declare function initToolbar(ctx: AppContext): void;
