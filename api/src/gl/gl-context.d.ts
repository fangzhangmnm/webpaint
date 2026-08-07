export type FBOPrec = "u8" | "f16" | "f32";
export interface GLCaps {
    maxTextureSize: number;
    maxArrayLayers: number;
    maxTextureUnits: number;
    floatColorBuffer: boolean;
}
export interface PooledFBO {
    fbo: WebGLFramebuffer;
    tex: WebGLTexture;
    w: number;
    h: number;
    prec: FBOPrec;
}
export declare class GLContext {
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly gl: WebGL2RenderingContext;
    readonly caps: GLCaps;
    private _programs;
    private _programSrc;
    private _fboPool;
    private _quad;
    onLost: (() => void) | null;
    onRestored: (() => void) | null;
    private _lost;
    private _gen;
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
    get isLost(): boolean;
    get generation(): number;
    program(name: string, vert?: string, frag?: string): WebGLProgram;
    private _compile;
    private _shader;
    borrowFBO(w: number, h: number, prec?: FBOPrec): PooledFBO;
    returnFBO(f: PooledFBO): void;
    private _fboBytes;
    private _poolBytes;
    get fboPoolStats(): {
        count: number;
        bytes: number;
    };
    clearPool(): void;
    private _createFBO;
    quadVAO(): WebGLVertexArrayObject;
    private _rebuildAfterRestore;
}
