import type { BytesSource } from "./substrate.ts";
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { Seal } from "./seal.ts";
type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;
type PushFn = (name: string, opts: {
    encode: () => BytesSource | Promise<BytesSource>;
    getEditVersion?: () => number;
}) => Promise<{
    status: string;
}>;
export interface IdentityCfg {
    cloud: Pick<CloudSync, "fetchMeta" | "rename" | "getETag" | "pull" | "trash">;
    local?: Pick<LocalCache, "exists" | "get" | "save" | "hardDelete">;
    head: Pick<LocalHead, "isDirty" | "markSeen" | "markSynced" | "forget" | "recordEdit" | "seenBase">;
    doPush: PushFn;
    serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    serialize2: <T>(a: string, b: string, fn: () => Promise<T>) => Promise<T>;
    seal?: Pick<Seal, "unsealForRead">;
    busy?: Busy;
    isOnline?: () => boolean;
    deleteOffline?: (name: string) => Promise<void>;
    queueUpload?: (name: string) => void;
    nameOccupied?: (name: string) => Promise<"local" | "cloud" | null>;
}
export interface RenameOpts {
    encode?: () => BytesSource | Promise<BytesSource>;
    getEditVersion?: () => number;
    cloud?: boolean;
    busy?: Busy;
    skipOccupiedCheck?: boolean;
}
export interface AcquireOpts {
    localName?: string;
    adopt?: AdoptFn;
    busy?: Busy;
}
export interface IdResult {
    status: string;
    where?: string;
    newName?: string;
    oldName?: string;
    localName?: string;
    oldCloudOrphan?: boolean;
    oldKept?: boolean;
    oldUnknown?: boolean;
    cloudDeferred?: boolean;
    item?: unknown;
    error?: unknown;
}
export declare function createIdentity(cfg: IdentityCfg): {
    rename: (oldName: string, newName: string, opts?: RenameOpts) => Promise<IdResult>;
    acquire: (cloudName: string, opts?: AcquireOpts) => Promise<IdResult>;
};
export {};
