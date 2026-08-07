export interface LocalSession {
    name: string;
    updatedAt?: number;
}
export interface CloudFile {
    path: string;
    name?: string;
    lastModifiedDateTime?: string;
}
export interface GalleryItem {
    name: string;
    local: LocalSession | null;
    cloud: CloudFile | null;
    deletedAt?: number;
}
export interface LocalTrash {
    originalName: string;
    deletedAt?: number;
}
export interface TrashItem {
    name: string;
    local: LocalTrash | null;
    cloud: CloudFile | null;
    deletedAt: number;
}
export declare function mergeLocalCloud(local: LocalSession[], cloud: CloudFile[]): GalleryItem[];
export declare function itemTime(it: GalleryItem): number;
export declare function mergeTrash(localTrash: LocalTrash[], cloudTrash: CloudFile[]): TrashItem[];
export declare function sliceFolder(allItems: GalleryItem[], cloudFolders: string[], folder: string): {
    folderNames: string[];
    files: GalleryItem[];
};
export declare function classifyCloudGone(localNames: string[], cloudNameSet: Set<string>, { hasEtag, isDirty, authoritative }: {
    hasEtag: (name: string) => boolean;
    isDirty: (name: string) => boolean;
    authoritative: boolean;
}): {
    drop: string[];
    ghost: string[];
};
export declare function copyTargetName(sourceName: string, taken: (name: string) => boolean): string;
export declare function folderHasContents(allItems: GalleryItem[], cloudFolders: string[], folderPath: string): boolean;
