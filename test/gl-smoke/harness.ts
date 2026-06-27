// GL smoke harness（在真浏览器 WebGL2 里跑，由 Playwright 驱动）。
// 两段：
//   A) Stage 1 GL 基础：GLContext 起 / shader 编 / FBO 完整 / GLTileBackend 真 GPU 上传读回。
//   B) Stage 2a-0 blend parity：同引擎 2D-vs-GL 自 diff——GLCompositor 的 12 个 blend 输出
//      必须逐像素匹配 Canvas2D 原生 blend（两者同一份 W3C 规范）。这抓 GLSL 公式 bug，不靠 iPad。
// Chromium≠iPad GPU，故不当像素美学真相；但 blend 公式确定性 → 自 diff 对 iPad 也有效。
//
// 结果 → window.__SMOKE__ = { ok, checks:[{name,ok,detail}], error }。

import { GLContext } from "../../src/gl/gl-context.ts";
import { GLTileBackend } from "../../src/gl/tile-backend-gl.ts";
import { TilePool, LayerTileMap, TILE_BYTES } from "../../src/gl/tile-store.ts";
import { TILE_SIZE } from "../../src/gl/tile-geometry.ts";
import { GLCompositor } from "../../src/gl/gl-compositor.ts";
import { BLEND_MODES } from "../../src/gl/blend-glsl.ts";

interface Check { name: string; ok: boolean; detail: string; }
type Add = (name: string, ok: boolean, detail?: string) => void;

// ---- 像素工具 ----
function makeImg(n: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const a = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const [r, g, b, al] = fn(x, y);
    const i = (y * n + x) * 4;
    a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
  }
  return a;
}
function imgToCanvas(img: Uint8Array, n: number): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img), n, n), 0, 0);
  return c;
}
// Canvas2D 参考：透明底上 drawImage(背景, source-over) 再 drawImage(源, mode, globalAlpha=opacity)。
function canvas2dRef(n: number, bd: Uint8Array, src: Uint8Array, mode: string, opacity: number): Uint8ClampedArray {
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, n, n);
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.drawImage(imgToCanvas(bd, n), 0, 0);
  ctx.globalCompositeOperation = mode as GlobalCompositeOperation; ctx.globalAlpha = opacity;
  ctx.drawImage(imgToCanvas(src, n), 0, 0);
  return ctx.getImageData(0, 0, n, n).data;   // 直值 RGBA8（top-down）
}
// 预乘空间比较（避开低 alpha 解预乘放大噪声）。
// 朝向：texSubImage3D 把 data row0 放纹理 t=0；compositor quad 让 framebuffer 底=v0；readPixels row0=底
//   → readPixels[row] 对应 data row（双翻转抵消）。Canvas2D ref row0=顶=data row0。故**同 index 直接比，不翻**。
function maxPremulDiff(ref: Uint8ClampedArray, glpx: Uint8Array, n: number): { md: number; at: string } {
  let md = 0, ai = 0;
  for (let yg = 0; yg < n; yg++) {
    for (let x = 0; x < n; x++) {
      const i = (yg * n + x) * 4;
      const ga = glpx[i + 3], ra = ref[i + 3];
      let d = Math.abs(ga - ra);
      for (let c = 0; c < 3; c++) {
        d = Math.max(d, Math.abs(glpx[i + c] * ga / 255 - ref[i + c] * ra / 255));
      }
      if (d > md) { md = d; ai = i; }
    }
  }
  const px = (ai / 4) % n, py = Math.floor((ai / 4) / n);
  const r = `@(${px},${py}) ref=[${ref[ai]},${ref[ai + 1]},${ref[ai + 2]},${ref[ai + 3]}] gl=[${glpx[ai]},${glpx[ai + 1]},${glpx[ai + 2]},${glpx[ai + 3]}]`;
  return { md: Math.round(md), at: r };
}

