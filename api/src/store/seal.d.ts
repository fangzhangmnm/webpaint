import type { Bytes } from "./substrate.ts";
export declare class LockedError extends Error {
    code: string;
    constructor(name: string);
}
export interface SealCfg {
    looksContainer: (bytes: Blob | Uint8Array) => Promise<boolean>;
    pack: (o: {
        dataBytes: Bytes;
        fileName: string;
        ext?: string;
        peek?: Uint8Array | null;
        password: string;
    }) => Promise<Blob>;
    unpack: (blob: Blob | Bytes, password: string) => Promise<{
        dataBlob: Blob;
    }>;
    getPassword: (name: string) => string | null;
    getPrev: (name: string) => Promise<Blob | Uint8Array | null>;
    makePeek?: (plain: Blob) => Promise<Uint8Array | null>;
    ext?: string;
}
export interface Seal {
    isContainer(bytes: Blob | Uint8Array): Promise<boolean>;
    sealForWrite(name: string, plain: Bytes): Promise<Bytes>;
    unsealForRead(name: string, bytes: Blob): Promise<Blob | null>;
    withPassword<T>(name: string, attempt: (pw: string) => Promise<T>): Promise<T | null>;
}
export declare function createSeal(cfg: SealCfg): Seal;
