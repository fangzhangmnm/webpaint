import { SMOOTH_DEFAULTS } from "./common/smooth-defaults.ts";
export { SMOOTH_DEFAULTS } from "./common/smooth-defaults.ts";
export declare const SMOOTH: Record<keyof typeof SMOOTH_DEFAULTS, number>;
export declare function hydrateSmoothFromPrefs(): void;
export declare function saveSmooth(): void;
export declare function resetSmooth(): void;
