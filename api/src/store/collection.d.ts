import type { CloudSync, LocalCache } from "./types.ts";
export declare function collectionLocalKey(name: string): string;
export interface CollectionEntry {
    id: string;
    uat: number;
    value: unknown;
}
export type ChangeCb = (changedIds: string[]) => void;
export interface CollectionInitItem {
    id: string;
    value: unknown;
}
export interface CollectionConfig {
    cloud: CloudSync;
    name: string;
    isOnline?: () => boolean;
    syncDelayMs?: number;
    now?: () => number;
    manual?: boolean;
    /** 本地缓存（IDB）：透明缓存内存 env → 离线可读 + 强杀存活 + 旧设备旧缓存靠 uat-LWW 不盖新。不传 = 纯内存+云。 */
    local?: Pick<LocalCache, "save" | "get" | "exists">;
    localWriteDelayMs?: number;
    cloudless?: boolean;
    /** 仅当这份 collection 的 json **不存在**时调（填初始值，uat=1）。store 内容无关：app 域构造 [{id,value}]。 */
    getInitData?: () => CollectionInitItem[] | Promise<CollectionInitItem[]>;
}
export interface ReconcileResult {
    status: string;
    pushed?: boolean;
    error?: unknown;
}
export interface Collection {
    init(): Promise<void>;
    reconcileWithRemote(): Promise<ReconcileResult>;
    setItem(id: string, value: unknown): void;
    deleteItem(id: string): void;
    getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined;
    getEntry(id: string): CollectionEntry | undefined;
    entries(): CollectionEntry[];
    keys(): string[];
    onChange(cb: ChangeCb): () => void;
    onChange(id: string, cb: () => void): () => void;
    flushLocal(): Promise<{
        ok: boolean;
        error?: unknown;
    }>;
    isDirty(): boolean;
}
export declare function emptyCollectionBytes(): Uint8Array;
export declare function createCollection(cfg: CollectionConfig): Collection;
