import type { AppContext } from "./app-context.ts";
export declare const THEMES: string[];
export declare function themeLabel(th: string): string;
export declare function applyTheme(th: string): void;
export declare function cycleTheme(): string;
export declare function currentTheme(): string;
export declare function reconcileThemeFromPrefs(): void;
export declare function initTheme(ctx: AppContext): void;
