import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
export type OffloadIllegalReason = "dirty" | "offline" | "local-only" | "cloud-gone" | "incomplete";
export declare class OffloadIllegalError extends Error {
    code: string;
    reason: OffloadIllegalReason;
    constructor(name: string, reason: OffloadIllegalReason);
}
export interface OffloadCfg {
    cloud: Pick<CloudSync, "fetchMeta">;
    local: Pick<LocalCache, "exists" | "hardDelete">;
    head: Pick<LocalHead, "isDirty" | "isDirtyAnywhere" | "seenBase" | "forget">;
    isOnline?: () => boolean;
    serialize?: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;
}
export declare function createOffload(cfg: OffloadCfg): {
    offload: (name: string) => Promise<void>;
};
