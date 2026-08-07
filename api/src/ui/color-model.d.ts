export interface Hsv {
    h: number;
    s: number;
    v: number;
}
export declare function hsvToHex(h: number, s: number, v: number): string;
export declare function hexToHsv(hex: string): Hsv;
export declare function normalizeHex(input: string): string | null;
export declare function sameHex(a: string | null, b: string | null): boolean;
