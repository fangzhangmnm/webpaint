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
export declare function itemTime(it: GalleryItem): number;
export declare function copyTargetName(sourceName: string, taken: (name: string) => boolean): string;
