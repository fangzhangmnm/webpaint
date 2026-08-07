import type { CloudSync, Kv, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
export interface DeleteCfg {
    cloud: Pick<CloudSync, "fetchMeta" | "trash" | "getETag">;
    local?: Pick<LocalCache, "exists" | "trash" | "hardDelete">;
    head: Pick<LocalHead, "isDirty" | "forget">;
    kv: Kv;
    busy?: Busy;
}
export interface DelOpts {
    isOnline?: () => boolean;
    confirm?: (ctx: {
        title: string;
        body: string;
        danger?: boolean;
    }) => boolean | Promise<boolean>;
    onDirtyWarn?: (ctx: {
        name: string;
    }) => boolean | Promise<boolean>;
    busy?: Busy;
}
export interface DelResult {
    status: string;
    where?: string;
    trashed?: unknown;
    trashKey?: string | null;
    baseEtag?: string | null;
    queuedCloudDelete?: boolean;
    reason?: string;
    drained?: number;
    deferred?: number;
}
export declare function createDelete(cfg: DeleteCfg): {
    del: (name: string, opts?: DelOpts) => Promise<DelResult>;
    replayDelete: (name: string, opts?: {
        baseEtag?: string | null;
        deleteEventId?: string;
    }) => Promise<DelResult>;
    drainDeleteQueue: () => Promise<DelResult>;
};
export {};
