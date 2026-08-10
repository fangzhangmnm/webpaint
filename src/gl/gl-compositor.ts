// GLCompositor —— WebGL2 图层合成器（ai-docs/20260614-perf-webgl-memory-clip.md §3 模块 4）。
//
// 算法：ping-pong 两张直值累积器，**一层一 pass**——每 pass 全屏，shader 按 doc 坐标查 tile-index
//   采源 + 累积器 → W3C blend + source-over → 写另一张、交换。clip = 源α×基底α（无 2D dst-in）。
// S9 起本类只剩 **pass 原语**（begin/newAcc/pass/floatPass/finishAcc/end/present/warp）——
//   树递归执行器归档进 test/gl-smoke/reference-gl-compositor.ts（smoke 对拍参照），
//   生产唯一执行器 = render-tree（render-plan 驱动；T6 起与 raster-service 共享 gl-room）。

import { COMPOSITE_VERT, compositeFragSource, compositeProgramKey } from "./blend-glsl.ts";
import type { BlendMode, SourceKind } from "./blend-glsl.ts";
import type { IndexTexture } from "./gpu-tile-pool.ts";
import type { Gl2Port, PooledFBO, FBOPrec } from "../common/gl2-port.ts";

// live 描边 overlay（活动叶层叠加）：直值纹理 + doc 坐标 bbox + 不透明度/擦除/锁α/选区蒙版。
export interface OverlayDesc {
  tex: WebGLTexture;
  opacity: number;
  erase: boolean;
  blendMode: BlendMode;   // 笔刷混合模式（overlay 合到 base 用；erase 时忽略）
  ox: number; oy: number; ow: number; oh: number;   // doc 坐标 bbox（shader 按此映射，bbox 外透明）
  lockAlpha?: boolean;    // 锁α：overlay 裁到 base 现有 alpha
  selMask?: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null;
}
// 自由变换浮层 = GPU warp 输入：未 warp 源纹理 + 逆单应性 Hinv（doc→源单位方格）+ sampleMode。
//   在源层 z 之上 source-over α=1，忽略源层 mode/opacity（与 overlay 不同——overlay 随层）。
export interface FloatDesc {
  tex: WebGLTexture;      // 源纹理（未 warp，直值，srcW×srcH，常驻——拖动中只换 hinv）
  srcW: number; srcH: number;
  hinv: number[];         // 9，row-major，doc(x,y,1)→源 (u,v,w) 透视除
  mode: number;           // 0=nearest 1=bilinear 2=bicubic
}

// 文档背景接缝（对齐 2D compositeLayers 的 bg + board._drawCheckerboard）：
//   undefined = 透明（present 时 void 色透出）；[r,g,b,a] = 预乘纯色（doc 背景色）；"checker" = 透明棋盘。
export type Background = [number, number, number, number] | "checker";

