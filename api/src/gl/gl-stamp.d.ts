import type { GLContext, PooledFBO } from "./gl-context.ts";
export interface Stamp {
    x: number;
    y: number;
    size: number;
    alpha: number;
}
export interface StrokeShape {
    hardness: number;
    color: [number, number, number];
    buildup: boolean;
    aspect?: number;
    rotation?: number;
}
export declare class GLStampRasterizer {
    private _glctx;
    private _vao;
    private _instBuf;
    private _vaoGen;
    private _instData;
    constructor(glctx: GLContext);
    private _ensureVAO;
    rasterize(stamps: Stamp[], shape: StrokeShape, ox: number, oy: number, ow: number, oh: number, scissor?: {
        x: number;
        y: number;
        w: number;
        h: number;
    } | null): PooledFBO;
}
