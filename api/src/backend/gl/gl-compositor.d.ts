import type { BlendMode, SourceKind } from "./blend-glsl.ts";
import type { IndexTexture } from "./gpu-tile-pool.ts";
import type { Gl2Port, Gl2Texture, Gl2TexSource, Gl2TileArena, PooledFBO, FBOPrec } from "../../common/gl2-port.ts";
export interface OverlayDesc {
    tex: Gl2TexSource;
    opacity: number;
    erase: boolean;
    blendMode: BlendMode;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
    lockAlpha?: boolean;
    selMask?: {
        tex: Gl2Texture;
        ox: number;
        oy: number;
        ow: number;
        oh: number;
    } | null;
}
export interface FloatDesc {
    tex: Gl2Texture;
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
    constructor(glctx: Gl2Port, accumPrec?: FBOPrec);
    private _ensureProgram;
    begin(_docW: number, _docH: number, resetStats?: boolean): void;
    end(): void;
    newAcc(docW: number, docH: number, bg?: Background): Acc;
    finishAcc(acc: Acc): PooledFBO;
    returnFBO(f: PooledFBO): void;
    private _drawChecker;
    pass(arena: Gl2TileArena, srcKind: SourceKind, srcIndex: IndexTexture | null, groupTex: Gl2TexSource | null, mode: BlendMode, opacity: number, clipIndex: IndexTexture | null, acc: Acc, docW: number, docH: number, overlay?: OverlayDesc | null, clipTex?: Gl2TexSource | null): void;
    floatPass(f: FloatDesc, acc: Acc, docW: number, docH: number, clipBase?: FloatDesc | null): void;
    presentTo(srcTex: Gl2TexSource, target: PooledFBO, w: number, h: number, unpremult?: boolean): void;
    presentToScreenAffine(srcTex: Gl2TexSource, docW: number, docH: number, affine: number[], canvasW: number, canvasH: number, smooth?: boolean, clearColor?: [number, number, number, number] | null): void;
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
}
