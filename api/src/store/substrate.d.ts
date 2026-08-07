export type Bytes = Uint8Array;
export type BytesSource = Bytes | ArrayBuffer | Blob | string | null | undefined;
export declare function toU8(x: BytesSource): Promise<Bytes>;
export declare function bytesEqual(a: Bytes, b: Bytes): boolean;
export type SaveType = "local" | "push";
export interface EditCursor {
    mark(): void;
    version(): number;
    markSaved(v?: number): void;
    localDirty(): boolean;
}
export interface Substrate {
    edits: EditCursor;
    session: Coalescer;
    serialize<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
    serialize2<T>(a: string, b: string, fn: () => T | Promise<T>): Promise<T>;
}
export interface Coalescer {
    configure(fns?: {
        doLocal?: () => Promise<void>;
        doPush?: () => Promise<void>;
    }): void;
    request(type: SaveType): void;
    state(): {
        pending: SaveType | null;
        inFlight: SaveType | null;
        startVer: number;
    };
}
export declare function createSubstrate(): Substrate;
