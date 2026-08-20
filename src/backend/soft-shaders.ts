// soft-shaders —— SoftGl2Port 的 shader CPU 对表（ADR-0009 决定 5；C8）。
//
// 【纪律】每个进 Gl2Port.program() 的 shader 名必须在此有 CPU 等价实现，或显式登 GPU_ONLY——
//   静默缺席 = SoftGl2Port.program() 响亮 throw（对表测试红）。新 shader 不配 CPU 版必须
//   有意识地登记，不能溜进来。
//
// 【迂腐语义】每个实现**逐行镜像**对应 GLSL 源（gl-compositor.ts / gl-stamp.ts / blend-glsl.ts）：
//   - 全部数学在直值 float 0..1 域（float 纹理 raw 值），与 GLSL 同式同分支同阈值；
//   - texture() NEAREST + CLAMP_TO_EDGE = clamp(floor(uv·size), 0, size-1) 点采；
//   - fragment 中心 = 像素 +0.5（v_uv = (x+0.5)/w）；
//   - 不复刻硬件数值细节（f16 舍入、instancing 机制）——u8 目标逐写量化（见 soft-gl2-port），
//     golden 对拍 ±ε。
// 修改任一 GLSL 时**必须同步这里**（三方对拍测试是防漂移的锚，test:full 层）。

import type { BlendMode } from "../common/blend-modes.ts";
import { blendChannel } from "../common/blend-modes.ts";

// ---- CPU 程序的执行环境（soft-gl2-port 组好递入）----
// 纹理已解析成统一读面；目标写入（含 blend/量化）由 soft-gl2-port 的 write 回调收口。

export interface SoftTexRead {
  readonly w: number;
  readonly h: number;
  // texel 直读（越界 clamp-to-edge；float 纹理 raw 值，u8 归一 0..1）。out 长度 4。
  fetch(x: number, y: number, out: Float32Array): void;
}

export interface SoftArenaRead {
  readonly tileSize: number;
  // (layer, x, y) 点采（u8 归一）。
  fetch(layer: number, x: number, y: number, out: Float32Array): void;
}

export interface CpuDrawCtx {
  // viewport（目标像素域；scissor 已并进 forEachPixel 的遍历域）。
  vw: number; vh: number;
  uniforms: Record<string, number | boolean | number[] | Float32Array>;
  tex: (name: string) => SoftTexRead | null;         // 2D sampler（缺省 null = 未提供，视作透明占位）
  arena: (name: string) => SoftArenaRead | null;     // sampler2DArray
  // 遍历 viewport∩scissor 的每个像素；frag 返回 false = discard（不写不 blend）。
  forEachPixel(frag: (px: number, py: number, out: Float32Array) => boolean): void;
  // drawInstanced 专用：实例数据（stride 4）+ 数量；实例覆盖域内逐像素（GL 光栅化语义：
  //   像素中心落在实例 quad 内才着色）。soft-gl2-port 保证实例序 = 数组序。
  instances: Float32Array | null;
  count: number;
  // 实例路径专用写口（同一像素可被多实例先后写，逐写 blend+量化——与 GPU 逐 fragment blend 等价）。
  writePixel(px: number, py: number, rgba: Float32Array): void;
}

export type CpuDraw = (ctx: CpuDrawCtx) => void;

