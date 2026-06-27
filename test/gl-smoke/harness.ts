// GL smoke harness（真浏览器 WebGL2，Playwright 驱动）。四段：
//   A) Stage 1 GL 基础：GLContext 起 / shader 编 / FBO 完整 / GLTileBackend 真 GPU 上传读回。
//   B) blend/clip parity：同引擎 2D-vs-GL 自 diff，12 blend + clip vs Canvas2D 原生（W3C 同规范）。
//   C) 多 tile：512²(2×2) + 空 tile 稀疏 vs Canvas2D 整图。
//   D) 组：隔离/pass-through/嵌套/组内 clip vs **真 layer-composite.ts compositeLayers**（产品 2D 合成器=golden）。
// Chromium≠iPad GPU，故不当像素美学真相；blend 公式确定性 → 自 diff 对 iPad 也有效。
// 结果 → window.__SMOKE__ = { ok, checks:[{name,ok,detail}], error }。

import { GLContext } from "../../src/gl/gl-context.ts";
import { GLTileBackend } from "../../src/gl/tile-backend-gl.ts";
import { TilePool, LayerTileMap, TILE_BYTES } from "../../src/gl/tile-store.ts";
import { TILE_SIZE } from "../../src/gl/tile-geometry.ts";
import { GLCompositor } from "../../src/gl/gl-compositor.ts";
import { TileIndexTexture } from "../../src/gl/tile-index.ts";
import { BLEND_MODES } from "../../src/gl/blend-glsl.ts";
import { compositeLayers } from "../../src/layer-composite.ts";

interface Check { name: string; ok: boolean; detail: string; }
type Add = (name: string, ok: boolean, detail?: string) => void;
type Leaf = { kind: "leaf"; srcIndex: TileIndexTexture; opacity: number; mode: string; clip: boolean; visible: boolean; hasContent: boolean };