// 可变 ping-pong 对（pass-through 组要在同一累积器上续 pass，故按引用传递）。
// S7 起导出：render-tree/raster-service 执行器直接驱动 pass 原语（begin/newAcc/pass/floatPass/finishAcc/end），
//   本类自己的 composite() 树递归保留（smoke harness 的规范执行器 + 对拍参照）。
export interface Acc { read: PooledFBO; write: PooledFBO; }

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
// 三次 B 样条核（mode 3 预滤波样条；逐位对齐 src/bspline.ts 的 b3）
float bsp3(float t){
  float at = abs(t);
  if (at < 1.0) return 2.0/3.0 - at*at + at*at*at*0.5;
  if (at < 2.0) { float u = 2.0 - at; return u*u*u/6.0; }
  return 0.0;
}
// mode 3：预滤波 B 样条采样。tex = 系数纹理（RGBA16F，premult、0..255 尺度、PAD=8 边距，
//   见 src/bspline.ts prefilterToSplinePlane）；size = 逻辑源尺寸。系数已 premult → 直接累加。
vec4 sampleSpline(sampler2D tex, vec2 size, float sx, float sy){
  const float PAD = 8.0;   // = BSPLINE_PAD
  int PW = int(size.x) + 16, PH = int(size.y) + 16;
  float cx = sx + PAD, cy = sy + PAD;
  int ix = int(floor(cx)), iy = int(floor(cy));
  float kx[4], ky[4];
  for (int i=0;i<4;i++){ kx[i]=bsp3(float(ix-1+i)-cx); ky[i]=bsp3(float(iy-1+i)-cy); }
  float r=0.0,g=0.0,b=0.0,a=0.0;
  float ca[16];
  for (int t=0;t<16;t++) ca[t]=0.0;
  for (int j=0;j<4;j++){
    int yy = iy-1+j; if (yy<0||yy>=PH) continue;
    for (int i=0;i<4;i++){
      int xx = ix-1+i; if (xx<0||xx>=PW) continue;
      vec4 c = texelFetch(tex, ivec2(xx,yy), 0);
      float ww = kx[i]*ky[j];
      r += c.r*ww; g += c.g*ww; b += c.b*ww; a += c.a*ww;
      ca[j*4+i] = c.a;
    }
  }
  if (a < 1.0e-4) return vec4(0.0);            // 0..255 尺度阈值（对齐 CPU）
  // 反振铃限幅（v0.6.43，user 方案 A）：源 α 在中央 2×2 整点的值 = 系数 3×3 × B3 整点权 [1,4,1]/6
  //   重建；α clamp 进 [min,max]，premult RGB 等比缩 → C=r/α 比值不动（零色偏），只杀负瓣过冲
  //   （半透明笔画旋转边缘"变深"病根）。整点采样时 a=整点值 ∈ 域内 → 恒 no-op，identity 无损保持。
  float na[4];
  for (int v=0; v<2; v++) for (int u=0; u<2; u++) {
    float acc = 0.0;
    for (int dv=-1; dv<=1; dv++) for (int du=-1; du<=1; du++) {
      acc += ca[(v+1+dv)*4 + (u+1+du)] * ((du==0?4.0:1.0)/6.0) * ((dv==0?4.0:1.0)/6.0);
    }
    na[v*2+u] = acc;
  }
  float amin = min(min(na[0],na[1]),min(na[2],na[3]));
  float amax = max(max(na[0],na[1]),max(na[2],na[3]));
  float acl = clamp(a, amin, amax);
  if (acl != a) { float sc = acl / a; r*=sc; g*=sc; b*=sc; a=acl; }
  if (a < 1.0e-4) return vec4(0.0);
  // 系数尺度：rgb=C·α(0..255·α)、a=255α → r/a = 归一直值，a/255 = 归一 alpha
  return vec4(clamp(r/a,0.0,1.0), clamp(g/a,0.0,1.0), clamp(b/a,0.0,1.0), clamp(a/255.0,0.0,1.0));
}
// 返回**直值** RGBA（与 CPU 采样器输出同：rgb 反预乘、a 钳）。sampler/size/mode 参数化 → 源与基底共用。
vec4 sampleSrc(sampler2D tex, vec2 size, int mode, float sx, float sy){
  if (mode == 3) return sampleSpline(tex, size, sx, sy);
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
  // 反振铃限幅（v0.6.43，user 方案 A）：α clamp 进中央 2×2 texel [min,max]（越界=0），
  //   premult RGB 等比缩 → 零色偏，只杀 Catmull-Rom 负瓣过冲。
  float n00 = (ix  >=0&&ix  <W&&iy  >=0&&iy  <H) ? texelFetch(tex, ivec2(ix,  iy  ), 0).a : 0.0;
  float n10 = (ix+1>=0&&ix+1<W&&iy  >=0&&iy  <H) ? texelFetch(tex, ivec2(ix+1,iy  ), 0).a : 0.0;
  float n01 = (ix  >=0&&ix  <W&&iy+1>=0&&iy+1<H) ? texelFetch(tex, ivec2(ix,  iy+1), 0).a : 0.0;
  float n11 = (ix+1>=0&&ix+1<W&&iy+1>=0&&iy+1<H) ? texelFetch(tex, ivec2(ix+1,iy+1), 0).a : 0.0;
  float acl = clamp(a, min(min(n00,n10),min(n01,n11)), max(max(n00,n10),max(n01,n11)));
  if (acl != a && a > 4.0e-7) { float sc = acl / a; r*=sc; g*=sc; b*=sc; a=acl; }
  float aOut = clamp(a, 0.0, 1.0);
  if (a < 4.0e-7) return vec4(0.0);
  return vec4(clamp(r/a,0.0,1.0), clamp(g/a,0.0,1.0), clamp(b/a,0.0,1.0), aOut);
}
// doc 像素 → 某浮层源 (u,v)，落 [0,1]² 采样直值，否则透明（quad 外）。
// u*size 是 edge 约定（texel i 占 [i,i+1)）：nearest 的 floor(sx) 天然吻合；bilinear/bicubic 内核
// 按 center 约定（texel 中心在整数）插值 → 喂 sx-0.5，否则 identity 时 fx=0.5 = 半 texel 相位错
// （lift 一瞬间就糊 + 0.5px 左上移的根因）。修后 identity/整数平移下三种模式都逐 texel 精确。
vec4 warpSample(sampler2D tex, vec2 size, mat3 hinv, int mode, vec2 docXY){
  vec3 uvw = hinv * vec3(docXY, 1.0);
  if (abs(uvw.z) < 1.0e-9) return vec4(0.0);
  float u = uvw.x / uvw.z, v = uvw.y / uvw.z;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return vec4(0.0);
  float off = (mode == 0) ? 0.0 : 0.5;
  return sampleSrc(tex, size, mode, u * size.x - off, v * size.y - off);
}`;

// live 浮层 pass（合成到累积器）。clip 浮层裁到基底浮层 warp 后 alpha（in-shader gather，ai-docs/20260628-transform-clip-gpu-warp.md）。
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
  vec4 dst = texture(u_dst, v_uv);                   // 直值 (Cd, ad)（S7：累积器 straight）
  vec2 docXY = v_uv * u_docSize;                     // dst 像素中心（fragment 中心 → +0.5 自带）
  vec4 s = warpSample(u_src, u_srcSize, u_Hinv, u_mode, docXY);   // 直值
  if (u_clip == 1 && s.a > 0.0){                     // 裁到基底浮层 warp 后 alpha（clip 链共基底也对）
    // 早退：s.a==0（quad 外/透明）时 s.a*=baseA 恒 0，无须算基底 16-tap bicubic gather（perf-optimization-backlog §3）。
    float baseA = warpSample(u_baseTex, u_baseSize, u_baseHinv, u_baseMode, docXY).a;
    s.a *= baseA;
  }
  float ao = s.a + dst.a * (1.0 - s.a);              // source-over（直值存储：预乘空间合成后归一）
  vec3 Po = s.rgb * s.a + dst.rgb * dst.a * (1.0 - s.a);
  o = vec4((ao > 0.0) ? (Po / ao) : vec3(0.0), ao);
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
uniform int u_unpremult;    // 1=源是预乘（stamp 栅格器中间 FBO）→ 解预乘；0=源已直值（累积器，S7 起）
out vec4 o;
void main(){
  vec2 uv = (u_flipY == 1) ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 p = texture(u_src, uv);
  vec3 c = (u_unpremult == 1 && p.a > 0.0) ? (p.rgb / p.a) : p.rgb;
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
  private _glctx: Gl2Port;
  private _prec: FBOPrec;
  // 性能计数（dev HUD 用，零成本——只在 _pass/_floatPass 自增整数）。composite() 入口清零，调用方读 stats。
  //   passes = blend pass 数（≈ 可见层/组单元数，§2 layer-count 假说的直读量）；floatPasses = 浮层 warp pass 数。
  readonly stats = { passes: 0, floatPasses: 0 };
  constructor(glctx: Gl2Port, accumPrec: FBOPrec = "u8") {
    this._glctx = glctx;
    this._prec = accumPrec;
  }

  private _program(mode: BlendMode, src: SourceKind, overlayMode: BlendMode = "source-over"): WebGLProgram {
    return this._glctx.program(compositeProgramKey(mode, src, overlayMode), COMPOSITE_VERT, compositeFragSource(mode, src, overlayMode));
  }

  // ---- 执行器原语（render-tree / raster-service / 对拍 harness 驱动） ----

  // 帧作用域：绑 VAO + viewport（doc 尺寸）一次。resetStats=false 时保留计数（执行器整帧统计）。
  begin(docW: number, docH: number, resetStats = true): void {
    const gl = this._glctx.gl;
    if (resetStats) { this.stats.passes = 0; this.stats.floatPasses = 0; }
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, docW, docH);
    gl.disable(gl.BLEND);
  }
  end(): void { this._glctx.gl.bindVertexArray(null); }

  // 借一对累积器并铺底（bg 缺省=透明；"checker"=棋盘）。须在 begin() 作用域内。
  newAcc(docW: number, docH: number, bg?: Background): Acc {
    const acc: Acc = {
      read: this._glctx.borrowFBO(docW, docH, this._prec),
      write: this._glctx.borrowFBO(docW, docH, this._prec),
    };
    if (bg === "checker") { this._clear(acc.read, undefined); this._drawChecker(acc.read, docW, docH); }
    else this._clear(acc.read, bg);
    return acc;
  }
  // 收口：还 write，交出 read（caller 负责 returnFBO(read)）。
  finishAcc(acc: Acc): PooledFBO {
    this._glctx.returnFBO(acc.write);
    return acc.read;
  }

  // FBO 归还公共透传（执行器/对拍 harness 归还 finishAcc / 隔离组结果用）。
  returnFBO(f: PooledFBO): void { this._glctx.returnFBO(f); }

  // 棋盘背景 pass → 填进累积器（doc 空间）。VAO 已由 begin() 绑、viewport 已设。
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

  // 一个 blend pass：src(tiled 叶或段 / group 直值纹理) 与 acc.read 合 → acc.write，交换。
  pass(
    arrayTex: WebGLTexture, srcKind: SourceKind,
    srcIndex: IndexTexture | null, groupTex: WebGLTexture | null,
    mode: BlendMode, opacity: number, clipIndex: IndexTexture | null,
    acc: Acc, docW: number, docH: number, overlay: OverlayDesc | null = null,
    clipTex: WebGLTexture | null = null,   // 非空 = clip 蒙版改采这张 doc 尺寸 2D 纹理（live 中的 merged 基底）
  ): void {
    const gl = this._glctx.gl;
    this.stats.passes++;
    const prog = this._program(mode, srcKind, overlay && !overlay.erase ? overlay.blendMode : "source-over");
    gl.useProgram(prog);
    const u = (name: string) => gl.getUniformLocation(prog, name);
    gl.uniform2f(u("u_docSize"), docW, docH);
    gl.uniform1f(u("u_opacity"), opacity);
    gl.uniform1i(u("u_hasClip"), (clipIndex || clipTex) ? 1 : 0);
    gl.uniform1i(u("u_clipMode"), clipTex ? 1 : 0);
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
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, clipTex ?? ph);
    this._setSampler(prog, "u_clipTex", 7);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.write.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const tmp = acc.read; acc.read = acc.write; acc.write = tmp;   // 交换
  }

  // 浮层 pass = GPU warp（gather）：源纹理 + Hinv → 逐 dst 像素逆映射采样 → source-over α=1 → acc.write，交换。
  //   全屏 quad（按 doc 像素 gather，剔除 quad 外）；blend 关、预乘 source-over 在 fragment 手算。
  //   clipBase 非空（组变换里 clip 浮层的基底浮层）→ shader 里 clipα ×= gather 基底 alpha（零额外内存）。
  floatPass(f: FloatDesc, acc: Acc, docW: number, docH: number, clipBase: FloatDesc | null = null): void {
    const gl = this._glctx.gl;
    this.stats.floatPasses++;
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

  // 任意纹理 → 直值 RGBA8 目标 FBO（不翻 Y）。unpremult=true 时源按预乘解（stamp 栅格器中间 FBO 用）；
  //   累积器（S7 起直值）传 false = 纯拷贝。
  presentTo(srcTex: WebGLTexture, target: PooledFBO, w: number, h: number, unpremult = false): void {
    this._present(srcTex, target.fbo, w, h, false, unpremult);
  }

  // 直值累积器 → 默认 framebuffer（可见画布），翻 Y、整文档铺满（1:1 fit，预览页用）。
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

  private _present(srcTex: WebGLTexture, fbo: WebGLFramebuffer | null, w: number, h: number, flipY: boolean, unpremult = false): void {
    const gl = this._glctx.gl;
    const prog = this._glctx.program("present", COMPOSITE_VERT, PRESENT_FRAG);
    gl.bindVertexArray(this._glctx.quadVAO());
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, "u_flipY"), flipY ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_unpremult"), unpremult ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    this._setSampler(prog, "u_src", 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  // commit 烤定（产品路径 v0.6.38）：warp 源 → **straight** RGBA bbox FBO → readback 直接返回**字节**
  //   （floating-transform._bakeDown 用 typed-array source-over 落层——零 canvas premult 往返）。
  //   复用 live 同一套 warp 采样器 = preview/commit 零漂移。源纹理临时上传（commit 一次性，可忽略）。
  //   mode 3（spline）源 = 系数平面（Float32Array，PAD 边距）→ RGBA16F；u8 平面（源字节/EPX 放大）→ u8。
  warpToBytes(srcCanvas: { data: Float32Array; w: number; h: number } | { data: Uint8ClampedArray; w: number; h: number }, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number): { data: Uint8ClampedArray; w: number; h: number; dstX: number; dstY: number } | null {
    if (bw <= 0 || bh <= 0) return null;
    const gl = this._glctx.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 只收 typed-array 平面（v0.6.38 审计锁死：canvas 源 texImage2D 的 UNPACK_PREMULTIPLY 转换
    // 在 Safari 不可靠 = 柔边黑边根源，该分支已整树拔除，别加回来）。
    if (srcCanvas.data instanceof Float32Array) {
      const p = srcCanvas as { data: Float32Array; w: number; h: number };
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, p.w + 16, p.h + 16, 0, gl.RGBA, gl.FLOAT, p.data);
    } else {
      // u8 直值平面（源字节 / rotsprite EPX 放大；srcW/srcH 与平面尺寸一致由调用方保证）
      const p = srcCanvas as { data: Uint8ClampedArray; w: number; h: number };
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength));
    }
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
    return { data: new Uint8ClampedArray(px.buffer), w: bw, h: bh, dstX: bx, dstY: by };
  }

  private _clear(f: PooledFBO, bg?: [number, number, number, number]): void {
    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    if (bg) gl.clearColor(bg[0], bg[1], bg[2], bg[3]); else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
