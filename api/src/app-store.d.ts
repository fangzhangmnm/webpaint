import type { Store } from "./store/index.ts";
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
export type AppStorePort = Pick<Store, "file" | "files" | "collection" | "encryption">;
export declare const store: AppStorePort;
export type { Collection, EncryptedBlob } from "./store/index.ts";
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
export declare const brushRackCollection: import("./app-store.ts").Collection;
