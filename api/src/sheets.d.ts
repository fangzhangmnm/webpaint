export declare function openInputSheet(title: string, defaultValue?: string, { placeholder, password, message }?: {
    placeholder?: string | undefined;
    password?: boolean | undefined;
    message?: string | undefined;
}): Promise<string | null>;
export declare function openConfirmSheet(title: string, message: string): Promise<boolean>;
export declare function openChoiceSheet<T>(title: string, message: string, choices: {
    label: string;
    value: T;
    primary?: boolean;
}[]): Promise<T | null>;
interface SyncGateAction<T = string> {
    label: string;
    value: T;
    primary?: boolean;
}
interface SyncGateOpts<T = string> {
    title: string;
    message: string;
    showSpinner?: boolean;
    actions: SyncGateAction<T>[];
    note?: string;
}
export declare function lockSyncGate<T = string>({ title, message, showSpinner, actions, note }: SyncGateOpts<T>): Promise<T>;
export declare function unlockSyncGate(): void;
export declare function settleSyncGate(value: unknown): void;
export {};
