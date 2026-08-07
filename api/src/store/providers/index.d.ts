import { configureOneDriveAuth, isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState } from "./auth.ts";
interface OneDriveConfig {
    clientId?: string;
    authority?: string;
    scopes?: string[];
    msalUrl?: string | null;
}
export declare function createOneDriveProvider(config?: OneDriveConfig): {
    provider: import("../types.ts").CloudProvider;
    auth: {
        isAuthConfigured: typeof isAuthConfigured;
        initAuth: typeof initAuth;
        signIn: typeof signIn;
        signOut: typeof signOut;
        getToken: typeof getToken;
        isSignedIn: typeof isSignedIn;
        getActiveAccount: typeof getActiveAccount;
        retrySilentSignIn: typeof retrySilentSignIn;
        onAuthChanged: typeof onAuthChanged;
        getAuthState: typeof getAuthState;
    };
};
export { configureOneDriveAuth };
