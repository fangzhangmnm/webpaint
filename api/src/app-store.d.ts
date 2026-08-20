import type { Store } from "@internal/store";
export declare const storeAbsent: boolean;
export declare const provider: import("@internal/store").CloudProvider | null;
declare const _auth: import("@internal/store").OneDriveAuth;
export type AppStorePort = Pick<Store, "file" | "files" | "collection" | "encryption">;
export declare const store: AppStorePort;
export type { Collection, EncryptedBlob } from "@internal/store";
export declare const isAuthConfigured: () => boolean;
export declare const initAuth: () => Promise<import("@internal/store").AuthState>;
export declare const signIn: () => Promise<unknown>;
export declare const signOut: () => Promise<void>;
export declare const isSignedIn: () => boolean;
export declare const getActiveAccount: () => any;
export declare const retrySilentSignIn: () => Promise<boolean>;
export declare const getToken: () => Promise<string>;
export declare const onAuthChanged: (cb: Parameters<typeof _auth.onAuthChanged>[0]) => () => void;
export declare const getAuthState: () => import("@internal/store").AuthState;
declare function itemToG(it: {
    path: string;
    syncState: string;
    lastModified?: number;
    size?: number;
}): {
    name: string;
    local: {
        name: string;
        size: number | undefined;
        updatedAt: number | undefined;
    } | null;
    cloud: {
        path: string;
        name: string;
        size: number | undefined;
        lastModifiedDateTime: string | undefined;
    } | null;
    dirty: boolean;
    ghost: boolean;
    pendingGone: boolean;
};
export declare function watchFolder(folder: string, cb: (snap: {
    path: string;
    items: ReturnType<typeof itemToG>[];
    folderNames: string[];
}) => void): () => void;
export interface CloudImageItem {
    path: string;
    name: string;
    size?: number;
    lastModified?: number;
    cached: boolean;
}
export declare function watchFolderImages(folder: string, cb: (snap: {
    path: string;
    images: CloudImageItem[];
    folderNames: string[];
}) => void): () => void;
/** picker 选中后取整份图片字节（本地缓存优先、整份拉云、autoCacheOpenedFile 顺手落缓存）。拿不到 → null。 */
export declare const openCloudImage: (path: string) => Promise<Blob | null>;
export declare const listGalleryTrash: () => Promise<{
    name: string;
    deletedAt: number;
    encrypted: boolean;
    conflictLive: boolean;
    local: {
        name: string;
        trashKey: string;
        encrypted: boolean;
    } | null;
    cloud: {
        path: string;
        id: string;
    } | null;
}[]>;
export declare const brushRackCollection: import("@internal/store").Collection;
