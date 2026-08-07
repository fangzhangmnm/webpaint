declare const KEYS: {
    readonly theme: "webpaint.boot.theme";
    readonly lang: "webpaint.boot.lang";
};
export type BootSnapshotKey = keyof typeof KEYS;
export declare function readBootSnapshot(k: BootSnapshotKey): string | null;
export declare function writeBootSnapshot(k: BootSnapshotKey, v: string | null): void;
export {};
