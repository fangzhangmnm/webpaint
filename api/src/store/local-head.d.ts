import type { Kv } from "./types.ts";
export declare class BypassError extends Error {
    code: string;
    constructor(name: string);
}
export interface LocalHeadCfg {
    kv: Kv;
    getCloudEtag: (name: string) => string | null;
    setCloudEtag?: (name: string, etag: string | null) => void;
    keyPrefix?: string;
}
export interface LocalHead {
    ifMatchFor(name: string): string | null;
    seenBase(name: string): string | null;
    isDirty(name: string): boolean;
    isDirtyAnywhere(name: string): boolean;
    recordEdit(name: string): void;
    markSeen(name: string, etag: string | null): void;
    markSynced(name: string, etag: string | null): void;
    onPushed(name: string, newEtag: string | null, dirtyAfter: boolean): void;
    forget(name: string): void;
}
export declare function createLocalHead({ kv, getCloudEtag, setCloudEtag, keyPrefix }: LocalHeadCfg): LocalHead;
