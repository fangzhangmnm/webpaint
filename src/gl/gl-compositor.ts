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
import type { CompNode, OverlayDesc, FloatDesc } from "./gl-compose-plan.ts";
import type { TileIndexTexture } from "./tile-index.ts";
import type { GLContext, PooledFBO, FBOPrec } from "./gl-context.ts";

// 文档背景接缝（对齐 2D compositeLayers 的 bg + board._drawCheckerboard）：
//   undefined = 透明（present 时 void 色透出）；[r,g,b,a] = 预乘纯色（doc 背景色）；"checker" = 透明棋盘。
export type Background = [number, number, number, number] | "checker";

// 可变 ping-pong 对（pass-through 组要在同一累积器上续 pass，故按引用传递）。
interface Acc { read: PooledFBO; write: PooledFBO; }

// 棋盘背景（doc 空间，16px 格，#fff/#c8c8c8）——逐位匹配 board._drawCheckerboard。预乘不透明。
//   docPos = v_uv·docSize（与 composite frag 的层采样同约定 → 自动对齐）。
const CHECKER_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_docSize;
out vec4 o;
void main(){
  vec2 d = v_uv * u_docSize;
  float c = mod(floor(d.x / 16.0) + floor(d.y / 16.0), 2.0);
  vec3 col = (c >= 1.0) ? vec3(0.784314) : vec3(1.0);   // #c8c8c8 / #ffffff
  o = vec4(col, 1.0);
}`;

// GPU warp 共用 GLSL：逐 dst 像素逆单应性 gather + 手写采样器（nearest/bilinear/bicubic），**逐位复刻
//   floating-transform 的 CPU 采样器**（golden 对拍）。WARP_FRAG（live 合成）与 WARP_BAKE_FRAG（commit 烤定，
//   输出 straight）共用，零漂移。源纹理存**直值**（setFloats UNPACK_PREMULTIPLY=false），texelFetch 整数 texel。
const WARP_FUNCS = `
float cubicK(float t){
  float a = -0.5;
  float at = abs(t);
  if (at < 1.0) return (a+2.0)*at*at*at - (a+3.0)*at*at + 1.0;
  if (at < 2.0) return a*at*at*at - 5.0*a*at*at + 8.0*a*at - 4.0*a;
  return 0.0;
}
// 返回**直值** RGBA（与 CPU 采样器输出同：rgb 反预乘、a 钳）。sampler/size/mode 参数化 → 源与基底共用。
vec4 sampleSrc(sampler2D tex, vec2 size, int mode, float sx, float sy){
  int W = int(size.x), H = int(size.y);
  int ix = int(floor(sx)), iy = int(floor(sy));
  if (mode == 0){                                    // nearest：越界透明
    if (ix < 0 || ix >= W || iy < 0 || iy >= H) return vec4(0.0);
    return texelFetch(tex, ivec2(ix, iy), 0);
  } else if (mode == 1){                             // bilinear：replicate-edge clamp，premult 插值
    float fx = sx - float(ix), fy = sy - float(iy);
    if (ix < -1 || ix >= W || iy < -1 || iy >= H) return vec4(0.0);
    int x0 = clamp(ix, 0, W-1), x1 = clamp(ix+1, 0, W-1);
    int y0 = clamp(iy, 0, H-1), y1 = clamp(iy+1, 0, H-1);
    vec4 c00 = texelFetch(tex, ivec2(x0,y0), 0), c10 = texelFetch(tex, ivec2(x1,y0), 0);
    vec4 c01 = texelFetch(tex, ivec2(x0,y1), 0), c11 = texelFetch(tex, ivec2(x1,y1), 0);
    float w00=(1.0-fx)*(1.0-fy), w10=fx*(1.0-fy), w01=(1.0-fx)*fy, w11=fx*fy;
    float a = c00.a*w00 + c10.a*w10 + c01.a*w01 + c11.a*w11;
    if (a < 4.0e-7) return vec4(0.0);                // CPU a<1e-4(0..255 尺) ≈ a<3.9e-7(0..1)
    vec3 pm = c00.rgb*c00.a*w00 + c10.rgb*c10.a*w10 + c01.rgb*c01.a*w01 + c11.rgb*c11.a*w11;
    return vec4(pm / a, a);
  }
  // bicubic：4×4 Catmull-Rom，越界 tap 丢弃（贡献 0），premult 累加 → 反预乘
  float kx[4], ky[4];
  for (int i=0;i<4;i++){ kx[i]=cubicK(float(ix-1+i)-sx); ky[i]=cubicK(float(iy-1+i)-sy); }
  float r=0.0,g=0.0,b=0.0,a=0.0;
  for (int j=0;j<4;j++){
    int yy = iy-1+j; if (yy<0||yy>=H) continue;
    for (int i=0;i<4;i++){
      int xx = ix-1+i; if (xx<0||xx>=W) continue;
      vec4 c = texelFetch(tex, ivec2(xx,yy), 0);
      float av = c.a, ww = kx[i]*ky[j];
      r += c.r*av*ww; g += c.g*av*ww; b += c.b*av*ww; a += av*ww;
    }
  }
  float aOut = clamp(a, 0.0, 1.0);
  if (a < 4.0e-7) return vec4(0.0);
  return vec4(clamp(r/a,0.0,1.0), clamp(g/a,0.0,1.0), clamp(b/a,0.0,1.0), aOut);
}
// doc 像素 → 某浮层源 (u,v)，落 [0,1]² 采样直值，否则透明（quad 外）。
vec4 warpSample(sampler2D tex, vec2 size, mat3 hinv, int mode, vec2 docXY){
  vec3 uvw = hinv * vec3(docXY, 1.0);
  if (abs(uvw.z) < 1.0e-9) return vec4(0.0);
  float u = uvw.x / uvw.z, v = uvw.y / uvw.z;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0.0);
  return sampleSrc(tex, size, mode, u * size.x, v * size.y);
}`;

// live 浮层 pass（合成到累积器）。clip 浮层裁到基底浮层 warp 后 alpha（in-shader gather，docs/transform-clip-gpu-warp.md）。
const WARP_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_docSize;
uniform sampler2D u_dst;        // 累积器（预乘）
uniform sampler2D u_src;        // 源纹理（未 warp，直值），尺寸 u_srcSize
uniform vec2 u_srcSize;
uniform mat3 u_Hinv;            // doc(x,y,1) → 源单位方格（row-major，transpose 上传）
uniform int u_mode;            // 0=nearest 1=bilinear 2=bicubic
uniform int u_clip;            // 1=裁到基底浮层
uniform sampler2D u_baseTex;   // 基底浮层源纹理（已驻留）
uniform vec2 u_baseSize;
uniform mat3 u_baseHinv;
uniform int u_baseMode;
out vec4 o;
${WARP_FUNCS}
void main(){
  vec4 dst = texture(u_dst, v_uv);                   // 预乘 (Pd, ad)
  vec2 docXY = v_uv * u_docSize;                     // dst 像素中心（fragment 中心 → +0.5 自带）
  vec4 s = warpSample(u_src, u_srcSize, u_Hinv, u_mode, docXY);   // 直值
  if (u_clip == 1){                                  // 裁到基底浮层 warp 后 alpha（clip 链共基底也对）
    float baseA = warpSample(u_baseTex, u_baseSize, u_baseHinv, u_baseMode, docXY).a;
    s.a *= baseA;
  }
  vec4 src = vec4(s.rgb * s.a, s.a);                  // → 预乘
  o = src + dst * (1.0 - src.a);                     // source-over（预乘）
}`;