// uniform 取值助手（缺省语义 = GLSL 未设置 uniform 的 0 值；draw spec 全量传参时不触发）。
function u1(c: CpuDrawCtx, name: string, def = 0): number {
  const v = c.uniforms[name];
  if (v === undefined) return def;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as number;
}
function uv2(c: CpuDrawCtx, name: string): [number, number] {
  const v = c.uniforms[name] as number[] | Float32Array | undefined;
  return v ? [v[0], v[1]] : [0, 0];
}
function uv3(c: CpuDrawCtx, name: string): [number, number, number] {
  const v = c.uniforms[name] as number[] | Float32Array | undefined;
  return v ? [v[0], v[1], v[2]] : [0, 0, 0];
}
function umat3(c: CpuDrawCtx, name: string): number[] {
  const v = c.uniforms[name] as number[] | Float32Array | undefined;
  return v ? Array.from(v) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

// texture() NEAREST + CLAMP_TO_EDGE（uv 0..1 → texel 点采）。
function sampleNearest(t: SoftTexRead, u: number, v: number, out: Float32Array): void {
  const x = Math.min(t.w - 1, Math.max(0, Math.floor(u * t.w)));
  const y = Math.min(t.h - 1, Math.max(0, Math.floor(v * t.h)));
  t.fetch(x, y, out);
}

// sampleTiled（镜像 compositeFragSource 的 GLSL 同名函数；256 = TILE_SIZE 字面量同步）。
function sampleTiled(index: SoftTexRead | null, arena: SoftArenaRead | null, docX: number, docY: number, out: Float32Array): void {
  out.fill(0);
  if (!index || !arena) return;
  const ts = arena.tileSize;
  const tx = Math.floor(docX / ts), ty = Math.floor(docY / ts);
  if (tx < 0 || tx >= index.w || ty < 0 || ty >= index.h) return;   // texelFetch 越界 = 未定义；索引域内恒成立，防御归透明
  index.fetch(tx, ty, out);
  const slice = out[0];
  if (slice < 0) { out.fill(0); return; }
  const lx = Math.min(ts - 1, Math.max(0, Math.floor(docX - tx * ts)));
  const ly = Math.min(ts - 1, Math.max(0, Math.floor(docY - ty * ts)));
  arena.fetch(Math.round(slice), lx, ly, out);
}

// ---- composite:<mode>:<src>[:<ovMode>]（镜像 compositeFragSource 全分支）----
function makeComposite(mode: BlendMode, src: "tiled" | "group" | "overlay", ovMode: BlendMode): CpuDraw {
  return (c) => {
    const [docW, docH] = uv2(c, "u_docSize");
    const opacity = u1(c, "u_opacity", 1);
    const hasClip = u1(c, "u_hasClip");
    const clipMode = u1(c, "u_clipMode");
    const ovOpacity = u1(c, "u_overlayOpacity", 1);
    const ovErase = u1(c, "u_overlayErase");
    const [ovOx, ovOy] = uv2(c, "u_ovOrigin");
    const [ovSw, ovSh] = uv2(c, "u_ovSize");
    const ovLockAlpha = u1(c, "u_ovLockAlpha");
    const ovHasSel = u1(c, "u_ovHasSel");
    const [selOx, selOy] = uv2(c, "u_ovSelOrigin");
    const [selSw, selSh] = uv2(c, "u_ovSelSize");
    const arr = c.arena("u_arr");
    const srcIndex = c.tex("u_srcIndex");
    const clipIndex = c.tex("u_clipIndex");
    const groupSrc = c.tex("u_groupSrc");
    const overlay = c.tex("u_overlay");
    const dstTex = c.tex("u_dst");
    const clipTex = c.tex("u_clipTex");
    const ovSel = c.tex("u_ovSel");
    const t = new Float32Array(4), base = new Float32Array(4), ov4 = new Float32Array(4), dst = new Float32Array(4);
    c.forEachPixel((px, py, out) => {
      const vx = (px + 0.5) / c.vw, vy = (py + 0.5) / c.vh;
      const docX = vx * docW, docY = vy * docH;
      let srcA = 0; const Cs = [0, 0, 0];
      if (src === "group") {
        if (groupSrc) sampleNearest(groupSrc, vx, vy, t); else t.fill(0);
        srcA = t[3]; Cs[0] = t[0]; Cs[1] = t[1]; Cs[2] = t[2];
      } else if (src === "overlay") {
        sampleTiled(srcIndex, arr, docX, docY, base);
        const ou = (docX - ovOx) / ovSw, ovv = (docY - ovOy) / ovSh;
        if (ou < 0 || ou > 1 || ovv < 0 || ovv > 1 || !overlay) ov4.fill(0);
        else sampleNearest(overlay, ou, ovv, ov4);
        let ovA = ov4[3] * ovOpacity;
        if (ovHasSel === 1) {
          const su = (docX - selOx) / selSw, sv = (docY - selOy) / selSh;
          if (su < 0 || su > 1 || sv < 0 || sv > 1 || !ovSel) ovA *= 0;
          else { sampleNearest(ovSel, su, sv, t); ovA *= t[0]; }
        }
        if (ovErase === 1) {
          // erase 不受锁α影响（v242 CPU 像素笔：erase 分支优先）
          srcA = base[3] * (1 - ovA); Cs[0] = base[0]; Cs[1] = base[1]; Cs[2] = base[2];
        } else if (ovLockAlpha === 1) {
          // 锁α = 真 source-atop（v0.9.12，镜像 blend-glsl 同分支）：α 不动、α=0 处像素完全不变
          const baseA = base[3];
          srcA = baseA;
          for (let k = 0; k < 3; k++) {
            const ovBlend = (1 - baseA) * ov4[k] + baseA * blendChannel(ovMode, base[k], ov4[k]);
            Cs[k] = baseA > 0 ? base[k] + (ovBlend - base[k]) * ovA : base[k];
          }
        } else {
          const baseA = base[3];
          for (let k = 0; k < 3; k++) {
            const ovBlend = (1 - baseA) * ov4[k] + baseA * blendChannel(ovMode, base[k], ov4[k]);
            const sA = ovA + baseA * (1 - ovA);
            Cs[k] = sA > 0 ? (ovBlend * ovA + base[k] * baseA * (1 - ovA)) / sA : 0;
          }
          srcA = ovA + baseA * (1 - ovA);
        }
      } else {
        sampleTiled(srcIndex, arr, docX, docY, t);
        srcA = t[3]; Cs[0] = t[0]; Cs[1] = t[1]; Cs[2] = t[2];
      }
      let as = srcA * opacity;
      if (hasClip === 1) {
        if (clipMode === 1) { if (clipTex) { sampleNearest(clipTex, vx, vy, t); as *= t[3]; } else as = 0; }
        else { sampleTiled(clipIndex, arr, docX, docY, t); as *= t[3]; }
      }
      if (dstTex) sampleNearest(dstTex, vx, vy, dst); else dst.fill(0);
      const ab = dst[3];
      const ao = as + ab * (1 - as);
      for (let k = 0; k < 3; k++) {
        const Csb = (1 - ab) * Cs[k] + ab * blendChannel(mode, dst[k], Cs[k]);
        const Po = as * Csb + dst[k] * ab * (1 - as);
        out[k] = ao > 0 ? Po / ao : 0;
      }
      out[3] = ao;
      return true;
    });
  };
}

// ---- checker（镜像 CHECKER_FRAG：16px 格 #fff/#c8c8c8，预乘不透明）----
const checker: CpuDraw = (c) => {
  const [docW, docH] = uv2(c, "u_docSize");
  c.forEachPixel((px, py, out) => {
    const dx = ((px + 0.5) / c.vw) * docW, dy = ((py + 0.5) / c.vh) * docH;
    const cc = ((Math.floor(dx / 16) + Math.floor(dy / 16)) % 2);
    const col = cc >= 1 ? 0.784314 : 1.0;
    out[0] = col; out[1] = col; out[2] = col; out[3] = 1;
    return true;
  });
};

// ---- present（镜像 PRESENT_FRAG：可选 flipY / unpremult）----
const present: CpuDraw = (c) => {
  const flipY = u1(c, "u_flipY");
  const unpre = u1(c, "u_unpremult");
  const srcT = c.tex("u_src");
  c.forEachPixel((px, py, out) => {
    let vy = (py + 0.5) / c.vh;
    if (flipY === 1) vy = 1 - vy;
    if (srcT) sampleNearest(srcT, (px + 0.5) / c.vw, vy, out); else out.fill(0);
    if (unpre === 1 && out[3] > 0) { out[0] /= out[3]; out[1] /= out[3]; out[2] /= out[3]; }
    return true;
  });
};

// ---- stamp-accum（instanced；镜像 ACCUM_VERT/ACCUM_FRAG）----
// 实例覆盖域 = 中心 ± radius·max(1,aspect) 外接盒；像素中心落域内才算（GL 光栅化）；
//   falloff/椭圆逆变换逐式同 GLSL；逐写 blend（premult-over / max-alpha）由 writePixel 收口。
const stampAccum: CpuDraw = (c) => {
  const [ox, oy] = uv2(c, "u_bboxOrigin");
  const hardness = u1(c, "u_hardness");
  const color = uv3(c, "u_color");
  const buildup = u1(c, "u_buildup");
  const aspect = u1(c, "u_aspect", 1);
  const rotation = u1(c, "u_rotation");
  const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
  const ia = 1 / Math.max(0.01, aspect);
  const inst = c.instances!;
  const out = new Float32Array(4);
  for (let i = 0; i < c.count; i++) {
    const cx = inst[i * 4], cy = inst[i * 4 + 1], radius = inst[i * 4 + 2], alpha = inst[i * 4 + 3];
    const rext = radius * Math.max(1, aspect);
    // 实例 quad 在目标像素域的覆盖（docPos = bboxOrigin + 像素中心）
    const x0 = Math.max(0, Math.floor(cx - rext - ox - 0.5)), x1 = Math.min(c.vw - 1, Math.ceil(cx + rext - ox - 0.5));
    const y0 = Math.max(0, Math.floor(cy - rext - oy - 0.5)), y1 = Math.min(c.vh - 1, Math.ceil(cy + rext - oy - 0.5));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const lx = ox + px + 0.5 - cx, ly = oy + py + 0.5 - cy;   // v_local
        if (Math.abs(lx) > rext || Math.abs(ly) > rext) continue;   // quad 外（像素中心不在实例内）
        const dxR = cosR * lx + sinR * ly;
        const dyR = (-sinR * lx + cosR * ly) * ia;
        const dist = Math.sqrt(dxR * dxR + dyR * dyR);
        const innerR = hardness * radius;
        const decayLen = radius - innerR;
        if (dist >= radius) continue;   // discard
        let shapeA: number;
        if (decayLen <= 0 || dist <= innerR) shapeA = 1;
        else { const u = (dist - innerR) / decayLen; shapeA = 1 - u * u * (3 - 2 * u); }
        const dabA = alpha * shapeA;
        if (buildup === 1) { out[0] = color[0] * dabA; out[1] = color[1] * dabA; out[2] = color[2] * dabA; out[3] = dabA; }
        else { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = dabA; }
        c.writePixel(px, py, out);
      }
    }
  }
};

