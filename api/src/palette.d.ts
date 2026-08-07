interface RGB {
    r: number;
    g: number;
    b: number;
}
type PaletteMode = "brush" | "mix" | "picker";
interface PaletteWindowOptions {
    root: HTMLElement;
    onColorSampled: (hex: string) => void;
    getCurrentColor?: () => string;
}
interface PaletteSerializedState {
    open: boolean;
    mode: PaletteMode;
    imageB64: string;
    position: {
        left: string;
        top: string;
    } | null;
}
export declare class PaletteWindow {
    root: HTMLElement;
    onColorSampled: (hex: string) => void;
    getCurrentColor: () => string;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    mode: PaletteMode;
    _open: boolean;
    constructor({ root, onColorSampled, getCurrentColor }: PaletteWindowOptions);
    _fillBackground(): void;
    clear(): void;
    open(): void;
    close(): void;
    toggle(): void;
    isOpen(): boolean;
    setMode(m: string): void;
    _refreshToolButtons(): void;
    _wireToolButtons(): void;
    _toLocal(e: PointerEvent): {
        x: number;
        y: number;
    };
    _sample(x: number, y: number): RGB;
    _toHex({ r, g, b }: RGB): string;
    _wireEvents(): void;
    _paint(x: number, y: number, loaded: RGB | null): void;
    _wireDrag(): void;
    getSerializedState(): {
        open: boolean;
        mode: PaletteMode;
        imageB64: string;
        position: {
            left: string;
            top: string;
        } | null;
    } | null;
    applySerializedState(s: PaletteSerializedState | null): void;
}
export {};
