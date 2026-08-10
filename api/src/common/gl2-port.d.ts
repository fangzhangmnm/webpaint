export type FBOPrec = "u8" | "f16" | "f32";
export interface Gl2Caps {
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
export interface Gl2Port {
    readonly caps: Gl2Caps;
    readonly isLost: boolean;
    readonly generation: number;
    onInvalidated(cb: () => void): void;
    program(name: string, vert?: string, frag?: string): WebGLProgram;
    borrowFBO(w: number, h: number, prec?: FBOPrec): PooledFBO;
    returnFBO(f: PooledFBO): void;
    clearPool(): void;
    readonly fboPoolStats: {
        count: number;
        bytes: number;
    };
    quadVAO(): WebGLVertexArrayObject;
    readonly gl: WebGL2RenderingContext;
}
