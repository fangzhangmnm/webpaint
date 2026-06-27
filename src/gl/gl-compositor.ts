// GLCompositor —— WebGL2 图层合成器（docs/perf-webgl-memory-clip.md §3 模块 4）。
//
// 算法：ping-pong 两张预乘 RGBA16F 累积器，**一层一 pass**——每 pass 采（累积器, 源 tile）→
//   W3C blend + source-over 合成（blend-glsl.ts）→ 写另一张累积器、交换。N 层 = N pass。
//   clip = shader 里源 alpha × 基底 alpha（无 2D 的 dst-in dance；静态层 tile 已在 GPU → 重合便宜）。
//
// **本文件当前是 Stage 2a-0 切片**：扁平层（每层单 tile，按 slice 直采）。多 tile（tile-index map）、
//   组隔离、pass-through、overlay/float 注入 = 2a-1/2b/2c 续接。先用最小铺垫把**最难的 blend 数学**
//   用同引擎 2D-vs-GL 自 diff 钉死，再加 tiling 一般性。
//
// 验证：纯 gl.*，node no-op → smoke harness 自 diff（vs Canvas2D 原生 blend，12 模式）。

import { COMPOSITE_VERT, compositeFragSource, compositeProgramKey } from "./blend-glsl.ts";
import type { BlendMode } from "./blend-glsl.ts";
import type { GLContext, PooledFBO, FBOPrec } from "./gl-context.ts";

// 扁平层描述（2a-0）：源 tile slice、不透明度、blend、剪裁基底 slice（-1=无）。
export interface FlatLayer {
  slice: number;
  opacity: number;
  mode: BlendMode;
  clipSlice: number;
}

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;     // 预乘累积器
out vec4 o;
void main(){
  vec4 p = texture(u_src, v_uv);
  vec3 c = (p.a > 0.0) ? (p.rgb / p.a) : vec3(0.0);   // 解预乘 → 直值
  o = vec4(c, p.a);
}`;

export class GLCompositor {
  private _glctx: GLContext;
  // 累积器精度：默认 f16（省一半 transient + banding bonus）。f32 = 精度上限（陡 blend 模式更准）。
  private _prec: FBOPrec;
  constructor(glctx: GLContext, accumPrec: FBOPrec = "f16") {
    this._glctx = glctx;
    this._prec = accumPrec;
  }

  private _blendProgram(mode: BlendMode): WebGLProgram {
    return this._glctx.program(compositeProgramKey(mode), COMPOSITE_VERT, compositeFragSource(mode));
  }

  // 自底向上合成 layers 进一张预乘累积器 FBO 返回。caller 负责 returnFBO（或转 present）。
  compositeFlat(arrayTex: WebGLTexture, layers: FlatLayer[], w: number, h: number): PooledFBO {
    const gl = this._glctx.gl;
    let read = this._glctx.borrowFBO(w, h, this._prec);
    let write = this._glctx.borrowFBO(w, h, this._prec);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);   // shader 手动合成，关固定功能 blend

    this._clearFBO(read);

    for (const layer of layers) {
      const prog = this._blendProgram(layer.mode);
      gl.useProgram(prog);
      gl.uniform1f(gl.getUniformLocation(prog, "u_srcSlice"), layer.slice);
      gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), layer.opacity);
      gl.uniform1f(gl.getUniformLocation(prog, "u_clipSlice"), layer.clipSlice);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_arr"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, read.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_dst"), 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const tmp = read; read = write; write = tmp;   // 交换
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    this._glctx.returnFBO(write);   // 闲置那张还池
    return read;                    // 最终结果（预乘）
  }

  // 预乘累积器 → 直值 RGBA8 目标 FBO（解预乘 present）。给 readback/屏显用。
  presentTo(srcTex: WebGLTexture, target: PooledFBO, w: number, h: number): void {
    const gl = this._glctx.gl;
    const prog = this._glctx.program("present", COMPOSITE_VERT, PRESENT_FRAG);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  private _clearFBO(f: PooledFBO): void {
    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
