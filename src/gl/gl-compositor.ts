// GLCompositor —— WebGL2 图层合成器（docs/perf-webgl-memory-clip.md §3 模块 4）。
//
// 算法：ping-pong 两张预乘累积器，**一层一 pass**——每 pass 全屏，shader 按 doc 坐标查 tile-index
//   采源 + 累积器（预乘）→ W3C blend + source-over → 写另一张、交换。clip = 源α×基底α（无 2D dst-in）。
// 组（递归）：
//   - pass-through 组（唯一非隔离态）：子层直接落**同一**累积器（能与组下方层混）。
//   - 隔离组（mode≠pass-through || opacity<1 || clip）：子层先合到**独立** sub-accumulator，
//     再当一个组单元（group 源 shader：采预乘 sub-accumulator 解预乘）按 group.opacity/mode/clip 整体混。
//   隔离/clip 判定与基底解析全走 gl-compose-plan.ts（与 2D layer-composite.ts 逐条对齐）。
//
// 待续：overlay/float 注入（2c）；组作 clip 基底（罕见，现仅支持叶作基底）。
// 验证：纯 gl.*，node no-op → smoke 拿真 layer-composite.ts compositeLayers 当 golden 对拍（组/clip/嵌套）。

import { COMPOSITE_VERT, compositeFragSource, compositeProgramKey } from "./blend-glsl.ts";
import type { BlendMode, SourceKind } from "./blend-glsl.ts";
import { resolveClipBases, needsIsolation, groupUnitMode } from "./gl-compose-plan.ts";
import type { CompNode, OverlayDesc } from "./gl-compose-plan.ts";
import type { TileIndexTexture } from "./tile-index.ts";
import type { GLContext, PooledFBO, FBOPrec } from "./gl-context.ts";

