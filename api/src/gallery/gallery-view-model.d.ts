import type { GalleryItem, CloudFile, LocalSession } from "./gallery-model.ts";
export interface LocalSessionMeta extends LocalSession {
    size?: number;
    thumb?: Blob | null;
    encrypted?: boolean;
    trashKey?: string;
}
export interface CloudFileMeta extends CloudFile {
    id?: string;
    size?: number;
}
export interface GItem extends Omit<GalleryItem, "local" | "cloud"> {
    local: LocalSessionMeta | null;
    cloud: CloudFileMeta | null;
    dirty?: boolean;
    ghost?: boolean;
    pendingGone?: boolean;
}
export type BadgeKind = "syncedBoth" | "dirtyBoth" | "cloudOnly" | "localOnly" | "ghost" | "pendingGone";
export interface GalleryTile {
    name: string;
    displayName: string;
    fullPath: string;
    time: number;
    size: number;
    badge: BadgeKind;
    badgeTitle: string;
    ghost: boolean;
    pendingGone: boolean;
    hasLocalThumb: boolean;
    cloud: CloudFileMeta | null;
    isActive: boolean;
    encrypted: boolean;
}
export declare function tileFor(item: GItem, opts: {
    signedIn: boolean;
    activeName: string | null;
    encrypted?: boolean;
}): GalleryTile;
export interface Crumb {
    label: string;
    path: string;
    current: boolean;
}
export declare function breadcrumb(folder: string): Crumb[];
export interface TrashTile {
    name: string;
    deletedAt: number;
    source: string;
    hasLocalThumb: boolean;
    cloud: CloudFileMeta | null;
    local: LocalSessionMeta | null;
}
export interface TrashGItem {
    name: string;
    deletedAt?: number;
    local: LocalSessionMeta | null;
    cloud: CloudFileMeta | null;
    encrypted?: boolean;
    conflictLive?: boolean;
}
export declare function humanTime(ts: number): string;
export declare function humanSize(b: number | null | undefined): string;
export declare function trashTileFor(item: TrashGItem): TrashTile;
