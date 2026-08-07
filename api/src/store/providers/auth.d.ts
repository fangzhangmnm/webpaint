type Msal = any;
type Account = any;
declare global {
    interface Window {
        msal?: Msal;
    }
}
interface AuthConfig {
    clientId?: string;
    authority?: string;
    scopes?: string[];
    msalUrl?: string | null;
}
export declare function configureOneDriveAuth({ clientId, authority, scopes, msalUrl }?: AuthConfig): void;
export declare function isAuthConfigured(): boolean;
export interface AuthState {
    signedIn: boolean;
    account: Account;
    notConfigured?: boolean;
    probing?: boolean;
    probedAccount?: Account;
}
type AuthSub = (st: AuthState) => void;
export declare function onAuthChanged(cb: AuthSub): () => void;
export declare function getAuthState(): AuthState;
export declare function initAuth(): Promise<AuthState>;
export declare function signIn(): Promise<unknown>;
export declare function signOut(): Promise<void>;
export declare function getToken(): Promise<string>;
export declare function getActiveAccount(): Account;
export declare function isSignedIn(): boolean;
export declare function retrySilentSignIn(): Promise<boolean>;
export {};
