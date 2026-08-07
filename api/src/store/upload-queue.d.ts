import type { Kv, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
export type UploadReplayPolicy = "auto" | "ask" | "manual";
export interface ReplayStatus {
    phase: "start" | "pushed" | "collision" | "done";
    name?: string;
    done: number;
    total: number;
}
export interface UploadReplayCfg {
    kv: Kv;
    local: Pick<LocalCache, "exists">;
    head: Pick<LocalHead, "isDirty" | "seenBase">;
    isOnline: () => boolean;
    serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    pushLocal: (name: string) => Promise<{
        status: string;
    }>;
    policy: UploadReplayPolicy;
    confirm?: (count: number) => Promise<boolean>;
    onStatus?: (evt: ReplayStatus) => void;
}
export interface DrainResult {
    status: string;
    pushed: number;
    remain?: number;
}
export declare function createUploadReplay(cfg: UploadReplayCfg): {
    enqueue: (name: string) => void;
    remove: (name: string) => void;
    drain: () => Promise<DrainResult>;
    pending: () => string[];
};
