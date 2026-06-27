// GLContext —— 单持久 WebGL2 上下文的封装（docs/perf-webgl-memory-clip.md §3 模块 1）。
//
// 职责（窄接口后面藏掉的脏活）：
//   - 取 WebGL2 context（无则响亮失败，由 caller 给「需要 WebGL2」提示——§3 定调不留 2D 回退）。
//   - 能力探测：max texture size / max array layers / float 颜色缓冲 / 纹理单元数。
//   - shader program 编译 + 缓存（按 name 复用，避免重复编译）。
//   - FBO 池：按尺寸借/还离屏渲染目标（合成 ping-pong / 笔刷 stroke FBO 复用）。
//   - 单位 quad VAO（纹理 quad / 全屏 pass 共用）。
//   - **context-loss 生命周期**：listen lost(preventDefault)+restored(重编 program/重建 FBO/
//     fire onRestored → TileResidency 从压缩备份重上传所有 tile)。iOS Safari/PWA 后台必丢 → 这是命门。
//
// 验证边界：本模块全是 gl.* 调用，node DOM-shim 下是 no-op → **node 测不了，真机批验证**。
//   故刻意只放标准、可读、无分支魔法的 GL 样板；易错点（FBO 完整性 / float 目标 params）逐行注释。

export interface GLCaps {
  maxTextureSize: number;        // MAX_TEXTURE_SIZE（iPad Apple GPU ≥ 16384）
  maxArrayLayers: number;        // MAX_ARRAY_TEXTURE_LAYERS（tile 池深度上界）
  maxTextureUnits: number;       // MAX_TEXTURE_IMAGE_UNITS（≥16；用不到那么多，ping-pong 逐层叠）
  floatColorBuffer: boolean;     // 能否渲到 RGBA16F（§7 banding bonus + 16F 累积）
}

// 池化的离屏渲染目标：framebuffer + 它的颜色纹理。
export interface PooledFBO {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
  float: boolean;
}

export class GLContext {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCaps;

  private _programs = new Map<string, WebGLProgram>();
  private _programSrc = new Map<string, { vert: string; frag: string }>();   // 重建用
  private _fboPool: PooledFBO[] = [];      // 已归还、待复用
  private _quad: WebGLVertexArrayObject | null = null;

  onLost: (() => void) | null = null;
  onRestored: (() => void) | null = null;
  private _lost = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const attrs: WebGLContextAttributes = {
      alpha: false,              // 板背景不透明（与现 board {alpha:false} 一致）
      antialias: false,          // 我们自己控合成，不要 MSAA
      depth: false,
      stencil: false,
      premultipliedAlpha: true,  // 合成走预乘 alpha（blend 数学的前提，见 compositor）
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    };
    const gl = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WEBGL2_UNAVAILABLE");   // caller 给中文「需要 WebGL2」提示
    this.gl = gl;

    // float 颜色缓冲：WebGL2 多数原生，部分要 EXT_color_buffer_float。两路都试。
    const floatExt = gl.getExtension("EXT_color_buffer_float");
    this.caps = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
      floatColorBuffer: !!floatExt,
    };

    // context-loss 生命周期。lost 必 preventDefault 才有机会 restored。
    const el = canvas as { addEventListener?: (t: string, cb: (e: Event) => void) => void };
    el.addEventListener?.("webglcontextlost", (e: Event) => {
      e.preventDefault();
      this._lost = true;
      this.onLost?.();
    });
    el.addEventListener?.("webglcontextrestored", () => {
      this._lost = false;
      this._rebuildAfterRestore();
      this.onRestored?.();   // TileResidency 在此从备份重上传所有 tile
    });
  }

  get isLost(): boolean { return this._lost; }

  // ---- shader program 缓存 ----
  // 按 name 取已编译 program；首次需给源。源被记下，context restored 后自动重编。
  program(name: string, vert?: string, frag?: string): WebGLProgram {
    const cached = this._programs.get(name);
    if (cached) return cached;
    if (vert == null || frag == null) throw new Error(`PROGRAM_NOT_BUILT:${name}`);
    this._programSrc.set(name, { vert, frag });
    const p = this._compile(vert, frag, name);
    this._programs.set(name, p);
    return p;
  }

  private _compile(vert: string, frag: string, name: string): WebGLProgram {
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, vert, name);
    const fs = this._shader(gl.FRAGMENT_SHADER, frag, name);
    const p = gl.createProgram();
    if (!p) throw new Error("CREATE_PROGRAM_FAILED");
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    // link 错只在 !LINK_STATUS 时拉 log（getProgramInfoLog 同步 stall，故守门后取）。
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      throw new Error(`LINK_FAILED:${name}:${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
  }

  private _shader(type: number, src: string, name: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type);
    if (!s) throw new Error("CREATE_SHADER_FAILED");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error(`COMPILE_FAILED:${name}:${log}`);
    }
    return s;
  }

  // ---- FBO 池 ----
  // 借一个 ≥ 请求尺寸的渲染目标。float=true 要 RGBA16F（caps.floatColorBuffer 须真）。
  // 池里找精确同尺寸同 float 的复用；否则新建。用完 returnFBO 还回。
  borrowFBO(w: number, h: number, float = false): PooledFBO {
    for (let i = 0; i < this._fboPool.length; i++) {
      const f = this._fboPool[i];
      if (f.w === w && f.h === h && f.float === float) {
        this._fboPool.splice(i, 1);
        return f;
      }
    }
    return this._createFBO(w, h, float);
  }

  returnFBO(f: PooledFBO): void {
    this._fboPool.push(f);
  }

  private _createFBO(w: number, h: number, float: boolean): PooledFBO {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("CREATE_TEXTURE_FAILED");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // float 目标用 RGBA16F + HALF_FLOAT；否则 RGBA8。线性过滤给视口缩放采样用。
    const internal = float ? gl.RGBA16F : gl.RGBA8;
    const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("CREATE_FRAMEBUFFER_FAILED");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    // 完整性检查（真机易错点：float 目标在某些设备非 color-renderable）。
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`FBO_INCOMPLETE:0x${status.toString(16)}:float=${float}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, tex, w, h, float };
  }

  // ---- 单位 quad（两个三角形覆盖 [0,1]²；位置即 uv）----
  quadVAO(): WebGLVertexArrayObject {
    if (this._quad) return this._quad;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("CREATE_VAO_FAILED");
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // 两个三角形：(0,0)(1,0)(0,1) + (0,1)(1,0)(1,1)
    const verts = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this._quad = vao;
    return vao;
  }

  // context restored 后：旧 GL 对象句柄全失效 → 重编所有 program、清空 FBO 池（按需重建）、丢 quad。
  // tile 纹理由 TileResidency 在 onRestored 回调里从备份重上传（本模块不持 tile）。
  private _rebuildAfterRestore(): void {
    this._programs.clear();
    for (const [name, src] of this._programSrc) {
      this._programs.set(name, this._compile(src.vert, src.frag, name));
    }
    this._fboPool = [];   // 旧 fbo/tex 句柄已废；池清空，borrow 时重建
    this._quad = null;
  }
}