// ---- 像素工具 ----
function makeImg(n: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const a = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const [r, g, b, al] = fn(x, y); const i = (y * n + x) * 4;
    a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
  }
  return a;
}
function subTile(img: Uint8Array, imgN: number, tx: number, ty: number): Uint8Array {
  const t = new Uint8Array(TILE_BYTES);
  for (let y = 0; y < TILE_SIZE; y++) for (let x = 0; x < TILE_SIZE; x++) {
    const sx = tx * TILE_SIZE + x, sy = ty * TILE_SIZE + y;
    if (sx < imgN && sy < imgN) {
      const si = (sy * imgN + sx) * 4, di = (y * TILE_SIZE + x) * 4;
      t[di] = img[si]; t[di + 1] = img[si + 1]; t[di + 2] = img[si + 2]; t[di + 3] = img[si + 3];
    }
  }
  return t;
}
function imgToCanvas(img: Uint8Array, n: number): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img), n, n), 0, 0);
  return c;
}
function canvas2dRef(n: number, bd: Uint8Array, src: Uint8Array, mode: string, opacity: number): Uint8ClampedArray {
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, n, n);
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.drawImage(imgToCanvas(bd, n), 0, 0);
  ctx.globalCompositeOperation = mode as GlobalCompositeOperation; ctx.globalAlpha = opacity;
  ctx.drawImage(imgToCanvas(src, n), 0, 0);
  return ctx.getImageData(0, 0, n, n).data;
}
function canvas2dClipRef(n: number, base: Uint8Array, clip: Uint8Array, mode: string, opacity: number): Uint8ClampedArray {
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(imgToCanvas(base, n), 0, 0);
  const t = document.createElement("canvas"); t.width = n; t.height = n;
  const tctx = t.getContext("2d")!;
  tctx.drawImage(imgToCanvas(clip, n), 0, 0);
  tctx.globalCompositeOperation = "destination-in";
  tctx.drawImage(imgToCanvas(base, n), 0, 0);
  ctx.globalCompositeOperation = mode as GlobalCompositeOperation; ctx.globalAlpha = opacity;
  ctx.drawImage(t, 0, 0);
  return ctx.getImageData(0, 0, n, n).data;
}
function maxPremulDiff(ref: Uint8ClampedArray, glpx: Uint8Array, n: number): { md: number; at: string } {
  let md = 0, ai = 0;
  for (let i = 0; i < n * n * 4; i += 4) {
    const ga = glpx[i + 3], ra = ref[i + 3];
    let d = Math.abs(ga - ra);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(glpx[i + c] * ga / 255 - ref[i + c] * ra / 255));
    if (d > md) { md = d; ai = i; }
  }
  const px = (ai / 4) % n, py = Math.floor((ai / 4) / n);
  return { md: Math.round(md), at: `@(${px},${py}) ref=[${ref[ai]},${ref[ai + 1]},${ref[ai + 2]},${ref[ai + 3]}] gl=[${glpx[ai]},${glpx[ai + 1]},${glpx[ai + 2]},${glpx[ai + 3]}]` };
}
function idx1(glctx: GLContext, slice: number): TileIndexTexture {
  const t = new TileIndexTexture(glctx, TILE_SIZE, TILE_SIZE); t.setTile(0, 0, slice); return t;
}
function L(srcIndex: TileIndexTexture, opacity: number, mode: string, clip = false): Leaf {
  return { kind: "leaf", srcIndex, opacity, mode, clip, visible: true, hasContent: true };
}
function readComposite(glctx: GLContext, comp: GLCompositor, accum: { tex: WebGLTexture }, n: number): Uint8Array {
  const gl = glctx.gl;
  const out = glctx.borrowFBO(n, n, "u8");
  comp.presentTo(accum.tex, out, n, n);
  const px = new Uint8Array(n * n * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
  gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  glctx.returnFBO(out);
  return px;
}

// ---- B) blend parity ----
function tolFor(mode: string): number { return (mode === "color-dodge" || mode === "color-burn") ? 12 : 4; }
function blendParity(glctx: GLContext, backend: GLTileBackend, add: Add, prec: "f16" | "f32"): void {
  const n = TILE_SIZE; const comp = new GLCompositor(glctx, prec);
  const bd = makeImg(n, (x, y) => [8 + (x % 240), 8 + (y % 240), 8 + ((x + y) % 240), 160 + ((x * 7) % 80)]);
  const src = makeImg(n, (x, y) => [247 - (y % 240), 8 + (x % 240), 8 + ((x * y) % 240), 48 + ((y * 5) % 192)]);
  backend.uploadSlice(0, bd); backend.uploadSlice(1, src);
  const i0 = idx1(glctx, 0), i1 = idx1(glctx, 1); const opacity = 0.8;
  for (const mode of BLEND_MODES) {
    const ref = canvas2dRef(n, bd, src, mode, opacity);
    const accum = comp.composite(backend.texture, [L(i0, 1, "source-over"), L(i1, opacity, mode)], n, n);
    const glpx = readComposite(glctx, comp, accum, n); glctx.returnFBO(accum);
    const { md, at } = maxPremulDiff(ref, glpx, n); const tol = tolFor(mode);
    add(`blend:${mode} [${prec}] vs Canvas2D`, md <= tol, `maxΔ=${md} ${md > tol ? at : ""}`);
  }
  i0.dispose(); i1.dispose();
}
function opaqueProbe(glctx: GLContext, add: Add): void {
  const n = TILE_SIZE; const backend = new GLTileBackend(glctx, 4); const comp = new GLCompositor(glctx, "f32");
  const bd = makeImg(n, (x) => [x, x, x, 255]); const src = makeImg(n, (_x, y) => [y, y, y, 255]);
  backend.uploadSlice(0, bd); backend.uploadSlice(1, src);
  const i0 = idx1(glctx, 0), i1 = idx1(glctx, 1);
  for (const mode of ["color-dodge", "color-burn"] as const) {
    const ref = canvas2dRef(n, bd, src, mode, 1);
    const accum = comp.composite(backend.texture, [L(i0, 1, "source-over"), L(i1, 1, mode)], n, n);
    const glpx = readComposite(glctx, comp, accum, n); glctx.returnFBO(accum);
    const { md, at } = maxPremulDiff(ref, glpx, n);
    add(`probe:${mode} opaque B()`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
  i0.dispose(); i1.dispose();
}
function clipParity(glctx: GLContext, add: Add): void {
  const n = TILE_SIZE; const backend = new GLTileBackend(glctx, 4); const comp = new GLCompositor(glctx, "f32");
  const base = makeImg(n, (x, y) => [200, 40 + (x % 200), 40 + (y % 200), (x + y < n) ? 255 : ((x + y) % 256)]);
  const clip = makeImg(n, (x, y) => [40 + (y % 200), 8 + (x % 240), 200, 255]);
  backend.uploadSlice(0, base); backend.uploadSlice(1, clip);
  const i0 = idx1(glctx, 0), i1 = idx1(glctx, 1);
  for (const mode of ["source-over", "multiply"] as const) {
    const opacity = 0.9;
    const ref = canvas2dClipRef(n, base, clip, mode, opacity);
    // clip 基底由 composite 内部 resolveClipBases 自动定位（base=底层叶）
    const accum = comp.composite(backend.texture, [L(i0, 1, "source-over"), L(i1, opacity, mode, true)], n, n);
    const glpx = readComposite(glctx, comp, accum, n); glctx.returnFBO(accum);
    const { md, at } = maxPremulDiff(ref, glpx, n);
    add(`clip:${mode} vs Canvas2D`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
  i0.dispose(); i1.dispose();
}

// ---- C) 多 tile ----
function multiTileParity(glctx: GLContext, add: Add): void {
  const N = 512; const backend = new GLTileBackend(glctx, 8); const comp = new GLCompositor(glctx, "f32");
  const bd = makeImg(N, (x, y) => [8 + (x % 240), 8 + (y % 240), 8 + ((x + y) % 240), 255]);
  const top = makeImg(N, (x, y) => ((x < 256 && y < 256) || (x >= 256 && y >= 256)) ? [240 - (x % 240), 8 + (y % 240), 100, 200] : [0, 0, 0, 0]);
  const bdIdx = new TileIndexTexture(glctx, N, N); let s = 0;
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) { backend.uploadSlice(s, subTile(bd, N, tx, ty)); bdIdx.setTile(tx, ty, s); s++; }
  const topIdx = new TileIndexTexture(glctx, N, N);
  backend.uploadSlice(4, subTile(top, N, 0, 0)); topIdx.setTile(0, 0, 4);
  backend.uploadSlice(5, subTile(top, N, 1, 1)); topIdx.setTile(1, 1, 5);
  const accum = comp.composite(backend.texture, [L(bdIdx, 1, "source-over"), L(topIdx, 1, "source-over")], N, N);
  const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
  const ref = canvas2dRef(N, bd, top, "source-over", 1);
  const { md, at } = maxPremulDiff(ref, glpx, N);
  add("multitile:2x2 + empty-tile sparsity vs Canvas2D", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  bdIdx.dispose(); topIdx.dispose();
}

// ---- D) 组：vs 真 layer-composite.ts compositeLayers（golden）----
// spec → (GL CompNode 树, 2D fake-node 树)。每 leaf 单 tile（256²）。
interface LeafSpec { t: "leaf"; img: Uint8Array; opacity?: number; mode?: string; clip?: boolean; visible?: boolean }
interface GroupSpec { t: "group"; children: Spec[]; opacity?: number; mode?: string; clip?: boolean; visible?: boolean }
type Spec = LeafSpec | GroupSpec;

function groupParity(glctx: GLContext, add: Add): void {
  const n = TILE_SIZE;
  const A = makeImg(n, (x, y) => [200, 60 + (x % 180), 60 + (y % 180), 255]);
  const B = makeImg(n, (x, y) => [40 + (x % 200), 200, 80 + (y % 160), 220]);
  const C = makeImg(n, (x, y) => [80, 40 + (y % 200), 220, (x + y < n) ? 255 : 60]);
  const D = makeImg(n, (x, y) => [220, 220, 40 + ((x * y) % 200), 160]);

  const scenes: { name: string; spec: Spec[] }[] = [
    { name: "隔离组 multiply", spec: [{ t: "leaf", img: A }, { t: "group", mode: "multiply", children: [{ t: "leaf", img: B }, { t: "leaf", img: C }] }] },
    { name: "组 opacity0.6", spec: [{ t: "leaf", img: A }, { t: "group", mode: "source-over", opacity: 0.6, children: [{ t: "leaf", img: B }] }] },
    { name: "组内 clip", spec: [{ t: "leaf", img: A }, { t: "group", mode: "source-over", children: [{ t: "leaf", img: B }, { t: "leaf", img: C, clip: true }] }] },
    { name: "pass-through+multiply 子", spec: [{ t: "leaf", img: A }, { t: "group", mode: "pass-through", children: [{ t: "leaf", img: B, mode: "multiply" }] }] },
    { name: "嵌套组", spec: [{ t: "leaf", img: A }, { t: "group", mode: "source-over", opacity: 0.8, children: [{ t: "leaf", img: B }, { t: "group", mode: "multiply", children: [{ t: "leaf", img: C }, { t: "leaf", img: D }] }] }] },
  ];

  for (const { name, spec } of scenes) {
    const backend = new GLTileBackend(glctx, 16); const comp = new GLCompositor(glctx, "f32");
    const indices: TileIndexTexture[] = [];
    let slice = 0;
    const build = (s: Spec): { gl: unknown; twoD: unknown } => {
      if (s.t === "leaf") {
        const sl = slice++; backend.uploadSlice(sl, s.img);
        const idx = idx1(glctx, sl); indices.push(idx);
        return {
          gl: { kind: "leaf", srcIndex: idx, opacity: s.opacity ?? 1, mode: s.mode ?? "source-over", clip: !!s.clip, visible: s.visible ?? true, hasContent: true },
          twoD: { isGroup: false, visible: s.visible ?? true, clippingMask: !!s.clip, opacity: s.opacity ?? 1, mode: s.mode ?? "source-over", bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, canvas: imgToCanvas(s.img, n) },
        };
      }
      const kids = s.children.map(build);
      return {
        gl: { kind: "group", children: kids.map((k) => k.gl), opacity: s.opacity ?? 1, mode: s.mode ?? "pass-through", clip: !!s.clip, visible: s.visible ?? true },
        twoD: { isGroup: true, visible: s.visible ?? true, clippingMask: !!s.clip, opacity: s.opacity ?? 1, mode: s.mode ?? "pass-through", children: kids.map((k) => k.twoD) },
      };
    };
    const built = spec.map(build);
    // golden：真 compositeLayers 渲到 256² canvas（透明底，identity 变换=doc 坐标）
    const gc = document.createElement("canvas"); gc.width = n; gc.height = n;
    const gctx = gc.getContext("2d")!; gctx.clearRect(0, 0, n, n);
    compositeLayers(gctx as unknown as CanvasRenderingContext2D, built.map((b) => b.twoD) as never, {});
    const ref = gctx.getImageData(0, 0, n, n).data;
    // GL
    const accum = comp.composite(backend.texture, built.map((b) => b.gl) as never, n, n);
    const glpx = readComposite(glctx, comp, accum, n); glctx.returnFBO(accum);
    const { md, at } = maxPremulDiff(ref, glpx, n);
    add(`group:${name} vs compositeLayers`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
    indices.forEach((i) => i.dispose());
  }
}

function run(): { ok: boolean; checks: Check[]; error: string | null } {
  const checks: Check[] = [];
  const add: Add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
  const glctx = new GLContext(canvas); const gl = glctx.gl;

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

  for (const p of ["u8", "f16", "f32"] as const) {
    if (p !== "u8" && !glctx.caps.floatColorBuffer) continue;
    try { const f = glctx.borrowFBO(64, 64, p); add(`fbo.${p}.complete`, !!f.fbo); glctx.returnFBO(f); }
    catch (e) { add(`fbo.${p}.complete`, false, String(e)); }
  }

  const backend = new GLTileBackend(glctx, 8);
  try {
    const px = new Uint8Array(TILE_BYTES);
    px[0] = 12; px[1] = 34; px[2] = 56; px[3] = 78; px[TILE_BYTES - 4] = 9; px[TILE_BYTES - 1] = 255;
    backend.uploadSlice(2, px);
    const out = backend.readSlice(2);
    const head = out[0] === 12 && out[1] === 34 && out[2] === 56 && out[3] === 78;
    const tail = out[TILE_BYTES - 4] === 9 && out[TILE_BYTES - 1] === 255;
    add("backend.upload→read round-trip", head && tail, `head=[${out[0]},${out[1]},${out[2]},${out[3]}]`);
  } catch (e) { add("backend.upload→read round-trip", false, String(e)); }

  try {
    backend.uploadSlice(3, new Uint8Array(TILE_BYTES).fill(200)); backend.clearSlice(3);
    const out = backend.readSlice(3); let z = true;
    for (let i = 0; i < TILE_BYTES; i += 997) if (out[i] !== 0) { z = false; break; }
    add("backend.clearSlice→zero", z);
  } catch (e) { add("backend.clearSlice→zero", false, String(e)); }

  try {
    const pool = new TilePool(backend); const lm = new LayerTileMap(pool, 8);
    const t = lm.tileAt(1, 1, { create: true }); if (!t) throw new Error("tileAt create null");
    const p = new Uint8Array(TILE_BYTES); p[0] = 99; p[3] = 255; backend.uploadSlice(t.slice, p);
    const back = backend.readSlice(t.slice); const rt = back[0] === 99 && back[3] === 255; const sl = t.slice;
    lm.freeTile(1, 1); const t2 = lm.tileAt(5, 5, { create: true });
    add("pool+layermap over real GPU", rt && !!t2 && t2.slice === sl, `rt=${rt}`);
  } catch (e) { add("pool+layermap over real GPU", false, String(e)); }

  try {
    const cb = new GLTileBackend(glctx, 4);
    blendParity(glctx, cb, add, "f32"); blendParity(glctx, cb, add, "f16");
    opaqueProbe(glctx, add); clipParity(glctx, add);
  } catch (e) { add("blend/clip parity", false, String(e)); }
  try { multiTileParity(glctx, add); } catch (e) { add("multitile parity", false, String(e)); }
  try { groupParity(glctx, add); } catch (e) { add("group parity", false, String(e)); }

  add("no GL error", gl.getError() === gl.NO_ERROR, `0x${gl.getError().toString(16)}`);
  return { ok: checks.every((c) => c.ok), checks, error: null };
}

declare global { interface Window { __SMOKE__?: unknown; } }
try { (window as Window).__SMOKE__ = run(); }
catch (e) { (window as Window).__SMOKE__ = { ok: false, checks: [], error: String(e) }; }
