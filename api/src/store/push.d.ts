import type { BytesSource } from "./substrate.ts";
import type { CloudSync } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { Seal } from "./seal.ts";
import type { SafeResolve, ResolveChoice } from "./safe-resolve.ts";
type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;
export interface PushCfg {
    cloud: Pick<CloudSync, "push">;
    head: Pick<LocalHead, "ifMatchFor" | "onPushed" | "recordEdit">;
    seal: Pick<Seal, "sealForWrite" | "isContainer">;
    safeResolve: Pick<SafeResolve, "tryHeal" | "resolveConflict">;
    serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    editVersion: () => number;
    busy?: Busy;
    maxAttempts?: number;
    backoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
export interface PushOpts {
    encode: () => BytesSource | Promise<BytesSource>;
    getEditVersion?: () => number;
    onConflict?: (ctx: {
        name: string;
    }) => ResolveChoice | Promise<ResolveChoice>;
    adopt?: AdoptFn;
    surfaceCollision?: boolean;
}
export type PushStatus = "pushed" | "deferred" | "healed" | "resolved" | "unresolved" | "cancelled";
export interface PushResult {
    status: PushStatus;
    dirtyAfter?: boolean;
    resolution?: string;
    reason?: string;
    backupName?: string;
    backedUp?: string | null;
}
export declare function createPush(cfg: PushCfg): {
    push: (name: string, opts: PushOpts) => Promise<PushResult>;
    doPush: (name: string, { encode, getEditVersion, onConflict, adopt, surfaceCollision }: PushOpts) => Promise<PushResult>;
};
export {};
