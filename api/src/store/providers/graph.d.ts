interface GraphDriveItem {
    id: string;
    name?: string;
    size?: number;
    eTag?: string;
    createdDateTime?: string;
    lastModifiedDateTime?: string;
    file?: unknown;
    folder?: unknown;
    parentReference?: {
        id?: string;
    };
    downloadUrl?: string;
    "@microsoft.graph.downloadUrl"?: string;
}
export declare function encodeApprootPath(path: string): string;
export declare function listChildren(subfolder?: string): Promise<GraphDriveItem[]>;
export declare function getItemByPath(path: string): Promise<GraphDriveItem | null>;
export declare function downloadItemBlob(itemId: string): Promise<Blob>;
export declare function downloadItemRange(itemId: string, offset: number | null, length: number): Promise<ArrayBuffer>;
export declare function downloadRangeFromUrl(downloadUrl: string, offset: number | null, length: number): Promise<ArrayBuffer>;
export declare function getDownloadUrl(itemId: string): Promise<string | null>;
interface UploadFileOpts {
    conflictBehavior?: string;
    eTag?: string | null;
}
export declare function uploadFileToApproot(path: string, blob: Blob, contentType?: string, { conflictBehavior, eTag }?: UploadFileOpts): Promise<GraphDriveItem | null>;
export declare function deleteItem(itemId: string, eTag?: string | null): Promise<void>;
export declare function clearFolderCaches(): void;
export declare function getApprootId(): Promise<string>;
export declare function ensureSubfolder(name: string): Promise<string>;
interface MoveItemOpts {
    eTag?: string | null;
    newName?: string | null;
    conflictBehavior?: string;
}
export declare function moveItemToFolder(itemId: string, targetFolderId: string, { eTag, newName, conflictBehavior }?: MoveItemOpts): Promise<GraphDriveItem>;
export declare function renameItem(itemId: string, newName: string, eTag?: string | null): Promise<GraphDriveItem>;
export {};