// commit 烤定：warp 源 → **straight** RGBA 进 bbox FBO（readback→canvas→editRegion）。FBO 像素 → doc 坐标
//   = bakeOrigin + v_uv·bakeSize；无 clip（commit 烤回各层不裁，clip 在 commit 后正常合成里复活）。
const WARP_BAKE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_bakeOrigin;     // bbox 左上 doc 坐标 (bx,by)
uniform vec2 u_bakeSize;       // bbox 尺寸 (bw,bh)
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform mat3 u_Hinv;
uniform int u_mode;
out vec4 o;
${WARP_FUNCS}
void main(){
  o = warpSample(u_src, u_srcSize, u_Hinv, u_mode, u_bakeOrigin + v_uv * u_bakeSize);   // 直值（不预乘、不合成）
}`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_flipY;        // 屏显=1（clip y+1=画布顶=accum v=N-1=doc 底 → 需翻）；FBO readback=0
out vec4 o;
void main(){
  vec2 uv = (u_flipY == 1) ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 p = texture(u_src, uv);
  vec3 c = (p.a > 0.0) ? (p.rgb / p.a) : vec3(0.0);   // 解预乘 → 直值
  o = vec4(c, p.a);
}`;

// 视口感知 present 的顶点：doc px → device px（board 的 _applyDocTransform 同一仿射）→ clip。
//   clip.y = 1 - 2·py/ch（device-py 下增 → clip-y 上增）自带朝向：a_pos.y=0=doc 顶=texture v0=doc 顶数据 → 屏顶。
const PRESENT_AFFINE_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;        // [0,1]²
uniform vec2 u_docSize;
uniform mat3 u_affine;                    // doc px → device px（列主序）
uniform vec2 u_canvas;                    // device px 画布尺寸
out vec2 v_uv;
void main(){
  v_uv = a_pos;
  vec3 dev = u_affine * vec3(a_pos * u_docSize, 1.0);
  gl_Position = vec4(2.0 * dev.x / u_canvas.x - 1.0, 1.0 - 2.0 * dev.y / u_canvas.y, 0.0, 1.0);
}`;

export class GLCompositor {
  private _glctx: GLContext;
  private _prec: FBOPrec;
  constructor(glctx: GLContext, accumPrec: FBOPrec = "f16") {
    this._glctx = glctx;
    this._prec = accumPrec;
  }

  private _program(mode: BlendMode, src: SourceKind, overlayMode: BlendMode = "source-over"): WebGLProgram {
    return this._glctx.program(compositeProgramKey(mode, src, overlayMode), COMPOSITE_VERT, compositeFragSource(mode, src, overlayMode));
  }

  // 合成一个层级的兄弟节点（自底向上）进一张预乘累积器 FBO 返回。caller 负责 returnFBO。
  // arrayTex = TileBackend 稀疏 tile 池纹理；docW/H = doc 像素尺寸。
  // bg = 底色（**预乘** [r,g,b,a]，doc 背景色；缺省透明）。顶层用 doc bg；组 sub-accumulator 永远透明。
  // VAO/viewport 在此绑定一次；隔离组递归走 _composeFresh（**不碰 VAO**，否则解绑会废掉外层后续 pass）。
  composite(arrayTex: WebGLTexture, nodes: CompNode[], docW: number, docH: number, bg?: Background): PooledFBO {
    const gl = this._glctx.gl;
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, docW, docH);
    gl.disable(gl.BLEND);
    const result = this._composeFresh(arrayTex, nodes, docW, docH, bg);
    gl.bindVertexArray(null);
    return result;
  }

  // 内部：合兄弟数组进一张新累积器返回（假设 VAO 已绑、viewport 已设）。隔离组递归用它（清透明）。
  private _composeFresh(arrayTex: WebGLTexture, nodes: CompNode[], docW: number, docH: number, bg?: Background): PooledFBO {
    const acc: Acc = {
      read: this._glctx.borrowFBO(docW, docH, this._prec),
      write: this._glctx.borrowFBO(docW, docH, this._prec),
    };
    if (bg === "checker") { this._clear(acc.read, undefined); this._drawChecker(acc.read, docW, docH); }
    else this._clear(acc.read, bg);
    this._applyNodes(arrayTex, nodes, acc, docW, docH);
    this._glctx.returnFBO(acc.write);
    return acc.read;
  }

  // 棋盘背景 pass → 填进累积器（doc 空间）。VAO 已由 composite() 绑、viewport 已设。
  private _drawChecker(f: PooledFBO, docW: number, docH: number): void {
    const gl = this._glctx.gl;
    const prog = this._glctx.program("checker", COMPOSITE_VERT, CHECKER_FRAG);
    gl.useProgram(prog);
    gl.uniform2f(gl.getUniformLocation(prog, "u_docSize"), docW, docH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // 把兄弟节点逐个 pass 到 acc（pass-through 组递归到同一 acc；隔离组先合 sub 再整体混）。
  private _applyNodes(arrayTex: WebGLTexture, nodes: CompNode[], acc: Acc, docW: number, docH: number): void {
    const bases = resolveClipBases(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.visible) continue;
      const base = bases[i];
      // clip 无基底 → 层本身不渲染，**但浮层仍要显**（变换中整层被提起、基底变空时，clip 层的 float 不能跟着消失；
      //   对齐 2D layer-composite.ts:131/143 —— float 独立于 clip 绘制）。组无 float → clip 无基底直接跳。
      const clipNoBase = node.clip && !base;
      // clip 基底：仅支持叶作基底（其 tile-index 即蒙版）。组作基底罕见，暂不支持（当无 clip）。
      const clipIndex = base && base.kind === "leaf" ? base.srcIndex : null;

      if (node.kind === "leaf") {
        if (!clipNoBase) {
          const srcKind = node.overlay ? "overlay" : "tiled";
          this._pass(arrayTex, srcKind, node.srcIndex, null, node.mode, node.opacity, clipIndex, acc, docW, docH, node.overlay ?? null);
        }
        // 自由变换浮层：源层 z 之上 source-over α=1（独立 pass）。clip 浮层 + 基底也是浮层（组变换）→ 裁到基底
        //   浮层 warp 后 alpha（base.float）；基底静止/非叶则不裁（见 docs/transform-clip-gpu-warp.md 边界）。
        if (node.float) this._floatPass(node.float, acc, docW, docH, (node.clip && base && base.kind === "leaf") ? base.float ?? null : null);
      } else if (clipNoBase) {
        continue;
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
    const prog = this._program(mode, srcKind, overlay && !overlay.erase ? overlay.blendMode : "source-over");
    gl.useProgram(prog);
    const u = (name: string) => gl.getUniformLocation(prog, name);
    gl.uniform2f(u("u_docSize"), docW, docH);
    gl.uniform1f(u("u_opacity"), opacity);
    gl.uniform1i(u("u_hasClip"), clipIndex ? 1 : 0);
    gl.uniform1f(u("u_overlayOpacity"), overlay ? overlay.opacity : 1);
    gl.uniform1i(u("u_overlayErase"), overlay && overlay.erase ? 1 : 0);
    gl.uniform2f(u("u_ovOrigin"), overlay ? overlay.ox : 0, overlay ? overlay.oy : 0);
    gl.uniform2f(u("u_ovSize"), overlay ? overlay.ow : 1, overlay ? overlay.oh : 1);
    gl.uniform1i(u("u_ovLockAlpha"), overlay && overlay.lockAlpha ? 1 : 0);
    const sel = overlay?.selMask ?? null;
    gl.uniform1i(u("u_ovHasSel"), sel ? 1 : 0);
    gl.uniform2f(u("u_ovSelOrigin"), sel ? sel.ox : 0, sel ? sel.oy : 0);
    gl.uniform2f(u("u_ovSelSize"), sel ? sel.ow : 1, sel ? sel.oh : 1);
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
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, sel?.tex ?? ph);
    this._setSampler(prog, "u_ovSel", 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.write.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const tmp = acc.read; acc.read = acc.write; acc.write = tmp;   // 交换
  }

  // 浮层 pass = GPU warp（gather）：源纹理 + Hinv → 逐 dst 像素逆映射采样 → source-over α=1 → acc.write，交换。
  //   全屏 quad（按 doc 像素 gather，剔除 quad 外）；blend 关、预乘 source-over 在 fragment 手算。
  //   clipBase 非空（组变换里 clip 浮层的基底浮层）→ shader 里 clipα ×= gather 基底 alpha（零额外内存）。
  private _floatPass(f: FloatDesc, acc: Acc, docW: number, docH: number, clipBase: FloatDesc | null = null): void {
    const gl = this._glctx.gl;
    const prog = this._glctx.program("warp", COMPOSITE_VERT, WARP_FRAG);
    gl.useProgram(prog);
    const u = (name: string) => gl.getUniformLocation(prog, name);
    gl.uniform2f(u("u_docSize"), docW, docH);
    gl.uniform2f(u("u_srcSize"), f.srcW, f.srcH);
    gl.uniformMatrix3fv(u("u_Hinv"), true, f.hinv);   // row-major → transpose
    gl.uniform1i(u("u_mode"), f.mode);
    gl.uniform1i(u("u_clip"), clipBase ? 1 : 0);
    if (clipBase) {
      gl.uniform2f(u("u_baseSize"), clipBase.srcW, clipBase.srcH);
      gl.uniformMatrix3fv(u("u_baseHinv"), true, clipBase.hinv);
      gl.uniform1i(u("u_baseMode"), clipBase.mode);
    }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, acc.read.tex);
    this._setSampler(prog, "u_dst", 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, f.tex);
    this._setSampler(prog, "u_src", 1);
    // u_baseTex 固定单元 2（无 clip 也绑占位 acc.read，防未用 sampler 落单元 0 与 array 冲突，同 _pass 注释）。
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, clipBase ? clipBase.tex : acc.read.tex);
    this._setSampler(prog, "u_baseTex", 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.write.fbo);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const tmp = acc.read; acc.read = acc.write; acc.write = tmp;
  }

  // 仅当 uniform 未被编译器优化掉（location 非 null）才设——unused sampler 安全跳过。
  private _setSampler(prog: WebGLProgram, name: string, unit: number): void {
    const loc = this._glctx.gl.getUniformLocation(prog, name);
    if (loc) this._glctx.gl.uniform1i(loc, unit);
  }

  // 预乘累积器 → 直值 RGBA8 目标 FBO（解预乘 present）。给 readback 用（不翻 Y）。
  presentTo(srcTex: WebGLTexture, target: PooledFBO, w: number, h: number): void {
    this._present(srcTex, target.fbo, w, h, false);
  }

  // 预乘累积器 → 默认 framebuffer（可见画布），翻 Y、解预乘、整文档铺满（1:1 fit，预览页用）。
  presentToScreen(srcTex: WebGLTexture, canvasW: number, canvasH: number): void {
    this._present(srcTex, null, canvasW, canvasH, true);
  }

  // 视口感知 present：用 board 的 device-px 仿射把 doc 纹理摆到屏幕（pan/zoom/rot/dpr 一致）。
  // affine = [a,b,c,d,e,f]（board _applyDocTransform 的 setTransform 参数）；canvasW/H = device px。
  // smooth = 缩小(scale<1)用 LINEAR 抗锯齿；放大(scale>1)用 NEAREST 看像素（对齐 2D board imageSmoothing 策略）。
  // 不清屏（caller 先清 void 色）；doc 之外的画布区不被本 draw 覆盖。
  presentToScreenAffine(srcTex: WebGLTexture, docW: number, docH: number, affine: number[], canvasW: number, canvasH: number, smooth = true): void {
    const gl = this._glctx.gl;
    const prog = this._glctx.program("present-affine", PRESENT_AFFINE_VERT, PRESENT_FRAG);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, canvasW, canvasH);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    // 按 smooth 切源纹理过滤（FBO 默认 NEAREST；present 时按视口 scale 调）。
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    const filt = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.uniform1i(gl.getUniformLocation(prog, "u_flipY"), 0);   // 朝向由顶点 clip-y 处理
    gl.uniform2f(gl.getUniformLocation(prog, "u_docSize"), docW, docH);
    gl.uniform2f(gl.getUniformLocation(prog, "u_canvas"), canvasW, canvasH);
    const [a, b, c, d, e, f] = affine;
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_affine"), false, new Float32Array([a, b, 0, c, d, 0, e, f, 1]));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    this._setSampler(prog, "u_src", 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private _present(srcTex: WebGLTexture, fbo: WebGLFramebuffer | null, w: number, h: number, flipY: boolean): void {
    const gl = this._glctx.gl;
    const prog = this._glctx.program("present", COMPOSITE_VERT, PRESENT_FRAG);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, "u_flipY"), flipY ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    this._setSampler(prog, "u_src", 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  // commit 烤定：warp 源 → **straight** RGBA bbox FBO → readback → canvas（floating-transform._bakeDown 用，
  //   复用 live 同一套 warp 采样器 = preview/commit 零漂移）。源纹理临时上传（commit 一次性，可忽略）。
  warpToCanvas(srcCanvas: TexImageSource, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number): { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null {
    if (bw <= 0 || bh <= 0) return null;
    const gl = this._glctx.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // 直值
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    const fbo = this._glctx.borrowFBO(bw, bh, "u8");
    const prog = this._glctx.program("warpbake", COMPOSITE_VERT, WARP_BAKE_FRAG);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform2f(u("u_bakeOrigin"), bx, by);
    gl.uniform2f(u("u_bakeSize"), bw, bh);
    gl.uniform2f(u("u_srcSize"), srcW, srcH);
    gl.uniformMatrix3fv(u("u_Hinv"), true, hinv);   // row-major → transpose
    gl.uniform1i(u("u_mode"), mode);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    this._setSampler(prog, "u_src", 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const px = new Uint8Array(bw * bh * 4);
    gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    this._glctx.returnFBO(fbo);
    gl.deleteTexture(tex);
    const canvas = document.createElement("canvas"); canvas.width = bw; canvas.height = bh;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), bw, bh), 0, 0);
    return { canvas, dstX: bx, dstY: by };
  }

  private _clear(f: PooledFBO, bg?: [number, number, number, number]): void {
    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    if (bg) gl.clearColor(bg[0], bg[1], bg[2], bg[3]); else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
