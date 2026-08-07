import type { Bytes } from "./substrate.ts";
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
export type ResolveChoice = "keepMine" | "takeCloud" | "cancel";
export type SafePullResult = {
    ok: true;
    backupName?: string;
} | {
    ok: false;
    reason: string;
    backupName?: string;
    error?: unknown;
};
type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;
export interface SafeResolveCfg {
    cloud: Pick<CloudSync, "pull" | "weakOverride">;
    local: Pick<LocalCache, "backup" | "save">;
    head: Pick<LocalHead, "isDirty" | "markSynced">;
    localDirty?: () => boolean;
    validateAdopt: (plain: Blob) => boolean | Promise<boolean>;
    unseal?: (name: string, blob: Blob) => Promise<Blob | null>;
    onReplacing?: (on: boolean) => void;
    looksEncrypted?: (bytes: Blob | Bytes) => Promise<boolean>;
}
export type ResolveStatus = "resolved" | "unresolved" | "cancelled";
export interface ResolveConflictResult {
    status: ResolveStatus;
    resolution?: string;
    reason?: string;
    backupName?: string;
    backedUp?: string | null;
}
export interface SafeResolve {
    safePull(name: string, opts?: {
        adopt?: AdoptFn;
    }): Promise<SafePullResult>;
    tryHeal(name: string, bytes: Bytes): Promise<boolean>;
    weakOverride(name: string, bytes: Bytes): Promise<{
        backedUp: string | null;
    }>;
    resolveConflict(name: string, choice: ResolveChoice, ctx?: {
        bytes?: Bytes | null;
        adopt?: AdoptFn;
    }): Promise<ResolveConflictResult>;
}
export declare function createSafeResolve(cfg: SafeResolveCfg): SafeResolve;
export {};
