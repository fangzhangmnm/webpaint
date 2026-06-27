// GLCompositor —— WebGL2 图层合成器（docs/perf-webgl-memory-clip.md §3 模块 4）。
//
// 算法：ping-pong 两张预乘累积器，**一层一 pass**——每 pass 全屏，shader 按 doc 坐标查该层 tile-index
//   定位 tile、采源（直值）+ 累积器（预乘）→ W3C blend + source-over 合成 → 写另一张累积器、交换。
//   N 层 = N pass。clip = shader 里源 alpha × 基底 alpha（无 2D dst-in dance）。多 tile 层无需多 draw。
//
// **当前是 Stage 2 扁平切片**：单层级兄弟数组（无组隔离/pass-through/overlay/float）。组递归 = 2b 续接。
//
// 验证：纯 gl.*，node no-op → smoke harness 自 diff（12 blend + clip + 多 tile，vs Canvas2D）。

import { COMPOSITE_VERT, compositeFragSource, compositeProgramKey } from "./blend-glsl.ts";
import type { BlendMode } from "./blend-glsl.ts";
import type { TileIndexTexture } from "./tile-index.ts";
import type { GLContext, PooledFBO, FBOPrec } from "./gl-context.ts";

// 合成层描述：源层 tile-index、不透明度、blend、剪裁基底 tile-index（null=无 clip）。
export interface TiledLayer {
  srcIndex: TileIndexTexture;
  opacity: number;
  mode: BlendMode;
  clipIndex: TileIndexTexture | null;
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

  // 自底向上合成 layers 进一张预乘累积器 FBO 返回。docW/H = doc 像素尺寸（累积器尺寸 + shader docPos）。
  // caller 负责 returnFBO（或转 present）。arrayTex = TileBackend 的稀疏 tile 池纹理。
  composite(arrayTex: WebGLTexture, layers: TiledLayer[], docW: number, docH: number): PooledFBO {
    const gl = this._glctx.gl;
    let read = this._glctx.borrowFBO(docW, docH, this._prec);
    let write = this._glctx.borrowFBO(docW, docH, this._prec);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, docW, docH);
    gl.disable(gl.BLEND);   // shader 手动合成，关固定功能 blend

    this._clearFBO(read);

    for (const layer of layers) {
      const prog = this._blendProgram(layer.mode);
      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, "u_docSize"), docW, docH);
      gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), layer.opacity);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasClip"), layer.clipIndex ? 1 : 0);
      // 纹理单元：0=tile 池 array，1=累积器(read)，2=源 index，3=clip index
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_arr"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, read.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_dst"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, layer.srcIndex.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_srcIndex"), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, (layer.clipIndex ?? layer.srcIndex).tex);   // 无 clip 时绑个占位，shader 不读
      gl.uniform1i(gl.getUniformLocation(prog, "u_clipIndex"), 3);
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
