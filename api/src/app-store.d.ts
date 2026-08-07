export declare const storeAbsent: boolean;
export declare const provider: import("./store/types.ts").CloudProvider | null;
declare const _auth: {
    isAuthConfigured: typeof import("./store/providers/auth.ts").isAuthConfigured;
    initAuth: typeof import("./store/providers/auth.ts").initAuth;
    signIn: typeof import("./store/providers/auth.ts").signIn;
    signOut: typeof import("./store/providers/auth.ts").signOut;
    getToken: typeof import("./store/providers/auth.ts").getToken;
    isSignedIn: typeof import("./store/providers/auth.ts").isSignedIn;
    getActiveAccount: typeof import("./store/providers/auth.ts").getActiveAccount;
    retrySilentSignIn: typeof import("./store/providers/auth.ts").retrySilentSignIn;
    onAuthChanged: typeof import("./store/providers/auth.ts").onAuthChanged;
    getAuthState: typeof import("./store/providers/auth.ts").getAuthState;
};
export declare const store: {
    file: {
        (name: string, opts: {
            isZip: true;
            mode: "new" | "existing";
        }): import("./store/create-store.ts").ZipFile;
        (name: string, opts: {
            isZip: false;
            mode: "new" | "existing";
        }): import("./store/create-store.ts").RawFile;
        (name: string, opts: {
            isZip: boolean;
            mode: "new" | "existing";
        }): import("./store/create-store.ts").RawFile | import("./store/create-store.ts").ZipFile;
    };
    collection: (name: string, opts?: {
        manual?: boolean;
        local?: boolean;
        getInitData?: import("./store/collection.ts").CollectionConfig["getInitData"];
    }) => import("./store/collection.ts").Collection;
    files: {
        nameOccupied: (name: string) => Promise<boolean>;
        watchFolder: (folder: string, cb: (s: import("./store/listing.ts").FolderSnapshot) => void) => () => void;
        usage: () => Promise<{
            bytes: number;
            count: number;
        }>;
        ensureFolder: (path: string) => Promise<void>;
        newFolder: (path: string) => Promise<void>;
        deleteFolder: (path: string) => Promise<void>;
        drainOfflineQueue: () => Promise<void>;
        listTrash: () => Promise<import("./store/trash-merge.ts").TrashItem[]>;
        listBackup: () => Promise<import("./store/trash-merge.ts").TrashItem[]>;
        restoreTrash: (opts?: import("./store/trash.ts").RestoreOpts | undefined) => Promise<import("./store/trash.ts").TrashResult>;
        purgeTrash: (opts?: import("./store/trash.ts").PurgeOpts | undefined) => Promise<import("./store/trash.ts").TrashResult>;
        emptyTrash: (opts?: import("./store/trash.ts").EmptyTrashOpts | undefined) => Promise<import("./store/trash.ts").TrashResult>;
        emptyBackup: (opts?: import("./store/trash.ts").EmptyTrashOpts | undefined) => Promise<import("./store/trash.ts").TrashResult>;
        reconcileAll: (opts?: {
            activeFileName?: string;
        }) => Promise<{
            demoted: string[];
        }>;
    };
    encryption: {
        isEncryptedBlob: (blob: Blob | Uint8Array) => Promise<boolean>;
        tryDecryptEncryptedBlob: (blob: Blob, pw: string) => Promise<Blob | null>;
        isEncryptedPeekBlob: (blob: Blob | null | undefined) => boolean;
    };
};
export declare const isAuthConfigured: () => boolean;
export declare const initAuth: () => Promise<import("./store/index.ts").AuthState>;
export declare const signIn: () => Promise<unknown>;
export declare const signOut: () => Promise<void>;
export declare const isSignedIn: () => boolean;
export declare const getActiveAccount: () => any;
export declare const retrySilentSignIn: () => Promise<boolean>;
export declare const getToken: () => Promise<string>;
export declare const onAuthChanged: (cb: Parameters<typeof _auth.onAuthChanged>[0]) => () => void;
export declare const getAuthState: () => import("./store/index.ts").AuthState;
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
export declare const brushRackCollection: import("./store/collection.ts").Collection;
export {};
