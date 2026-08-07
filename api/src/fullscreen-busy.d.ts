export declare function showFullscreenBusy(msg?: string): void;
export declare function hideFullscreenBusy(): void;
export declare function isBusyActive(): boolean;
export declare function withBusy<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
