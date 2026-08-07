export declare const RESAMPLE_MODES: {
    id: string;
    label: string;
    contexts: string[];
}[];
export declare function fillResampleSelect(sel: HTMLSelectElement | null, context: string | null, selected: string): void;
type ResampleSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;
export declare function smartResample(src: ResampleSource, tw: number, th: number): OffscreenCanvas | HTMLCanvasElement;
export declare function fitWithin(src: ResampleSource, maxW: number, maxH: number): {
    source: ResampleSource;
    w: number;
    h: number;
    scaled: boolean;
};
export declare function decodeImageFile(file: Blob): Promise<ImageBitmap | HTMLImageElement>;
export declare function imageSourceToBytes(src: ResampleSource): {
    data: Uint8ClampedArray;
    w: number;
    h: number;
};
export declare function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type?: string): Promise<Blob | null>;
export {};