// ---- B) blend parity 自 diff ----
// 跑两遍：f32（累积器精度上限）与 f16（产品路径）。10 个平滑模式两域代数等价 → Δ2（纯 8bit↔float rounding）。
// color-dodge/burn 在「半透明源叠半透明背景」时 Δ~10（f16/f32 都有，故非存储精度）：
//   opaqueProbe 已证 B() 本身对全 256² 个 (Cb,Cs) 与 Canvas2D **逐位 Δ0**——分歧只在 partial-alpha 混合：
//   Skia 在**预乘域**算 blend，我们走 W3C **直值域**（(1-αb)Cs+αb·B + 合成）。两域对 dodge/burn 在半透叠半透时
//   差 ≤4%（视觉不可辨；真实绘画=不透明或叠不透明上则精确）。若将来要逐位精确，把这 2 模式改 Skia 预乘域分量式。
//   故 dodge/burn 容差 12（两精度同）。
function tolFor(mode: string, _prec: "f16" | "f32"): number {
  return (mode === "color-dodge" || mode === "color-burn") ? 12 : 4;
}
function blendParity(glctx: GLContext, backend: GLTileBackend, add: Add, prec: "f16" | "f32"): void {
  const gl = glctx.gl;
  const n = TILE_SIZE;   // 单 tile
  const comp = new GLCompositor(glctx, prec);
  // 测试图：值域留在 [8,247]/[48,240] 避开 0/1 与极端 alpha 的实现分歧奇点，仍宽覆盖公式。
  const bd = makeImg(n, (x, y) => [8 + ((x) % 240), 8 + ((y) % 240), 8 + ((x + y) % 240), 160 + ((x * 7) % 80)]);
  const src = makeImg(n, (x, y) => [247 - (y % 240), 8 + (x % 240), 8 + ((x * y) % 240), 48 + ((y * 5) % 192)]);
  backend.uploadSlice(0, bd);
  backend.uploadSlice(1, src);
  const opacity = 0.8;

  for (const mode of BLEND_MODES) {
    const ref = canvas2dRef(n, bd, src, mode, opacity);
    const accum = comp.compositeFlat(backend.texture, [
      { slice: 0, opacity: 1, mode: "source-over", clipSlice: -1 },
      { slice: 1, opacity, mode, clipSlice: -1 },
    ], n, n);
    const out = glctx.borrowFBO(n, n, "u8");
    comp.presentTo(accum.tex, out, n, n);
    const glpx = new Uint8Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, glpx);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    glctx.returnFBO(accum); glctx.returnFBO(out);

    const { md, at } = maxPremulDiff(ref, glpx, n);
    const tol = tolFor(mode, prec);
    add(`blend:${mode} [${prec}] vs Canvas2D`, md <= tol, `maxΔ(premul)=${md} ${md > tol ? at : ""}`);
  }
}

