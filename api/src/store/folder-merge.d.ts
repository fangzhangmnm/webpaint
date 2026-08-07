export interface FolderItem {
    id: string | number;
    uat?: number;
    name?: string;
    [k: string]: unknown;
}
export interface FolderEnvelope {
    version: number;
    items: FolderItem[];
}
export type ResolveFn = (x: FolderItem, y: FolderItem) => FolderItem;
export type FolderConflictPolicy = "last-win";
export declare const lastWinResolve: ResolveFn;
export interface FolderRef {
    id?: string | number | null;
    name?: string | null;
}
export declare const FOLDER_ENVELOPE_VERSION = 2;
export declare function emptyFolder(): FolderEnvelope;
export declare function mergeFolders(a: FolderEnvelope | null | undefined, b: FolderEnvelope | null | undefined, { resolve, conflictPolicy }?: {
    resolve?: ResolveFn;
    conflictPolicy?: FolderConflictPolicy;
}): FolderEnvelope;
export declare function isValidFolderEnvelope(o: unknown): o is FolderEnvelope;
export declare function parseFolderBlob(textOrBytes: string | Uint8Array): FolderEnvelope | null;
export declare function normalizeFolder(f: FolderEnvelope): string;
export declare function resolveRef(items: FolderItem[], ref: FolderRef | null | undefined): FolderItem | null;
