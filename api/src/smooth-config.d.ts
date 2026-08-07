export declare const SMOOTH_DEFAULTS: Readonly<{
    tauMaxMs: 500;
    tailBow: 1;
    stabMaxPx: 8;
    rawStaticSq: 0.005;
    pressureAlpha: 0.4;
}>;
export declare const SMOOTH: Record<keyof typeof SMOOTH_DEFAULTS, number>;
export declare function hydrateSmoothFromPrefs(): void;
export declare function saveSmooth(): void;
export declare function resetSmooth(): void;
