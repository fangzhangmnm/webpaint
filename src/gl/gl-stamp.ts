// GLStampRasterizer —— GPU 栅格化一条 stroke 的 stamp 列表（Stage 3：「改成 webgl」primary）。
//
// 切法（手感红线安全）：CPU 仍出 stamp 列表（brush.ts 的 _walkStamps 间距 + _stampParams 压感/taper，
//   手感数学一字不动）；本模块只接管**逐像素 falloff + buildup/wash 累积** → 一张 bbox 预乘 RGBA 纹理
//   （= live overlay / commit 的源）。falloff/累积逐位匹配 brush.ts（_getStamp:221 / _washMaxInto:867 /
//   _buildupOverInto:802），golden 对拍现 CPU 笔刷。
//
// 累积模型（与 CPU 对齐）：
//   - dab α = stampAlpha × shapeA；shapeA = falloff(dist)。
//   - Wash（Alpha-Darken）：accum.a = max(accum.a, dabA)（blendEquation MAX）→ 末了上色 = premult(color, a)。
//   - Build-Up（source-over）：accum = premult(color, dabA) over（blendFunc ONE,1-SRCA）。
//   - Π-outer 的 user.opacity **不在这里**（commit/overlay 时一次性乘，对齐 brush.ts:24-26）。
//
// 椭圆 stamp：fragment 对 doc 偏移做旋转(-rotation)+1/aspect 逆变换再算 dist（逐位匹配 _washMaxInto:838-856）；
//   圆形 = aspect=1/rotation=0 的退化（同一路径）。quad 用 radius·max(1,aspect) 外接盒 over-cover，frag discard 出界。

import type { GLContext, PooledFBO } from "./gl-context.ts";

// 一个 stamp：doc 坐标中心 + 直径 + 该 dab 的 α（= _stampParams.stampAlpha）。
export interface Stamp { x: number; y: number; size: number; alpha: number; }

export interface StrokeShape {
  hardness: number;                  // 0..0.999（硬芯比例）
  color: [number, number, number];   // 0..1（线性前的 sRGB 字节/255；与 CPU 同域）
  buildup: boolean;                   // true=Build-Up(source-over) / false=Wash(max)
  aspect?: number;                    // 椭圆纵横比（默认 1=圆）
  rotation?: number;                  // 椭圆旋转弧度（默认 0）
}

// 累积 stamp 的顶点 shader：单位 quad → stamp 包围盒（doc→clip）。v_local = 相对中心的像素偏移。
const ACCUM_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_quad;        // [0,1]²
uniform vec2 u_bboxOrigin;                // bbox 左上 doc 坐标
uniform vec2 u_bboxSize;                  // bbox 像素尺寸
uniform vec2 u_center;                    // stamp 中心 doc
uniform float u_radius;                   // size/2（+1 像素余量在 caller）
uniform float u_aspect;                   // 椭圆纵横比（1=圆）
out vec2 v_local;                         // 相对中心像素偏移（doc 轴对齐）
void main() {
  float rext = u_radius * max(1.0, u_aspect);      // 椭圆外接盒半边（over-cover，frag discard 出界）
  vec2 corner = (a_quad * 2.0 - 1.0) * rext;       // [-rext,rext]²
  vec2 docPos = u_center + corner;
  v_local = corner;
  vec2 uv = (docPos - u_bboxOrigin) / u_bboxSize;  // 0..1 in bbox
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);    // bbox 左上=clip(-1,1)（present 时 y 由 caller 约定）
}`;

// falloff（逐位匹配 brush.ts:217-221 / 862-867）+ 输出该 dab 贡献。
// Wash：frag 出 (0,0,0,dabA)，外部 MAX blend。Build-Up：出 premult(color,dabA)，外部 over blend。
const ACCUM_FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
uniform float u_radius;
uniform float u_hardness;     // 0..0.999
uniform float u_stampAlpha;   // 该 dab 的 α（0..1）
uniform vec3 u_color;         // 0..1
uniform bool u_buildup;
uniform float u_aspect;       // 椭圆纵横比（1=圆）
uniform float u_rotation;     // 椭圆旋转弧度（0=不旋）
out vec4 o;
void main() {
  // 旋转(-rotation)+1/aspect 逆变换（匹配 _washMaxInto:854-856）；圆=退化(c=1,s=0,ia=1)。
  float c = cos(u_rotation), s = sin(u_rotation);
  float ia = 1.0 / max(0.01, u_aspect);
  float dxR = c * v_local.x + s * v_local.y;
  float dyR = (-s * v_local.x + c * v_local.y) * ia;
  float dist = length(vec2(dxR, dyR));
  float innerR = u_hardness * u_radius;
  float decayLen = u_radius - innerR;
  float shapeA;
  if (dist >= u_radius) { discard; }
  if (decayLen <= 0.0 || dist <= innerR) shapeA = 1.0;
  else { float u = (dist - innerR) / decayLen; shapeA = 1.0 - u*u*(3.0 - 2.0*u); }
  float dabA = u_stampAlpha * shapeA;
  if (u_buildup) o = vec4(u_color * dabA, dabA);   // premult, over
  else           o = vec4(0.0, 0.0, 0.0, dabA);    // wash: 累积 α (MAX)
}`;

