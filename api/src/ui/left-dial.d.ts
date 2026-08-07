export interface LeftDialOpts {
    getSize(): number;
    getOpacity(): number;
    getSizeMax(): number;
    getBrushName(): string;
    getCanDraw(): boolean;
    getZoom(): number;
    onSize(px: number): void;
    onOpacity(frac: number): void;
    onBrushTap(): void;
    onBrushLongpress(): void;
    getPressureDisabled(): boolean;
    onTogglePressure(v: boolean): void;
}
export interface LeftDialHandle {
    flashSize(): void;
    unmount(): void;
}
export declare function mountLeftDial(el: HTMLElement, opts: LeftDialOpts): LeftDialHandle;
