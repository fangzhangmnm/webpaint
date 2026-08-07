import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { PendingGone } from "./pending-gone.ts";
export declare function classifyCloudGone(localNames: string[], cloudNameSet: Set<string>, opts: {
    seenBase: (name: string) => string | null;
    isDirty: (name: string) => boolean;
    authoritative: boolean;
    skip?: (name: string) => boolean;
}): {
    demote: string[];
};
export interface ReconcileCfg {
    cloud: Pick<CloudSync, "listAll" | "listFolder" | "clearState">;
    local: Pick<LocalCache, "appKeys" | "trash">;
    head: Pick<LocalHead, "seenBase" | "isDirty" | "forget">;
    pending: PendingGone;
    now?: () => number;
    isOnline?: () => boolean;
    activeFileName?: () => string | null;
}
export declare function createReconcile(cfg: ReconcileCfg): {
    reconcile: (opts?: {
        activeFileName?: string;
    }) => Promise<{
        demoted: string[];
    }>;
    reconcileFolder: (folder: string, opts?: {
        activeFileName?: string;
    }) => Promise<{
        demoted: string[];
    }>;
};
