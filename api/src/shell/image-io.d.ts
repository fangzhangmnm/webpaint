export type DecodedImage = ImageBitmap | HTMLImageElement;
export declare function decodeImageFile(file: Blob): Promise<DecodedImage>;
export declare function imageSourceToBytes(src: DecodedImage | HTMLCanvasElement | OffscreenCanvas): {
    data: Uint8ClampedArray;
    w: number;
    h: number;
};
export declare function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type?: string): Promise<Blob | null>;
