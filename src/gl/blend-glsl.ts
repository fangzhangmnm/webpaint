// 12 个可分离 blend 模式的 GLSL（W3C Compositing and Blending L1 §10.1 逐字实现）。
// 这 12 个 = WebPaint UI 实际可选的全部（layers-panel.ts:71 LAYER_MODE_LABEL）；非可分离的
//   hue/sat/color/luminosity UI 选不到（只在 PSD 互转），故不实现。
//
// 正确性策略：Canvas2D 的原生 blend = 同一份 W3C 规范 → GL 输出必须逐像素匹配 Canvas2D。
//   blend 公式生成（本文件）node 可测（断言每模式含对的式子）；像素匹配由 smoke harness 的
//   同引擎 2D-vs-GL 自 diff 验（docs/perf-webgl-memory-clip.md §5 Stage 2）。
//
// 约定：bfn(Cb,Cs) 在**直值**(unpremultiplied, [0,1]) 上算，逐通道。源/背景的预乘与合成在主 shader。

// 我们支持的 12 个 canvas blend mode（值即 globalCompositeOperation / layer.mode）。
export const BLEND_MODES = [
  "source-over", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

// 每模式：bfn(float Cb, float Cs) 的**函数体**（return 一个 float）。W3C §10.1 逐条。
const BLEND_BODY: Record<BlendMode, string> = {
  // 正常：源直接覆盖（B=Cs）。
  "source-over": `return Cs;`,
  "multiply": `return Cb * Cs;`,
  "screen": `return Cb + Cs - Cb * Cs;`,
  // overlay(Cb,Cs) = hard-light(Cs,Cb)
  "overlay": `return (Cb <= 0.5) ? (2.0*Cb*Cs) : (1.0 - 2.0*(1.0-Cb)*(1.0-Cs));`,
  "darken": `return min(Cb, Cs);`,
  "lighten": `return max(Cb, Cs);`,
  // color-dodge：Cb==0→0；Cs==1→1；else min(1, Cb/(1-Cs))
  "color-dodge": `if (Cb == 0.0) return 0.0; if (Cs >= 1.0) return 1.0; return min(1.0, Cb/(1.0-Cs));`,
  // color-burn：Cb==1→1；Cs==0→0；else 1-min(1,(1-Cb)/Cs)
  "color-burn": `if (Cb >= 1.0) return 1.0; if (Cs == 0.0) return 0.0; return 1.0 - min(1.0, (1.0-Cb)/Cs);`,
  "hard-light": `return (Cs <= 0.5) ? (2.0*Cb*Cs) : (1.0 - 2.0*(1.0-Cb)*(1.0-Cs));`,
  // soft-light：W3C 分段（D(Cb) 分支）。
  "soft-light":
    `float D = (Cb <= 0.25) ? (((16.0*Cb - 12.0)*Cb + 4.0)*Cb) : sqrt(Cb);
     return (Cs <= 0.5) ? (Cb - (1.0 - 2.0*Cs)*Cb*(1.0-Cb)) : (Cb + (2.0*Cs - 1.0)*(D - Cb));`,
  "difference": `return abs(Cb - Cs);`,
  "exclusion": `return Cb + Cs - 2.0*Cb*Cs;`,
};

// 全屏 quad 顶点（attr location 0 = [0,1]² 位置即 uv；GLContext.quadVAO 提供该 buffer）。
export const COMPOSITE_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv = a_pos; gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); }`;

// 一个 blend 模式的 fragment 源：采源 tile（直值）+ 累积器（预乘）→ W3C blend + source-over 合成 → 预乘输出。
//   u_arr/u_srcSlice：源层在 array texture 的 slice；u_dst：累积器（预乘 RGBA16F）；
//   u_opacity：层不透明度（× 进源 alpha，Π 外那一份，见 brush §4.3）；
//   u_clipSlice：剪裁基底 slice（≥0 时把源 alpha × 基底 alpha = clip 蒙版）；-1 关闭。
export function compositeFragSource(mode: BlendMode): string {
  return `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_uv;
uniform sampler2DArray u_arr;
uniform float u_srcSlice;
uniform sampler2D u_dst;
uniform float u_opacity;
uniform float u_clipSlice;
out vec4 o;

float bfn(float Cb, float Cs){ ${BLEND_BODY[mode]} }
vec3 blendRGB(vec3 b, vec3 s){ return vec3(bfn(b.r,s.r), bfn(b.g,s.g), bfn(b.b,s.b)); }

void main(){
  vec4 src = texture(u_arr, vec3(v_uv, u_srcSlice));   // 直值 RGBA
  float as = src.a * u_opacity;
  if (u_clipSlice >= 0.0) as *= texture(u_arr, vec3(v_uv, u_clipSlice)).a;   // clip 蒙版
  vec3 Cs = src.rgb;

  vec4 dst = texture(u_dst, v_uv);    // 预乘 (Pb, ab)
  float ab = dst.a;
  vec3 Cb = (ab > 0.0) ? (dst.rgb / ab) : vec3(0.0);   // 还原背景直值

  vec3 Csb = (1.0 - ab) * Cs + ab * blendRGB(Cb, Cs);  // W3C §10.2：blend 只在背景存在处生效
  vec3 Po = as * Csb + dst.rgb * (1.0 - as);           // 预乘输出 rgb（dst.rgb 已是 ab*Cb）
  float ao = as + ab * (1.0 - as);
  o = vec4(Po, ao);
}`;
}

// program 缓存键（GLContext.program 用）。
export function compositeProgramKey(mode: BlendMode): string {
  return `composite:${mode}`;
}
