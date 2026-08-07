import type { Brush } from "../brush-types.ts";
export interface RackSheetOpts {
    defaultFolder: string;
    getBrushes(): Brush[];
    getRackEmpty(): boolean;
    getFolder(): string;
    getActiveId(): string | null;
    onSelectFolder(f: string): void;
    onSelectBrush(id: string): void;
    onEditBrush(id: string): void;
    onReset(): void;
}
export interface RackSheetHandle {
    unmount(): void;
}
export declare function mountRackSheet(el: HTMLElement, opts: RackSheetOpts): RackSheetHandle;
