import { WpReferenceWindow } from "./frontend/reference-window.ts";
import { PaletteWindow } from "./palette.ts";
import type { AppContext } from "./app-context.ts";
export declare const referenceWindow: WpReferenceWindow;
export declare const paletteWindow: PaletteWindow;
export declare function initSideWindows(ctx: AppContext): void;
export declare function setReferenceFromFile(file: File | Blob): Promise<void>;