// 可变 ping-pong 对（pass-through 组要在同一累积器上续 pass，故按引用传递）。
interface Acc { read: PooledFBO; write: PooledFBO; }

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 o;
void main(){
  vec4 p = texture(u_src, v_uv);
  vec3 c = (p.a > 0.0) ? (p.rgb / p.a) : vec3(0.0);
  o = vec4(c, p.a);
}`;

export class GLCompositor {
  private _glctx: GLContext;
  private _prec: FBOPrec;
  constructor(glctx: GLContext, accumPrec: FBOPrec = "f16") {
    this._glctx = glctx;
    this._prec = accumPrec;
  }

  private _program(mode: BlendMode, src: SourceKind): WebGLProgram {
    return this._glctx.program(compositeProgramKey(mode, src), COMPOSITE_VERT, compositeFragSource(mode, src));
  }

  // 合成一个层级的兄弟节点（自底向上）进一张预乘累积器 FBO 返回（透明底）。caller 负责 returnFBO。
  // arrayTex = TileBackend 稀疏 tile 池纹理；docW/H = doc 像素尺寸。
  // VAO/viewport 在此绑定一次；隔离组递归走 _composeFresh（**不碰 VAO**，否则解绑会废掉外层后续 pass）。
  composite(arrayTex: WebGLTexture, nodes: CompNode[], docW: number, docH: number): PooledFBO {
    const gl = this._glctx.gl;
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, docW, docH);
    gl.disable(gl.BLEND);
    const result = this._composeFresh(arrayTex, nodes, docW, docH);
    gl.bindVertexArray(null);
    return result;
  }

  // 内部：合兄弟数组进一张新累积器返回（假设 VAO 已绑、viewport 已设）。隔离组递归用它。
  private _composeFresh(arrayTex: WebGLTexture, nodes: CompNode[], docW: number, docH: number): PooledFBO {
    const acc: Acc = {
      read: this._glctx.borrowFBO(docW, docH, this._prec),
      write: this._glctx.borrowFBO(docW, docH, this._prec),
    };
    this._clear(acc.read);
    this._applyNodes(arrayTex, nodes, acc, docW, docH);
    this._glctx.returnFBO(acc.write);
    return acc.read;
  }

  // 把兄弟节点逐个 pass 到 acc（pass-through 组递归到同一 acc；隔离组先合 sub 再整体混）。
  private _applyNodes(arrayTex: WebGLTexture, nodes: CompNode[], acc: Acc, docW: number, docH: number): void {
    const bases = resolveClipBases(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.visible) continue;
      const base = bases[i];
      if (node.clip && !base) continue;   // clip 无基底 → 不渲染
      // clip 基底：仅支持叶作基底（其 tile-index 即蒙版）。组作基底罕见，暂不支持（当无 clip）。
      const clipIndex = base && base.kind === "leaf" ? base.srcIndex : null;

      if (node.kind === "leaf") {
        const srcKind = node.overlay ? "overlay" : "tiled";
        this._pass(arrayTex, srcKind, node.srcIndex, null, node.mode, node.opacity, clipIndex, acc, docW, docH, node.overlay ?? null);
      } else if (needsIsolation(node)) {
        const sub = this._composeFresh(arrayTex, node.children, docW, docH);   // 独立 sub-accumulator（不碰 VAO）
        this._pass(arrayTex, "group", null, sub.tex, groupUnitMode(node), node.opacity, clipIndex, acc, docW, docH);
        this._glctx.returnFBO(sub);
      } else {
        this._applyNodes(arrayTex, node.children, acc, docW, docH);        // pass-through：续同一 acc
      }
    }
  }

  // 一个 blend pass：src(tiled 叶 / group 预乘纹理) 与 acc.read 合 → acc.write，交换。
  private _pass(
    arrayTex: WebGLTexture, srcKind: SourceKind,
    srcIndex: TileIndexTexture | null, groupTex: WebGLTexture | null,
    mode: BlendMode, opacity: number, clipIndex: TileIndexTexture | null,
    acc: Acc, docW: number, docH: number, overlay: OverlayDesc | null = null,
  ): void {
    const gl = this._glctx.gl;
    const prog = this._program(mode, srcKind);
    gl.useProgram(prog);
    const u = (name: string) => gl.getUniformLocation(prog, name);
    gl.uniform2f(u("u_docSize"), docW, docH);
    gl.uniform1f(u("u_opacity"), opacity);
    gl.uniform1i(u("u_hasClip"), clipIndex ? 1 : 0);
    gl.uniform1f(u("u_overlayOpacity"), overlay ? overlay.opacity : 1);
    gl.uniform1i(u("u_overlayErase"), overlay && overlay.erase ? 1 : 0);
    // **每个 sampler 固定单元 + 对未激活的也绑 2D 占位**：否则未被编译器消除的未用 sampler 默认落
    //   单元 0（= u_arr 的 sampler2DArray）→ 类型冲突 INVALID_OPERATION(0x502)。占位用 acc.read（2D）。
    const ph = acc.read.tex;   // 2D 占位纹理
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTex);
    this._setSampler(prog, "u_arr", 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, acc.read.tex);
    this._setSampler(prog, "u_dst", 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, srcIndex?.tex ?? ph);
    this._setSampler(prog, "u_srcIndex", 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, (clipIndex ?? srcIndex)?.tex ?? ph);
    this._setSampler(prog, "u_clipIndex", 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, groupTex ?? ph);
    this._setSampler(prog, "u_groupSrc", 4);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, overlay?.tex ?? ph);
    this._setSampler(prog, "u_overlay", 5);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.write.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const tmp = acc.read; acc.read = acc.write; acc.write = tmp;   // 交换
  }

  // 仅当 uniform 未被编译器优化掉（location 非 null）才设——unused sampler 安全跳过。
  private _setSampler(prog: WebGLProgram, name: string, unit: number): void {
    const loc = this._glctx.gl.getUniformLocation(prog, name);
    if (loc) this._glctx.gl.uniform1i(loc, unit);
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
    this._setSampler(prog, "u_src", 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  private _clear(f: PooledFBO): void {
    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
