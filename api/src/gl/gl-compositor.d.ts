import type { BlendMode, SourceKind } from "./blend-glsl.ts";
import type { IndexTexture } from "./gpu-tile-pool.ts";
import type { GLContext, PooledFBO, FBOPrec } from "./gl-context.ts";
export interface OverlayDesc {
    tex: WebGLTexture;
    opacity: number;
    erase: boolean;
    blendMode: BlendMode;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
    lockAlpha?: boolean;
    selMask?: {
        tex: WebGLTexture;
        ox: number;
        oy: number;
        ow: number;
        oh: number;
    } | null;
}
export interface FloatDesc {
    tex: WebGLTexture;
    srcW: number;
    srcH: number;
    hinv: number[];
    mode: number;
}
export type Background = [number, number, number, number] | "checker";
export interface Acc {
    read: PooledFBO;
    write: PooledFBO;
}
export declare class GLCompositor {
    private _glctx;
    private _prec;
    readonly stats: {
        passes: number;
        floatPasses: number;
    };
    constructor(glctx: GLContext, accumPrec?: FBOPrec);
    private _program;
    begin(docW: number, docH: number, resetStats?: boolean): void;
    end(): void;
    newAcc(docW: number, docH: number, bg?: Background): Acc;
    finishAcc(acc: Acc): PooledFBO;
    returnFBO(f: PooledFBO): void;
    private _drawChecker;
    pass(arrayTex: WebGLTexture, srcKind: SourceKind, srcIndex: IndexTexture | null, groupTex: WebGLTexture | null, mode: BlendMode, opacity: number, clipIndex: IndexTexture | null, acc: Acc, docW: number, docH: number, overlay?: OverlayDesc | null, clipTex?: WebGLTexture | null): void;
    floatPass(f: FloatDesc, acc: Acc, docW: number, docH: number, clipBase?: FloatDesc | null): void;
    private _setSampler;
    presentTo(srcTex: WebGLTexture, target: PooledFBO, w: number, h: number, unpremult?: boolean): void;
    presentToScreen(srcTex: WebGLTexture, canvasW: number, canvasH: number): void;
    presentToScreenAffine(srcTex: WebGLTexture, docW: number, docH: number, affine: number[], canvasW: number, canvasH: number, smooth?: boolean): void;
    private _present;
    warpToBytes(srcCanvas: {
        data: Float32Array;
        w: number;
        h: number;
    } | {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    }, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
        dstX: number;
        dstY: number;
    } | null;
    warpToCanvas(src: Parameters<GLCompositor["warpToBytes"]>[0], srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number): {
        canvas: HTMLCanvasElement;
        dstX: number;
        dstY: number;
    } | null;
    private _clear;
}
