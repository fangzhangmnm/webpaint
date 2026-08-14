import type { Collection, Store } from "@internal/store";
export declare function detectStoreAbsent(): boolean;
type InitItem = {
    id: string;
    value: unknown;
};
export declare function createMemoryCollection(opts?: {
    getInitData?: () => InitItem[] | Promise<InitItem[]>;
}): Collection;
export declare function createNullStore(): Store;
export declare function createDormantAuth(): {
    isAuthConfigured: () => boolean;
    initAuth: () => Promise<void>;
    signIn: () => Promise<never>;
    signOut: () => Promise<void>;
    isSignedIn: () => boolean;
    getActiveAccount: () => null;
    retrySilentSignIn: () => Promise<boolean>;
    getToken: () => Promise<null>;
    onAuthChanged: (_cb: unknown) => () => void;
    getAuthState: () => {
        signedIn: boolean;
    };
};
export {};
