import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
export interface TrashCfg {
    cloud: Pick<CloudSync, "restore" | "purge" | "listTrash" | "listBackup">;
    local?: Pick<LocalCache, "restore" | "purgeTrash" | "listTrash" | "listBackup">;
    head: Pick<LocalHead, "markSeen">;
    busy?: Busy;
}
export interface RestoreOpts {
    fromCloud?: boolean;
    cloudItemId?: string | null;
    targetName?: string;
    trashKey?: string | null;
    encrypted?: boolean;
    busy?: Busy;
}
export interface PurgeOpts {
    trashKey?: string | null;
    cloudItemId?: string | null;
    confirm?: (ctx: {
        title: string;
        body: string;
        danger?: boolean;
    }) => boolean | Promise<boolean>;
    busy?: Busy;
}
export interface EmptyTrashOpts {
    isOnline?: () => boolean;
    busy?: Busy;
    concurrency?: number;
    scope?: "local" | "cloud" | "both";
}
export interface TrashResult {
    status: string;
    name?: string | null;
    local?: boolean;
    cloud?: boolean;
    purged?: number;
    failed?: unknown[];
}
export declare function createTrash(cfg: TrashCfg): {
    restore: (opts?: RestoreOpts) => Promise<TrashResult>;
    purge: (opts?: PurgeOpts) => Promise<TrashResult>;
    emptyTrash: (opts?: EmptyTrashOpts) => Promise<TrashResult>;
    emptyBackup: (opts?: EmptyTrashOpts) => Promise<TrashResult>;
};
export {};
