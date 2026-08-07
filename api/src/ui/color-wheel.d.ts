export declare const ColorWheel: any;
export interface ColorWheelHandle {
    setColor(hex: string): void;
    unmount(): void;
}
export declare function mountColorWheel(el: HTMLElement, opts: {
    getColor: () => string;
    onPick: (hex: string) => void;
}): ColorWheelHandle;
