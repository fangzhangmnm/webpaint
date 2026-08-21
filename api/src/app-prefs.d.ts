import type { Collection } from "./app-store.ts";
export declare const PREF_DEFAULTS: {
    readonly "color-theme": string;
    readonly "menu-tab": string;
    readonly "cloud-enabled": boolean;
    readonly lang: string | null;
    readonly "long-press-pick": boolean;
    readonly "single-finger-draw": boolean;
    readonly "show-fps": boolean;
    readonly "pixel-grid": boolean;
    readonly "stylus-smooth-params": Record<string, number>;
    readonly "gen-ai": boolean;
};
export type PrefKey = keyof typeof PREF_DEFAULTS;
export declare function wirePreferences(local: Collection, synced: Collection): void;
export declare function initPreferences(): Promise<void>;
export declare function preferencesReady(): Promise<void>;
export declare function flushPreferences(): Promise<void>;
export declare function refreshPreferences(): Promise<void>;
export declare const localUserPreference: {
    getItem<V = unknown>(id: PrefKey, def: V): V;
    setItem(id: PrefKey, value: unknown): void;
    onChange(cb: (changedIds: string[]) => void): () => void;
    flushLocal(): Promise<{
        ok: boolean;
        error?: unknown;
    }>;
};
export declare const syncedUserPreference: {
    getItem<V = unknown>(id: PrefKey, def: V): V;
    setItem(id: PrefKey, value: unknown): void;
    onChange(cb: (changedIds: string[]) => void): () => void;
    flushLocal(): Promise<{
        ok: boolean;
        error?: unknown;
    }>;
};
