import type { AppContext } from "./app-context.ts";
export declare function _openImagePicker(): void;
export declare function importImageAsNewDoc(file: File): Promise<void>;
export declare function importImageAsLayer(file: File, opts?: {
    center?: {
        x: number;
        y: number;
    };
}): Promise<void>;
export declare function initImportImage(ctx: AppContext): void;
export declare function setAddImportAsNewDoc(v: boolean): void;
