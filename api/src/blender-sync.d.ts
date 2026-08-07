import type { AppContext } from "./app-context.ts";
export declare function initBlenderSync(c: AppContext): void;
export declare function reconcileBlenderUrlFromPrefs(): void;
export declare function getBlenderSyncState(): {
    textureName: string;
    resW: string;
    resH: string;
    uploadSource: string;
    pullTarget: string;
    uploadAsRef: boolean;
} | undefined;
export declare function applyBlenderSyncState(s?: unknown): void;