// 把 wash 的累积 α 上色 → premult RGBA：premult(color, a)。全屏 quad。
const COLOR_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_quad;
out vec2 v_uv;
void main() { v_uv = a_quad; gl_Position = vec4(a_quad * 2.0 - 1.0, 0.0, 1.0); }`;
const COLOR_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_accum;
uniform vec3 u_color;
out vec4 o;
void main() { float a = texture(u_accum, v_uv).a; o = vec4(u_color * a, a); }`;

export class GLStampRasterizer {
  private _glctx: GLContext;
  constructor(glctx: GLContext) { this._glctx = glctx; }

  // 栅格化 stamps → 一张 bbox 尺寸的**预乘 RGBA** FBO（caller returnFBO）。
  //   bboxOrigin/Size = 输出纹理对应的 doc 区域。color/hardness/buildup = stroke 常量。
  rasterize(stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number): PooledFBO {
    const gl = this._glctx.gl;
    const quad = this._glctx.quadVAO();
    const accum = this._glctx.borrowFBO(bw, bh, "u8");

    // 1) 累积 pass。
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    if (shape.buildup) { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else { gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); }   // MAX：src/dst factor 被忽略

    const prog = this._glctx.program("stamp-accum", ACCUM_VERT, ACCUM_FRAG);
    gl.useProgram(prog);
    gl.bindVertexArray(quad);
    gl.uniform2f(gl.getUniformLocation(prog, "u_bboxOrigin"), bx, by);
    gl.uniform2f(gl.getUniformLocation(prog, "u_bboxSize"), bw, bh);
    gl.uniform1f(gl.getUniformLocation(prog, "u_hardness"), Math.max(0, Math.min(0.999, shape.hardness)));
    gl.uniform3f(gl.getUniformLocation(prog, "u_color"), shape.color[0], shape.color[1], shape.color[2]);
    gl.uniform1i(gl.getUniformLocation(prog, "u_buildup"), shape.buildup ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), shape.aspect ?? 1);
    gl.uniform1f(gl.getUniformLocation(prog, "u_rotation"), shape.rotation ?? 0);
    const uCenter = gl.getUniformLocation(prog, "u_center");
    const uRadius = gl.getUniformLocation(prog, "u_radius");
    const uAlpha = gl.getUniformLocation(prog, "u_stampAlpha");
    for (const s of stamps) {
      gl.uniform2f(uCenter, s.x, s.y);
      gl.uniform1f(uRadius, s.size / 2);
      gl.uniform1f(uAlpha, s.alpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    if (shape.buildup) {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.BLEND);
      return accum;   // 已是 premult colored
    }

    // 2) wash 上色 pass：accum.a → premult(color,a) 到另一张 FBO。
    const out = this._glctx.borrowFBO(bw, bh, "u8");
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    const cprog = this._glctx.program("stamp-color", COLOR_VERT, COLOR_FRAG);
    gl.useProgram(cprog);
    gl.bindVertexArray(quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accum.tex);
    gl.uniform1i(gl.getUniformLocation(cprog, "u_accum"), 0);
    gl.uniform3f(gl.getUniformLocation(cprog, "u_color"), shape.color[0], shape.color[1], shape.color[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._glctx.returnFBO(accum);
    return out;
  }
}