// ---- stamp-color（镜像 COLOR_FRAG：wash 累积 α 上色 → premult RGBA）----
const stampColor: CpuDraw = (c) => {
  const color = uv3(c, "u_color");
  const accum = c.tex("u_accum");
  const t = new Float32Array(4);
  c.forEachPixel((px, py, out) => {
    if (accum) sampleNearest(accum, (px + 0.5) / c.vw, (py + 0.5) / c.vh, t); else t.fill(0);
    const a = t[3];
    out[0] = color[0] * a; out[1] = color[1] * a; out[2] = color[2] * a; out[3] = a;
    return true;
  });
};

// ---- warp 采样器族（镜像 WARP_FUNCS 逐式：cubicK/bsp3/sampleSpline/sampleSrc/warpSample）----
function cubicK(t: number): number {
  const a = -0.5, at = Math.abs(t);
  if (at < 1) return (a + 2) * at * at * at - (a + 3) * at * at + 1;
  if (at < 2) return a * at * at * at - 5 * a * at * at + 8 * a * at - 4 * a;
  return 0;
}
function bsp3(t: number): number {
  const at = Math.abs(t);
  if (at < 1) return 2 / 3 - at * at + at * at * at * 0.5;
  if (at < 2) { const u = 2 - at; return u * u * u / 6; }
  return 0;
}
function sampleSpline(tex: SoftTexRead, sizeW: number, sizeH: number, sx: number, sy: number, out: Float32Array): void {
  const PAD = 8;
  const PW = Math.trunc(sizeW) + 16, PH = Math.trunc(sizeH) + 16;
  const cx = sx + PAD, cy = sy + PAD;
  const ix = Math.floor(cx), iy = Math.floor(cy);
  const kx = [bsp3(ix - 1 - cx), bsp3(ix - cx), bsp3(ix + 1 - cx), bsp3(ix + 2 - cx)];
  const ky = [bsp3(iy - 1 - cy), bsp3(iy - cy), bsp3(iy + 1 - cy), bsp3(iy + 2 - cy)];
  let r = 0, g = 0, b = 0, a = 0;
  const ca = new Float32Array(16);
  const t = new Float32Array(4);
  for (let j = 0; j < 4; j++) {
    const yy = iy - 1 + j; if (yy < 0 || yy >= PH) continue;
    for (let i = 0; i < 4; i++) {
      const xx = ix - 1 + i; if (xx < 0 || xx >= PW) continue;
      tex.fetch(xx, yy, t);
      const ww = kx[i] * ky[j];
      r += t[0] * ww; g += t[1] * ww; b += t[2] * ww; a += t[3] * ww;
      ca[j * 4 + i] = t[3];
    }
  }
  out.fill(0);
  if (a < 1.0e-4) return;
  const na = new Float32Array(4);
  for (let v = 0; v < 2; v++) for (let u = 0; u < 2; u++) {
    let acc = 0;
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
      acc += ca[(v + 1 + dv) * 4 + (u + 1 + du)] * ((du === 0 ? 4 : 1) / 6) * ((dv === 0 ? 4 : 1) / 6);
    }
    na[v * 2 + u] = acc;
  }
  const amin = Math.min(na[0], na[1], na[2], na[3]);
  const amax = Math.max(na[0], na[1], na[2], na[3]);
  const acl = Math.min(Math.max(a, amin), amax);
  if (acl !== a) { const sc = acl / a; r *= sc; g *= sc; b *= sc; a = acl; }
  if (a < 1.0e-4) return;
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  out[0] = clamp01(r / a); out[1] = clamp01(g / a); out[2] = clamp01(b / a); out[3] = clamp01(a / 255);
}
function sampleSrc(tex: SoftTexRead, sizeW: number, sizeH: number, mode: number, sx: number, sy: number, out: Float32Array): void {
  if (mode === 3) { sampleSpline(tex, sizeW, sizeH, sx, sy, out); return; }
  const W = Math.trunc(sizeW), H = Math.trunc(sizeH);
  const ix = Math.floor(sx), iy = Math.floor(sy);
  out.fill(0);
  const t = new Float32Array(4);
  if (mode === 0) {
    if (ix < 0 || ix >= W || iy < 0 || iy >= H) return;
    tex.fetch(ix, iy, out);
    return;
  } else if (mode === 1) {
    const fx = sx - ix, fy = sy - iy;
    if (ix < -1 || ix >= W || iy < -1 || iy >= H) return;
    const clampi = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const x0 = clampi(ix, 0, W - 1), x1 = clampi(ix + 1, 0, W - 1);
    const y0 = clampi(iy, 0, H - 1), y1 = clampi(iy + 1, 0, H - 1);
    const c00 = new Float32Array(4), c10 = new Float32Array(4), c01 = new Float32Array(4), c11 = new Float32Array(4);
    tex.fetch(x0, y0, c00); tex.fetch(x1, y0, c10); tex.fetch(x0, y1, c01); tex.fetch(x1, y1, c11);
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const a = c00[3] * w00 + c10[3] * w10 + c01[3] * w01 + c11[3] * w11;
    if (a < 4.0e-7) return;
    for (let k = 0; k < 3; k++) {
      const pm = c00[k] * c00[3] * w00 + c10[k] * c10[3] * w10 + c01[k] * c01[3] * w01 + c11[k] * c11[3] * w11;
      out[k] = pm / a;
    }
    out[3] = a;
    return;
  }
  // bicubic：4×4 Catmull-Rom + 反振铃限幅（v0.6.43）
  const kx = [cubicK(ix - 1 - sx), cubicK(ix - sx), cubicK(ix + 1 - sx), cubicK(ix + 2 - sx)];
  const ky = [cubicK(iy - 1 - sy), cubicK(iy - sy), cubicK(iy + 1 - sy), cubicK(iy + 2 - sy)];
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 4; j++) {
    const yy = iy - 1 + j; if (yy < 0 || yy >= H) continue;
    for (let i = 0; i < 4; i++) {
      const xx = ix - 1 + i; if (xx < 0 || xx >= W) continue;
      tex.fetch(xx, yy, t);
      const av = t[3], ww = kx[i] * ky[j];
      r += t[0] * av * ww; g += t[1] * av * ww; b += t[2] * av * ww; a += av * ww;
    }
  }
  const nA = (xx: number, yy: number): number => {
    if (xx < 0 || xx >= W || yy < 0 || yy >= H) return 0;
    tex.fetch(xx, yy, t); return t[3];
  };
  const n00 = nA(ix, iy), n10 = nA(ix + 1, iy), n01 = nA(ix, iy + 1), n11 = nA(ix + 1, iy + 1);
  const acl = Math.min(Math.max(a, Math.min(n00, n10, n01, n11)), Math.max(n00, n10, n01, n11));
  if (acl !== a && a > 4.0e-7) { const sc = acl / a; r *= sc; g *= sc; b *= sc; a = acl; }
  const aOut = Math.min(1, Math.max(0, a));
  if (a < 4.0e-7) return;
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  out[0] = clamp01(r / a); out[1] = clamp01(g / a); out[2] = clamp01(b / a); out[3] = aOut;
}
function warpSample(tex: SoftTexRead, sizeW: number, sizeH: number, hinv: number[], mode: number, docX: number, docY: number, out: Float32Array): void {
  const w = hinv[6] * docX + hinv[7] * docY + hinv[8];
  out.fill(0);
  if (Math.abs(w) < 1.0e-9) return;
  const u = (hinv[0] * docX + hinv[1] * docY + hinv[2]) / w;
  const v = (hinv[3] * docX + hinv[4] * docY + hinv[5]) / w;
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const off = mode === 0 ? 0 : 0.5;
  sampleSrc(tex, sizeW, sizeH, mode, u * sizeW - off, v * sizeH - off, out);
}

