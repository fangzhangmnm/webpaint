import type { Gl2Port, Gl2Caps, FBOPrec, PooledFBO } from "../common/gl2-port.ts";
export declare class BrowserGl2Port implements Gl2Port {
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly gl: WebGL2RenderingContext;
    readonly caps: Gl2Caps;
    private _programs;
    private _programSrc;
    private _fboPool;
    private _quad;
    private _invalidated;
    private _lost;
    private _gen;
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
    get isLost(): boolean;
    get generation(): number;
    onInvalidated(cb: () => void): void;
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
