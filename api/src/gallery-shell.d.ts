import type { AppContext } from "./app-context.ts";
export declare function setGalleryOpen(open: boolean): Promise<void>;
export declare function openNewDocSheet(): void;
export declare function updateIdbUsage(): Promise<void>;
export declare function checkQuotaAndWarn(): Promise<void>;
export declare function uniqueNameFor(stem: string): Promise<string>;
export declare function initGalleryShell(ctx: AppContext): void;
