import type { LocalCache } from "./types.ts";
export declare function createLocalCache(dbName: string): LocalCache;
export declare function createCollectionCache(dbName: string): Pick<LocalCache, "save" | "get" | "exists">;