// ---- warp（镜像 WARP_FRAG：live 浮层 pass，直值累积器 source-over + 可选 clip 基底 gather）----
const warp: CpuDraw = (c) => {
  const [docW, docH] = uv2(c, "u_docSize");
  const [srcW, srcH] = uv2(c, "u_srcSize");
  const hinv = umat3(c, "u_Hinv");
  const mode = u1(c, "u_mode");
  const clip = u1(c, "u_clip");
  const [baseW, baseH] = uv2(c, "u_baseSize");
  const baseHinv = umat3(c, "u_baseHinv");
  const baseMode = u1(c, "u_baseMode");
  const dstT = c.tex("u_dst"), srcT = c.tex("u_src"), baseT = c.tex("u_baseTex");
  const s = new Float32Array(4), dst = new Float32Array(4), bs = new Float32Array(4);
  c.forEachPixel((px, py, out) => {
    const vx = (px + 0.5) / c.vw, vy = (py + 0.5) / c.vh;
    if (dstT) sampleNearest(dstT, vx, vy, dst); else dst.fill(0);
    const docX = vx * docW, docY = vy * docH;
    if (srcT) warpSample(srcT, srcW, srcH, hinv, mode, docX, docY, s); else s.fill(0);
    if (clip === 1 && s[3] > 0 && baseT) {
      warpSample(baseT, baseW, baseH, baseHinv, baseMode, docX, docY, bs);
      s[3] *= bs[3];
    }
    const ao = s[3] + dst[3] * (1 - s[3]);
    for (let k = 0; k < 3; k++) {
      const Po = s[k] * s[3] + dst[k] * dst[3] * (1 - s[3]);
      out[k] = ao > 0 ? Po / ao : 0;
    }
    out[3] = ao;
    return true;
  });
};