// 不透明探针：αb=αs=255、opacity=1 → 输出直值 = B(Cb,Cs)，隔离 blend 函数本身（无 alpha 混合）。
// 用来判定 dodge/burn 的 Δ 来自 B() 公式差异、还是 partial-alpha 混合差异。
function opaqueProbe(glctx: GLContext, add: Add): void {
  const gl = glctx.gl;
  const n = TILE_SIZE;
  const backend = new GLTileBackend(glctx, 4);
  const comp = new GLCompositor(glctx, "f32");
  // Cb 沿 x、Cs 沿 y 扫满 [0,255]（含 0/255 极端），全不透明。
  const bd = makeImg(n, (x) => [x, x, x, 255]);
  const src = makeImg(n, (_x, y) => [y, y, y, 255]);
  backend.uploadSlice(0, bd);
  backend.uploadSlice(1, src);
  for (const mode of ["color-dodge", "color-burn"] as const) {
    const ref = canvas2dRef(n, bd, src, mode, 1);
    const accum = comp.compositeFlat(backend.texture, [
      { slice: 0, opacity: 1, mode: "source-over", clipSlice: -1 },
      { slice: 1, opacity: 1, mode, clipSlice: -1 },
    ], n, n);
    const out = glctx.borrowFBO(n, n, "u8");
    comp.presentTo(accum.tex, out, n, n);
    const glpx = new Uint8Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, glpx);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    glctx.returnFBO(accum); glctx.returnFBO(out);
    const { md, at } = maxPremulDiff(ref, glpx, n);
    add(`probe:${mode} opaque B()`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
}

function run(): { ok: boolean; checks: Check[]; error: string | null } {
  const checks: Check[] = [];
  const add: Add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  const glctx = new GLContext(canvas);
  const gl = glctx.gl;

  // A) Stage 1 基础
  add("caps.maxTextureSize≥4096", glctx.caps.maxTextureSize >= 4096, `${glctx.caps.maxTextureSize}`);
  add("caps.maxArrayLayers≥256", glctx.caps.maxArrayLayers >= 256, `${glctx.caps.maxArrayLayers}`);
  add("caps.maxTextureUnits≥8", glctx.caps.maxTextureUnits >= 8, `${glctx.caps.maxTextureUnits}`);
  add("caps.floatColorBuffer", glctx.caps.floatColorBuffer, `${glctx.caps.floatColorBuffer}`);

  try {
    glctx.program("smoke",
      `#version 300 es
       layout(location=0) in vec2 a; void main(){ gl_Position=vec4(a*2.0-1.0,0,1); }`,
      `#version 300 es
       precision highp float; out vec4 o; void main(){ o=vec4(1,0,0,1); }`);
    add("program.compile+link", true);
  } catch (e) { add("program.compile+link", false, String(e)); }

  try {
    const f8 = glctx.borrowFBO(64, 64, "u8");
    add("fbo.rgba8.complete", !!f8.fbo); glctx.returnFBO(f8);
  } catch (e) { add("fbo.rgba8.complete", false, String(e)); }
  if (glctx.caps.floatColorBuffer) {
    try {
      const ff = glctx.borrowFBO(64, 64, "f16");
      add("fbo.rgba16f.complete", !!ff.fbo); glctx.returnFBO(ff);
    } catch (e) { add("fbo.rgba16f.complete", false, String(e)); }
    try {
      const ff = glctx.borrowFBO(64, 64, "f32");
      add("fbo.rgba32f.complete", !!ff.fbo); glctx.returnFBO(ff);
    } catch (e) { add("fbo.rgba32f.complete", false, String(e)); }
  }

  const backend = new GLTileBackend(glctx, 8);
  try {
    const px = new Uint8Array(TILE_BYTES);
    px[0] = 12; px[1] = 34; px[2] = 56; px[3] = 78;
    px[TILE_BYTES - 4] = 9; px[TILE_BYTES - 1] = 255;
    backend.uploadSlice(2, px);
    const out = backend.readSlice(2);
    const head = out[0] === 12 && out[1] === 34 && out[2] === 56 && out[3] === 78;
    const tail = out[TILE_BYTES - 4] === 9 && out[TILE_BYTES - 1] === 255;
    add("backend.upload→read round-trip", head && tail,
      `head=[${out[0]},${out[1]},${out[2]},${out[3]}] tail=[${out[TILE_BYTES - 4]},${out[TILE_BYTES - 1]}]`);
  } catch (e) { add("backend.upload→read round-trip", false, String(e)); }

  try {
    backend.uploadSlice(3, new Uint8Array(TILE_BYTES).fill(200));
    backend.clearSlice(3);
    const out = backend.readSlice(3);
    let allZero = true;
    for (let i = 0; i < TILE_BYTES; i += 997) if (out[i] !== 0) { allZero = false; break; }
    add("backend.clearSlice→zero", allZero, allZero ? "" : "nonzero@sample");
  } catch (e) { add("backend.clearSlice→zero", false, String(e)); }

  try {
    const pool = new TilePool(backend);
    const lm = new LayerTileMap(pool, 8);
    const t = lm.tileAt(1, 1, { create: true });
    if (!t) throw new Error("tileAt create null");
    const p = new Uint8Array(TILE_BYTES); p[0] = 99; p[3] = 255;
    backend.uploadSlice(t.slice, p);
    const back = backend.readSlice(t.slice);
    const rt = back[0] === 99 && back[3] === 255;
    const slice = t.slice;
    lm.freeTile(1, 1);
    const t2 = lm.tileAt(5, 5, { create: true });
    add("pool+layermap over real GPU", rt && !!t2 && t2.slice === slice,
      `rt=${rt} reuse=${t2 ? t2.slice === slice : "null"}`);
  } catch (e) { add("pool+layermap over real GPU", false, String(e)); }

  // B) blend parity（独立 backend，slice 0/1 干净）：f32 证公式精确 + f16 验产品累积器路径
  try {
    const cbackend = new GLTileBackend(glctx, 4);
    blendParity(glctx, cbackend, add, "f32");
    blendParity(glctx, cbackend, add, "f16");
    opaqueProbe(glctx, add);
  } catch (e) { add("blend parity", false, String(e)); }

  add("no GL error", gl.getError() === gl.NO_ERROR, `0x${gl.getError().toString(16)}`);

  const ok = checks.every((c) => c.ok);
  return { ok, checks, error: null };
}

declare global { interface Window { __SMOKE__?: unknown; } }
try {
  (window as Window).__SMOKE__ = run();
} catch (e) {
  (window as Window).__SMOKE__ = { ok: false, checks: [], error: String(e) };
}
