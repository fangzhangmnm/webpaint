import type { AppContext } from "./app-context.ts";
export declare function sendSelectionToFill(): void;
export declare function fillPreviewActive(): boolean;
export declare function commitFillNow(): void;
export declare function gateFillOnDocSwitch(ask: () => Promise<"apply" | "discard" | null | undefined>): Promise<boolean>;
export declare function initFillMode(ctx: AppContext): void;
