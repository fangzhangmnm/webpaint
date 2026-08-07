interface SmoothRec {
    rawSX: number;
    rawSY: number;
    stabX: number;
    stabY: number;
    smX: number;
    smY: number;
}
interface SmoothSettings {
    streamline?: number;
    stabilization?: number;
}
export declare function inputSmooth(rec: SmoothRec, settings: SmoothSettings | null | undefined, drx: number, dry: number): {
    x: number;
    y: number;
};
export {};
