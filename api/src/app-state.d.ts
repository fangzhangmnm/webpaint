import type { Collection } from "./app-store.ts";
export declare const APP_STATE_DEFAULTS: {
    readonly "current-directory": string;
    readonly "current-file": string | null;
    readonly "blender-panel-url": string;
    readonly "gallery-password-verifier": {
        v: 1;
        salt: string;
        iv: string;
        ct: string;
    } | null;
};
export type AppStateKey = keyof typeof APP_STATE_DEFAULTS;
export declare function wireAppState(synced: Collection, local: Collection): void;
export declare function initAppState(): Promise<void>;
export declare function flushAppState(): Promise<void>;
export declare const appState: {
    currentDirectory: string;
    currentFile: string | null;
    blenderPanelUrl: string;
    get galleryPasswordVerifier(): {
        v: 1;
        salt: string;
        iv: string;
        ct: string;
    } | null;
    set galleryPasswordVerifier(v: {
        v: 1;
        salt: string;
        iv: string;
        ct: string;
    } | null);
    pushHotToPersistent(): void;
    pullFromPersistent(): Promise<void>;
};
