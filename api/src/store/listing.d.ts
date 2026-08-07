import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
export type SyncState = "cloud-only" | "synced" | "unpushed" | "newer-on-cloud" | "conflict" | "ghost" | "pendingGone" | "float" | "local-only";
export interface Item {
    path: string;
    syncState: SyncState;
    size?: number;
    lastModified?: number;
}
export interface ListContext {
    signedIn: boolean;
    online: boolean;
}
export declare function isCached(s: SyncState): boolean;
export declare function isDirty(s: SyncState): boolean;
export declare function classifySyncState(f: {
    hasLocal: boolean;
    hasCloud: boolean;
    everSynced: boolean;
    cloudMoved: boolean;
    dirty: boolean;
    cloudReachable: boolean;
    absenceAuthoritative: boolean;
    pendingGone?: boolean;
}): SyncState;
export interface ListingCfg {
    cloud: Pick<CloudSync, "listAll" | "listFolder" | "getETag">;
    local: Pick<LocalCache, "appKeys"> & Partial<Pick<LocalCache, "stat">>;
    head: Pick<LocalHead, "seenBase" | "isDirty">;
    pendingFolders?: () => string[];
    isPendingGone?: (path: string) => boolean;
    pendingFolderDeletions?: () => string[];
}
export interface FolderSnapshot {
    path: string;
    items: Item[];
    folders: string[];
    complete: boolean;
}
export declare function createListing(cfg: ListingCfg): {
    listAllItems: (ctx: ListContext) => Promise<{
        items: Item[];
        folders: string[];
        complete: boolean;
    }>;
    listFolder: (folder: string, ctx: ListContext) => Promise<FolderSnapshot>;
};