// ---- warpbake（镜像 WARP_BAKE_FRAG：commit 烤定，straight 输出、不合成）----
const warpbake: CpuDraw = (c) => {
  const [bx, by] = uv2(c, "u_bakeOrigin");
  const [bw, bh] = uv2(c, "u_bakeSize");
  const [srcW, srcH] = uv2(c, "u_srcSize");
  const hinv = umat3(c, "u_Hinv");
  const mode = u1(c, "u_mode");
  const srcT = c.tex("u_src");
  c.forEachPixel((px, py, out) => {
    const docX = bx + ((px + 0.5) / c.vw) * bw, docY = by + ((py + 0.5) / c.vh) * bh;
    if (srcT) warpSample(srcT, srcW, srcH, hinv, mode, docX, docY, out); else out.fill(0);
    return true;
  });
};

// ---- 注册表 ----
// GPU-only 显式登记（屏显专属，headless 不需要；SoftGl2Port draw 到这些名字响亮 throw）。
const GPU_ONLY = new Set<string>(["present-affine", "present-affine-over", "screen-bg"]);

// 按名解析：命中 CPU 实现 → 返回；GPU-only → "gpu-only"；两边都没有 → null（program() 响亮拒）。
export function resolveCpuProgram(name: string): CpuDraw | "gpu-only" | null {
  if (GPU_ONLY.has(name)) return "gpu-only";
  if (name === "checker") return checker;
  if (name === "present") return present;
  if (name === "stamp-accum") return stampAccum;
  if (name === "stamp-color") return stampColor;
  if (name === "warp") return warp;
  if (name === "warpbake") return warpbake;
  if (name.startsWith("composite:")) {
    const parts = name.split(":");   // composite:<mode>:<src>[:<ovMode>]
    const mode = parts[1] as BlendMode;
    const src = parts[2] as "tiled" | "group" | "overlay";
    const ovMode = (parts[3] ?? "source-over") as BlendMode;
    return makeComposite(mode, src, ovMode);
  }
  return null;
}
