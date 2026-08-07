import { raiseWindow } from "./surfaces.ts";
import type { AppContext } from "./app-context.ts";
export declare function _suppressTransientPanels(mode: string): void;
export declare function _restoreTransientPanels(): void;
export declare const _bringPanelTop: typeof raiseWindow;
export declare function _commitTransform(): void;
export declare function _cancelTransform(): void;
export declare function scheduleFloatTransientSync(): void;
export declare function initTransientPanels(ctx: AppContext): void;
