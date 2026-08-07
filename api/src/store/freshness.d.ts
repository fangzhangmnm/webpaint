import type { CloudSync } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { SafeResolve, ResolveChoice } from "./safe-resolve.ts";
type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;
export interface FreshnessCfg {
    cloud: Pick<CloudSync, "fetchMeta">;
    head: Pick<LocalHead, "seenBase" | "isDirty" | "markSeen">;
    safeResolve: Pick<SafeResolve, "safePull">;
    busy?: Busy;
}
export interface OpenOpts {
    isOnline?: () => boolean;
    probe?: Promise<unknown> | unknown;
    onNewer?: (ctx: {
        name: string;
        cloudEtag: string;
        baseEtag: string | null;
        cloudTime: string | number;
    }) => ResolveChoice | Promise<ResolveChoice>;
    adopt?: AdoptFn;
    localDirty?: () => boolean;
    busy?: Busy;
}
export interface RefreshOpts {
    isOnline?: () => boolean;
    adopt?: AdoptFn;
    localDirty?: () => boolean;
    onReplaceStart?: () => void;
    busy?: Busy;
}
export interface FreshResult {
    source?: string;
    status?: string;
    reason?: string;
    backupName?: string;
    error?: unknown;
}
export declare function createFreshness(cfg: FreshnessCfg): {
    open: (name: string, opts?: OpenOpts) => Promise<FreshResult>;
    refresh: (name: string, opts?: RefreshOpts) => Promise<FreshResult>;
};
export {};
