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
import { uploadLayerToTiles, docTreeToComp } from "../../src/gl/gl-doc-bridge.ts";
import { LayerPixels, materialize, editRegion, replaceFromCanvas } from "../../src/gl/tile-pixels.ts";
import { GLStampRasterizer } from "../../src/gl/gl-stamp.ts";
import type { Stamp } from "../../src/gl/gl-stamp.ts";
import { compositeLayers } from "../../src/layer-composite.ts";
import { BrushEngine } from "../../src/brush.ts";
import { resolveBrush } from "../../src/resolved-brush.ts";
import { PaintDoc } from "../../src/doc.ts";
import { quadWarp } from "../../src/floating-transform.ts";

// ---- CPU warp 参照（golden 基准）：v355 从 src/floating-transform 归档进 harness（运行时单一 GPU SSoT；
//   这份 CPU 逐像素逆单应性 + 采样器只在测试里当 GPU warp 的对照基准，不在产品路径）。verbatim 复刻原实现。----
type CpuMesh = { x: number; y: number }[][];
function cpuNearest(sdat: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, ddat: Uint8ClampedArray, di: number) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return;
  const p = (iy * w + ix) * 4;
  ddat[di] = sdat[p]; ddat[di + 1] = sdat[p + 1]; ddat[di + 2] = sdat[p + 2]; ddat[di + 3] = sdat[p + 3];
}
function cpuBicubic(sdat: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, ddat: Uint8ClampedArray, di: number) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const k = (t: number) => { const a = -0.5; const at = Math.abs(t); if (at < 1) return (a + 2) * at * at * at - (a + 3) * at * at + 1; if (at < 2) return a * at * at * at - 5 * a * at * at + 8 * a * at - 4 * a; return 0; };
  const kx = [k((ix - 1) - sx), k(ix - sx), k((ix + 1) - sx), k((ix + 2) - sx)];
  const ky = [k((iy - 1) - sy), k(iy - sy), k((iy + 1) - sy), k((iy + 2) - sy)];
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 4; j++) { const yy = iy - 1 + j; if (yy < 0 || yy >= h) continue;
    for (let i = 0; i < 4; i++) { const xx = ix - 1 + i; if (xx < 0 || xx >= w) continue;
      const p = (yy * w + xx) * 4, ww = kx[i] * ky[j], av = sdat[p + 3];
      r += sdat[p] * av * ww; g += sdat[p + 1] * av * ww; b += sdat[p + 2] * av * ww; a += av * ww; } }
  ddat[di + 3] = Math.max(0, Math.min(255, a));
  if (a < 1e-4) { ddat[di] = ddat[di + 1] = ddat[di + 2] = 0; return; }
  ddat[di] = Math.max(0, Math.min(255, r / a)); ddat[di + 1] = Math.max(0, Math.min(255, g / a)); ddat[di + 2] = Math.max(0, Math.min(255, b / a));
}
function cpuBilinear(sdat: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, ddat: Uint8ClampedArray, di: number) {
  const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
  if (ix < -1 || ix >= w || iy < -1 || iy >= h) return;
  const x0 = ix < 0 ? 0 : (ix >= w ? w - 1 : ix), x1 = (ix + 1) < 0 ? 0 : ((ix + 1) >= w ? w - 1 : (ix + 1));
  const y0 = iy < 0 ? 0 : (iy >= h ? h - 1 : iy), y1 = (iy + 1) < 0 ? 0 : ((iy + 1) >= h ? h - 1 : (iy + 1));
  const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const a00 = sdat[p00 + 3], a10 = sdat[p10 + 3], a01 = sdat[p01 + 3], a11 = sdat[p11 + 3];
  const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
  ddat[di + 3] = a;
  if (a < 1e-4) { ddat[di] = ddat[di + 1] = ddat[di + 2] = 0; return; }
  for (let c = 0; c < 3; c++) ddat[di + c] = (sdat[p00 + c] * a00 * w00 + sdat[p10 + c] * a10 * w10 + sdat[p01 + c] * a01 * w01 + sdat[p11 + c] * a11 * w11) / a;
}
function renderQuadPerPixel(srcImageData: ImageData, srcW: number, srcH: number, mesh: CpuMesh, sampleMode: string): { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null {
  const q = quadWarp(mesh as never);
  if (!q) return null;
  const { hinv: Hinv, minX, minY, maxX, maxY } = q;
  const dstW = maxX - minX, dstH = maxY - minY;
  const out = new ImageData(dstW, dstH), odata = out.data, sdata = srcImageData.data;
  for (let dy = 0; dy < dstH; dy++) for (let dx = 0; dx < dstW; dx++) {
    const docX = minX + dx + 0.5, docY = minY + dy + 0.5;
    const w = Hinv[6] * docX + Hinv[7] * docY + Hinv[8];
    if (Math.abs(w) < 1e-9) continue;
    const u = (Hinv[0] * docX + Hinv[1] * docY + Hinv[2]) / w, v = (Hinv[3] * docX + Hinv[4] * docY + Hinv[5]) / w;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const sx = u * srcW, sy = v * srcH, di = (dy * dstW + dx) * 4;
    if (sampleMode === "nearest") cpuNearest(sdata, srcW, srcH, sx, sy, odata, di);
    else if (sampleMode === "bicubic") cpuBicubic(sdata, srcW, srcH, sx, sy, odata, di);
    else cpuBilinear(sdata, srcW, srcH, sx, sy, odata, di);
  }
  const canvas = document.createElement("canvas"); canvas.width = dstW; canvas.height = dstH;
  canvas.getContext("2d")!.putImageData(out, 0, 0);
  return { canvas, dstX: minX, dstY: minY };
}

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
// doc 尺寸直值 RGBA8 2D 纹理（live overlay 用）。
function makeTex2D(glctx: GLContext, img: Uint8Array, n: number): WebGLTexture {
  const gl = glctx.gl; const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, n, n);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
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

// ---- live overlay 注入 vs compositeLayers overlayFor（normal + erase）----
function overlayParity(glctx: GLContext, add: Add): void {
  const n = TILE_SIZE; const backend = new GLTileBackend(glctx, 4); const comp = new GLCompositor(glctx, "f32");
  const bg = makeImg(n, (x, y) => [60, 120 + (x % 120), 60 + (y % 180), 255]);          // 底
  const layer = makeImg(n, (x, y) => [200, 60 + (x % 180), 80, 180 + ((x + y) % 76)]);   // 活动叶
  const ov = makeImg(n, (x, y) => ((x + y) % 64 < 40) ? [40 + (x % 200), 220, 60, 160 + (y % 80)] : [0, 0, 0, 0]);  // 描边（带空隙）
  backend.uploadSlice(0, bg); backend.uploadSlice(1, layer);
  const i0 = idx1(glctx, 0), i1 = idx1(glctx, 1);
  const ovTex = makeTex2D(glctx, ov, n);
  // normal(source-over) + erase + blendMode(multiply) —— 后者验 blendMode-overlay 接缝。
  for (const cse of [{ erase: false, bm: "source-over" }, { erase: true, bm: "source-over" }, { erase: false, bm: "multiply" }]) {
    const { erase, bm } = cse;
    const opacity = 0.85;
    // golden：compositeLayers，活动叶带 overlayFor（blendMode 透传）
    const A2D = { isGroup: false, visible: true, clippingMask: false, opacity: 1, mode: "source-over", bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, canvas: imgToCanvas(bg, n) };
    const L2D = { isGroup: false, visible: true, clippingMask: false, opacity: 1, mode: "source-over", bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, canvas: imgToCanvas(layer, n) };
    const ovCanvas = imgToCanvas(ov, n);
    const gc = document.createElement("canvas"); gc.width = n; gc.height = n;
    const gctx = gc.getContext("2d")!; gctx.clearRect(0, 0, n, n);
    compositeLayers(gctx as unknown as CanvasRenderingContext2D, [A2D, L2D] as never, {
      overlayFor: (node: unknown) => node === L2D ? { canvas: ovCanvas, bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, opacity, mode: erase ? "erase" : undefined, blendMode: bm } : null,
    } as never);
    const ref = gctx.getImageData(0, 0, n, n).data;
    // GL：活动叶带 overlay（blendMode）
    const active = { ...L(i1, 1, "source-over"), overlay: { tex: ovTex, opacity, erase, blendMode: bm, ox: 0, oy: 0, ow: n, oh: n } };
    glctx.gl.getError();  // 清掉之前残留
    const accum = comp.composite(backend.texture, [L(i0, 1, "source-over"), active] as never, n, n);
    const glpx = readComposite(glctx, comp, accum, n); glctx.returnFBO(accum);
    const err = glctx.gl.getError();
    const { md, at } = maxPremulDiff(ref, glpx, n);
    add(`overlay:${erase ? "erase" : bm} vs compositeLayers`, md <= 4 && err === 0, `maxΔ=${md} err=0x${err.toString(16)} ${md > 4 ? at : ""}`);
  }
  // lockAlpha：GL shader 裁 overlay 到 base.a；2D ref 预裁(dst-in 层 alpha)后 source-over → 应等价。
  {
    const opacity = 0.85;
    const A2D = { isGroup: false, visible: true, clippingMask: false, opacity: 1, mode: "source-over", bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, canvas: imgToCanvas(bg, n) };
    const L2D = { isGroup: false, visible: true, clippingMask: false, opacity: 1, mode: "source-over", bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, canvas: imgToCanvas(layer, n) };
    const clipped = document.createElement("canvas"); clipped.width = n; clipped.height = n;
    const cc = clipped.getContext("2d")!; cc.drawImage(imgToCanvas(ov, n), 0, 0);
    cc.globalCompositeOperation = "destination-in"; cc.drawImage(imgToCanvas(layer, n), 0, 0); cc.globalCompositeOperation = "source-over";
    const gc = document.createElement("canvas"); gc.width = n; gc.height = n; const gctx = gc.getContext("2d")!; gctx.clearRect(0, 0, n, n);
    compositeLayers(gctx as unknown as CanvasRenderingContext2D, [A2D, L2D] as never, {
      overlayFor: (node: unknown) => node === L2D ? { canvas: clipped, bboxX: 0, bboxY: 0, bboxW: n, bboxH: n, opacity, blendMode: "source-over" } : null,
    } as never);
    const ref = gctx.getImageData(0, 0, n, n).data;
    const active = { ...L(i1, 1, "source-over"), overlay: { tex: ovTex, opacity, erase: false, blendMode: "source-over", lockAlpha: true, selMask: null, ox: 0, oy: 0, ow: n, oh: n } };
    glctx.gl.getError();
    const accum = comp.composite(backend.texture, [L(i0, 1, "source-over"), active] as never, n, n);
    const glpx = readComposite(glctx, comp, accum, n); glctx.returnFBO(accum);
    const err = glctx.gl.getError();
    const { md, at } = maxPremulDiff(ref, glpx, n);
    add("overlay:lockAlpha GPU 裁 base.a vs 2D dst-in 层", md <= 4 && err === 0, `maxΔ=${md} err=0x${err.toString(16)} ${md > 4 ? at : ""}`);
  }
  i0.dispose(); i1.dispose(); glctx.gl.deleteTexture(ovTex);
}

// ---- E) 真桥端到端：doc 节点（bbox 裁剪 Canvas2D 层）→ uploadLayerToTiles → docTreeToComp → GL
//        vs compositeLayers（同一组 fake-Layer 同时喂两边）。验 bbox 偏移切 tile + 翻译 + 全文档合成。
function makeLayerCanvas(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const im = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fn(x, y); const i = (y * w + x) * 4;
    im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = a;
  }
  c.getContext("2d")!.putImageData(im, 0, 0);
  return c;
}
// 从一张 bbox 裁剪 canvas 建 LayerPixels（doc 区 [bboxX,bboxY]+尺寸），= 该层稀疏 tile SoT。
// golden 仍喂 .canvas（compositeLayers 读），GL 路径喂 .pixels（uploadLayerToTiles 直读）→ 双路同源。
function pixelsFromCanvas(docW: number, docH: number, bx: number, by: number, c: HTMLCanvasElement): LayerPixels {
  const lp = new LayerPixels(docW, docH);
  const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  lp.putRegion(bx, by, c.width, c.height, new Uint8ClampedArray(data));
  return lp;
}
function bridgeParity(glctx: GLContext, add: Add): void {
  const N = 512;
  const backend = new GLTileBackend(glctx, 40); const pool = new TilePool(backend); const comp = new GLCompositor(glctx, "f32");
  // fake-Layer：bbox 裁剪、含偏移层；canvas=compositeLayers golden 输入，pixels=GL 直读 SoT（同源）。
  const cA = makeLayerCanvas(N, N, (x, y) => [60, 120 + (x % 120), 60 + (y % 160), 255]);
  const cB = makeLayerCanvas(300, 260, (x, y) => [220, 80 + (x % 150), 60, 200]);
  const cC = makeLayerCanvas(260, 220, (x, y) => [60, 200, 200, (x + y < 200) ? 255 : 90]);
  const A = { isGroup: false, id: 1, opacity: 1, mode: "source-over", clippingMask: false, visible: true, bboxX: 0, bboxY: 0, bboxW: N, bboxH: N, canvas: cA, pixels: pixelsFromCanvas(N, N, 0, 0, cA) };
  const B = { isGroup: false, id: 2, opacity: 1, mode: "source-over", clippingMask: false, visible: true, bboxX: 100, bboxY: 80, bboxW: 300, bboxH: 260, canvas: cB, pixels: pixelsFromCanvas(N, N, 100, 80, cB) };
  const C = { isGroup: false, id: 3, opacity: 1, mode: "source-over", clippingMask: true, visible: true, bboxX: 120, bboxY: 100, bboxW: 260, bboxH: 220, canvas: cC, pixels: pixelsFromCanvas(N, N, 120, 100, cC) };
  const grp = { isGroup: true, id: 4, opacity: 0.85, mode: "source-over", clippingMask: false, visible: true, children: [B, C] };
  const nodes = [A, grp];

  const res = new Map<number, ReturnType<typeof uploadLayerToTiles>>();
  for (const leaf of [A, B, C]) res.set(leaf.id, uploadLayerToTiles(glctx, backend, pool, leaf, N, N));

  const gc = document.createElement("canvas"); gc.width = N; gc.height = N;
  const gctx = gc.getContext("2d")!; gctx.clearRect(0, 0, N, N);
  compositeLayers(gctx as unknown as CanvasRenderingContext2D, nodes as never, {});
  const ref = gctx.getImageData(0, 0, N, N).data;

  const tree = docTreeToComp(nodes as never, (leaf) => { const r = res.get((leaf as { id: number }).id)!; return { index: r.index, hasContent: r.tileMap.tileCount > 0 }; });
  const accum = comp.composite(backend.texture, tree, N, N);
  const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
  const { md, at } = maxPremulDiff(ref, glpx, N);
  add("bridge:doc→tiles→GL full-doc vs compositeLayers", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  res.forEach((r) => r.index.dispose());
}

// LayerPixels Canvas2D facade golden：editRegion 画 → 经 tile → materialize，对比直接 Canvas2D 参考。
function tilePixelsParity(add: Add): void {
  const N = 512;
  const draw = (ctx: CanvasRenderingContext2D) => {
    const g = ctx.createLinearGradient(0, 0, N, N);
    g.addColorStop(0, "rgba(255,40,40,1)"); g.addColorStop(1, "rgba(40,40,255,1)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
    ctx.fillStyle = "rgba(40,220,60,1)"; ctx.fillRect(100, 120, 200, 180);   // 跨 tile 的实色块
    ctx.fillStyle = "rgba(240,220,40,0.6)"; ctx.fillRect(260, 60, 150, 300); // 半透明跨 tile
  };
  // LayerPixels 路径：editRegion 画满 → materialize（画满 → bounds=全 doc）
  const lp = new LayerPixels(N, N);
  editRegion(lp, 0, 0, N, N, (ctx) => draw(ctx));
  const mat = materialize(lp);
  if (!mat) { add("tilepixels:facade round-trip", false, "materialize null"); return; }
  const mc = document.createElement("canvas"); mc.width = N; mc.height = N;
  mc.getContext("2d")!.drawImage(mat.canvas as CanvasImageSource, mat.ox, mat.oy);
  const got = mc.getContext("2d")!.getImageData(0, 0, N, N).data;
  // 参考：直接 Canvas2D
  const ref = document.createElement("canvas"); ref.width = N; ref.height = N;
  const rctx = ref.getContext("2d")!; draw(rctx);
  const refData = rctx.getImageData(0, 0, N, N).data;
  const { md } = maxPremulDiff(refData, new Uint8Array(got.buffer), N);
  add("tilepixels:editRegion→tile→materialize vs Canvas2D", md <= 3, `maxΔ=${md}`);

  // replaceFromCanvas round-trip：整张换进去再 materialize 对比
  const lp2 = new LayerPixels(N, N);
  replaceFromCanvas(lp2, ref as CanvasImageSource, 0, 0, N, N);
  const mat2 = materialize(lp2);
  const mc2 = document.createElement("canvas"); mc2.width = N; mc2.height = N;
  if (mat2) mc2.getContext("2d")!.drawImage(mat2.canvas as CanvasImageSource, mat2.ox, mat2.oy);
  const got2 = mc2.getContext("2d")!.getImageData(0, 0, N, N).data;
  const { md: md2 } = maxPremulDiff(refData, new Uint8Array(got2.buffer), N);
  add("tilepixels:replaceFromCanvas vs Canvas2D", md2 <= 3, `maxΔ=${md2}`);
}

// ---- E2) GL stamp 栅格器 golden：GPU 栅格 stamp 列表 vs CPU 同公式参考（falloff+wash/buildup 累积）----
//   参考 = brush.ts 提取的公式（_getStamp:221 / _washMaxInto:867 / _buildupOverInto）的独立 CPU 实现。
//   两边都算**预乘 RGBA**，直接比预乘字节（我们的 GPU 输出本就是预乘）。
function shapeAlpha(dist: number, radius: number, hardness: number): number {
  const h = Math.max(0, Math.min(0.999, hardness));
  const innerR = h * radius, decayLen = radius - innerR;
  if (dist >= radius) return 0;
  if (decayLen <= 0 || dist <= innerR) return 1;
  const u = (dist - innerR) / decayLen; return 1 - u * u * (3 - 2 * u);
}
// 椭圆逆变换后的 dist（匹配 _washMaxInto:854-856；aspect=1/rot=0 → 圆）。
function ellipDist(dx: number, dy: number, aspect: number, rotation: number): number {
  const c = Math.cos(rotation), s = Math.sin(rotation), ia = 1 / Math.max(0.01, aspect);
  const dxR = c * dx + s * dy, dyR = (-s * dx + c * dy) * ia;
  return Math.sqrt(dxR * dxR + dyR * dyR);
}
// CPU 参考 → 预乘字节（top-down，row0=doc y=0）。
function cpuStampRef(n: number, stamps: Stamp[], color: [number, number, number], hardness: number, buildup: boolean, aspect = 1, rotation = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * n * 4);
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    const i = (py * n + px) * 4;
    if (buildup) {
      let ar = 0, ag = 0, ab = 0, aa = 0;   // 预乘累加器（0..1）
      for (const s of stamps) {
        const sa = s.alpha * shapeAlpha(ellipDist(px + 0.5 - s.x, py + 0.5 - s.y, aspect, rotation), s.size / 2, hardness);
        if (sa <= 0) continue;
        ar = color[0] * sa + ar * (1 - sa); ag = color[1] * sa + ag * (1 - sa);
        ab = color[2] * sa + ab * (1 - sa); aa = sa + aa * (1 - sa);
      }
      out[i] = Math.round(ar * 255); out[i + 1] = Math.round(ag * 255); out[i + 2] = Math.round(ab * 255); out[i + 3] = Math.round(aa * 255);
    } else {
      let a = 0;
      for (const s of stamps) {
        a = Math.max(a, s.alpha * shapeAlpha(ellipDist(px + 0.5 - s.x, py + 0.5 - s.y, aspect, rotation), s.size / 2, hardness));
      }
      out[i] = Math.round(color[0] * a * 255); out[i + 1] = Math.round(color[1] * a * 255); out[i + 2] = Math.round(color[2] * a * 255); out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}
// 读 FBO 预乘字节。栅格器顶点把 doc y=0 映到 NDC y=-1 → readback row0 = doc y=0，与 CPU 参考同向，无需翻 Y。
function readFBO(glctx: GLContext, fbo: WebGLFramebuffer, w: number, h: number = w): Uint8Array {
  const gl = glctx.gl;
  const raw = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return raw;
}
function maxByteDiff(ref: Uint8ClampedArray, gl: Uint8Array, n: number): { md: number; at: string } {
  let md = 0, ai = 0;
  for (let i = 0; i < n * n * 4; i++) { const d = Math.abs(ref[i] - gl[i]); if (d > md) { md = d; ai = i - (i % 4); } }
  const p = ai / 4; return { md, at: `@(${p % n},${Math.floor(p / n)}) ref=[${ref[ai]},${ref[ai + 1]},${ref[ai + 2]},${ref[ai + 3]}] gl=[${gl[ai]},${gl[ai + 1]},${gl[ai + 2]},${gl[ai + 3]}]` };
}
function stampParity(glctx: GLContext, add: Add): void {
  const N = 128;
  const ras = new GLStampRasterizer(glctx);
  const color: [number, number, number] = [0.2, 0.6, 0.9];
  const stamps: Stamp[] = [
    { x: 40, y: 40, size: 50, alpha: 0.6 },
    { x: 70, y: 55, size: 40, alpha: 0.5 },
    { x: 55, y: 80, size: 60, alpha: 0.7 },
  ];
  for (const buildup of [false, true]) {
    const hardness = 0.3;
    const fbo = ras.rasterize(stamps, { hardness, color, buildup }, 0, 0, N, N);
    const glpx = readFBO(glctx, fbo.fbo, N);
    glctx.returnFBO(fbo);
    const ref = cpuStampRef(N, stamps, color, hardness, buildup);
    const { md, at } = maxByteDiff(ref, glpx, N);
    add(`stamp:${buildup ? "buildup" : "wash"} GPU vs CPU 公式`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
  // 椭圆（aspect≠1 + 旋转）：wash + buildup 各一。
  const aspect = 2.2, rotation = 0.6;
  for (const buildup of [false, true]) {
    const hardness = 0.4;
    const fbo = ras.rasterize(stamps, { hardness, color, buildup, aspect, rotation }, 0, 0, N, N);
    const glpx = readFBO(glctx, fbo.fbo, N);
    glctx.returnFBO(fbo);
    const ref = cpuStampRef(N, stamps, color, hardness, buildup, aspect, rotation);
    const { md, at } = maxByteDiff(ref, glpx, N);
    add(`stamp:${buildup ? "buildup" : "wash"} 椭圆 GPU vs CPU 公式`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
}

// ---- E4) bg 接缝 golden：GL 棋盘背景 vs 2D 棋盘 + compositeLayers ----
function drawCheckerRef(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gray = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 >= 1;
    const v = gray ? 200 : 255;
    ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, y, 1, 1);
  }
}
function checkerParity(glctx: GLContext, add: Add): void {
  const N = 192;
  const backend = new GLTileBackend(glctx, 16); const pool = new TilePool(backend); const comp = new GLCompositor(glctx, "f32");
  // 半透明层（部分覆盖）→ 透明处应显棋盘
  const layerCanvas = makeLayerCanvas(N, N, (x, y) => (x > 48 && x < 144 && y > 48 && y < 144) ? [200, 40, 40, 128] : [0, 0, 0, 0]);
  const lt = uploadLayerToTiles(glctx, backend, pool, { pixels: pixelsFromCanvas(N, N, 0, 0, layerCanvas) }, N, N);
  const tree = [{ kind: "leaf", srcIndex: lt.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: lt.tileMap.tileCount > 0, overlay: null }];
  const accum = comp.composite(backend.texture, tree as never, N, N, "checker");
  const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
  const ref = document.createElement("canvas"); ref.width = N; ref.height = N;
  const rctx = ref.getContext("2d")!;
  drawCheckerRef(rctx, N, N); rctx.drawImage(layerCanvas, 0, 0);   // 层 source-over 棋盘
  const refData = rctx.getImageData(0, 0, N, N).data;
  const { md, at } = maxPremulDiff(refData, glpx, N);
  add("checker:GL 棋盘背景 vs 2D 棋盘+层", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  lt.index.dispose();
}

// ---- E5) floatFor 接缝 golden：GPU warp pass vs 2D（合成语义 + warp 逐位对拍 CPU renderQuadPerPixel）----
// 轴对齐矩形 [x0,y0,w,h] 的逆单应性（row-major，doc→源单位方格）：身份 warp（仅平移缩放）= 把源 1:1 放到 (x0,y0)。
function rectHinv(x0: number, y0: number, w: number, h: number): number[] {
  return [1 / w, 0, -x0 / w, 0, 1 / h, -y0 / h, 0, 0, 1];
}
function texFromCanvas(glctx: GLContext, c: HTMLCanvasElement): WebGLTexture {
  const gl = glctx.gl;
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c as unknown as TexImageSource);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}
function floatParity(glctx: GLContext, add: Add): void {
  const N = 192;
  const backend = new GLTileBackend(glctx, 16); const pool = new TilePool(backend); const comp = new GLCompositor(glctx, "f32");
  const baseCanvas = makeLayerCanvas(N, N, () => [40, 80, 160, 255]);   // 不透明底
  const lt = uploadLayerToTiles(glctx, backend, pool, { pixels: pixelsFromCanvas(N, N, 0, 0, baseCanvas) }, N, N);
  const fw = 80, fh = 70, fx = 50, fy = 40;
  const floatCanvas = makeLayerCanvas(fw, fh, (x, y) => [220, 60, 60, (x + y) % 200 + 40]);   // 半透明渐变
  const ftex = texFromCanvas(glctx, floatCanvas);
  const tree = [{ kind: "leaf", srcIndex: lt.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: true, overlay: null, float: { tex: ftex, srcW: fw, srcH: fh, hinv: rectHinv(fx, fy, fw, fh), mode: 0 } }];
  const accum = comp.composite(backend.texture, tree as never, N, N);
  const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
  const ref = document.createElement("canvas"); ref.width = N; ref.height = N;
  const rctx = ref.getContext("2d")!;
  rctx.drawImage(baseCanvas, 0, 0); rctx.drawImage(floatCanvas, fx, fy);   // 身份 warp(nearest) → 等价 drawImage 放 (fx,fy)
  const refData = rctx.getImageData(0, 0, N, N).data;
  const { md, at } = maxPremulDiff(refData, glpx, N);
  add("float:GPU warp pass(身份) vs 2D drawImage source-over", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  lt.index.dispose(); glctx.gl.deleteTexture(ftex);

  // clip 层空基底 + float（变换图层组时 clip 层基底被提空）→ 层不渲染但 float 仍显（修「变换组 clip 消失」）。
  const eb = uploadLayerToTiles(glctx, backend, pool, { pixels: pixelsFromCanvas(N, N, 0, 0, makeLayerCanvas(N, N, () => [0, 0, 0, 0])) }, N, N);
  const fc2 = makeLayerCanvas(70, 60, () => [80, 200, 120, 200]); const ftex2 = texFromCanvas(glctx, fc2);
  const tree2 = [
    { kind: "leaf", srcIndex: eb.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: false, overlay: null, float: null },
    { kind: "leaf", srcIndex: eb.index, opacity: 1, mode: "source-over", clip: true, visible: true, hasContent: false, overlay: null, float: { tex: ftex2, srcW: 70, srcH: 60, hinv: rectHinv(40, 35, 70, 60), mode: 0 } },
  ];
  const acc2 = comp.composite(backend.texture, tree2 as never, N, N);
  const glpx2 = readComposite(glctx, comp, acc2, N); glctx.returnFBO(acc2);
  const ref2 = document.createElement("canvas"); ref2.width = N; ref2.height = N;
  const rctx2 = ref2.getContext("2d")!; rctx2.clearRect(0, 0, N, N); rctx2.drawImage(fc2, 40, 35);   // clip 层空基底=不显，仅 float
  const d2 = maxPremulDiff(rctx2.getImageData(0, 0, N, N).data, glpx2, N);
  add("float:clip 层空基底 → float 仍显（修变换组 clip 消失）", d2.md <= 4, `maxΔ=${d2.md} ${d2.md > 4 ? d2.at : ""}`);
  eb.index.dispose(); glctx.gl.deleteTexture(ftex2);
}

// ---- E5b) GPU warp vs CPU renderQuadPerPixel 逐位 golden（扭曲 quad，bilinear + bicubic）----
//   核心证据：WARP_FRAG 的逆单应性 gather + 手写 Catmull-Rom 采样器逐位复刻 CPU。源带 alpha 变化（测 premult）。
function warpParity(glctx: GLContext, add: Add): void {
  const N = 192;
  const backend = new GLTileBackend(glctx, 16); const pool = new TilePool(backend); const comp = new GLCompositor(glctx, "f32");
  const baseCanvas = makeLayerCanvas(N, N, () => [30, 30, 30, 255]);   // 不透明底（warp source-over 其上）
  const lt = uploadLayerToTiles(glctx, backend, pool, { pixels: pixelsFromCanvas(N, N, 0, 0, baseCanvas) }, N, N);
  const sw = 64, sh = 48;
  const srcCanvas = makeLayerCanvas(sw, sh, (x, y) => {
    const cell = (((x >> 3) + (y >> 3)) & 1) === 1;       // 8px 棋盘色
    const a = 60 + ((x * 3 + y * 5) % 196);               // alpha 变化
    return cell ? [230, 80, 40, a] : [40, 120, 230, a];
  });
  const srcImg = srcCanvas.getContext("2d")!.getImageData(0, 0, sw, sh);
  const stex = texFromCanvas(glctx, srcCanvas);
  const mesh = [[{ x: 30, y: 40 }, { x: 150, y: 25 }], [{ x: 50, y: 150 }, { x: 170, y: 130 }]];   // 透视扭曲 quad
  const q = quadWarp(mesh as never);
  for (const [name, mode, sm] of [["bilinear", 1, "bilinear"], ["bicubic", 2, "bicubic"]] as const) {
    if (!q) { add(`warp:${name} 取 quadWarp`, false, "null"); continue; }
    const tree = [{ kind: "leaf", srcIndex: lt.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: true, overlay: null, float: { tex: stex, srcW: sw, srcH: sh, hinv: q.hinv, mode } }];
    const accum = comp.composite(backend.texture, tree as never, N, N);
    const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
    const rr = renderQuadPerPixel(srcImg, sw, sh, mesh as never, sm);   // CPU 参照（straight）
    const ref = document.createElement("canvas"); ref.width = N; ref.height = N;
    const rctx = ref.getContext("2d")!;
    rctx.drawImage(baseCanvas, 0, 0);
    if (rr) rctx.drawImage(rr.canvas as CanvasImageSource, rr.dstX, rr.dstY);   // warp source-over 底
    const { md, at } = maxPremulDiff(rctx.getImageData(0, 0, N, N).data, glpx, N);
    add(`warp:${name} 扭曲quad GPU vs CPU renderQuadPerPixel`, md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
  // commit 烤定路径：comp.warpToCanvas（straight，无合成）vs CPU renderQuadPerPixel（straight），同 bbox 逐位。
  if (q) {
    const bake = comp.warpToCanvas(srcCanvas as unknown as TexImageSource, sw, sh, q.hinv, 2, q.minX, q.minY, q.maxX - q.minX, q.maxY - q.minY);
    const cpu = renderQuadPerPixel(srcImg, sw, sh, mesh as never, "bicubic");
    const gpC = document.createElement("canvas"); gpC.width = N; gpC.height = N; const gpx2 = gpC.getContext("2d")!;
    if (bake) gpx2.drawImage(bake.canvas, bake.dstX, bake.dstY);
    const cpC = document.createElement("canvas"); cpC.width = N; cpC.height = N; const cpx2 = cpC.getContext("2d")!;
    if (cpu) cpx2.drawImage(cpu.canvas as CanvasImageSource, cpu.dstX, cpu.dstY);
    const gb = new Uint8Array(gpx2.getImageData(0, 0, N, N).data.buffer);
    const { md, at } = maxPremulDiff(cpx2.getImageData(0, 0, N, N).data, gb, N);
    add("warpbake:commit GPU warpToCanvas vs CPU renderQuadPerPixel", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  }
  lt.index.dispose(); glctx.gl.deleteTexture(stex);
}

// ---- E5c) 组变换 clip 浮层 golden：clip 浮层裁到基底浮层 warp 后 alpha（in-shader gather）vs CPU ----
//   基底源 alpha=蒙版形状（左实右透），clip 源全不透明 → clip 应只显在基底实处。两者同 mesh warp。
function warpClipParity(glctx: GLContext, add: Add): void {
  const N = 192;
  const backend = new GLTileBackend(glctx, 16); const pool = new TilePool(backend); const comp = new GLCompositor(glctx, "f32");
  const bgCanvas = makeLayerCanvas(N, N, () => [30, 30, 30, 255]);
  const bg = uploadLayerToTiles(glctx, backend, pool, { pixels: pixelsFromCanvas(N, N, 0, 0, bgCanvas) }, N, N);
  const empty = uploadLayerToTiles(glctx, backend, pool, { pixels: pixelsFromCanvas(N, N, 0, 0, makeLayerCanvas(N, N, () => [0, 0, 0, 0])) }, N, N);
  const sw = 64, sh = 48;
  const baseSrc = makeLayerCanvas(sw, sh, (x) => x < sw / 2 ? [40, 120, 230, 255] : [40, 120, 230, 0]);   // 蒙版：左实右透
  const clipSrc = makeLayerCanvas(sw, sh, () => [230, 80, 40, 255]);                                       // clip 内容：全不透明红
  const baseImg = baseSrc.getContext("2d")!.getImageData(0, 0, sw, sh);
  const clipImg = clipSrc.getContext("2d")!.getImageData(0, 0, sw, sh);
  const baseTex = texFromCanvas(glctx, baseSrc), clipTex = texFromCanvas(glctx, clipSrc);
  const mesh = [[{ x: 30, y: 40 }, { x: 150, y: 25 }], [{ x: 50, y: 150 }, { x: 170, y: 130 }]];
  const q = quadWarp(mesh as never);
  if (!q) { add("warpclip 取 quadWarp", false, "null"); return; }
  const baseFD = { tex: baseTex, srcW: sw, srcH: sh, hinv: q.hinv, mode: 2 };
  const clipFD = { tex: clipTex, srcW: sw, srcH: sh, hinv: q.hinv, mode: 2 };
  // 树：bg(底) + 基底叶(空 tile + base float) + clip 叶(空 tile, clip=true, clip float)
  const tree = [
    { kind: "leaf", srcIndex: bg.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: true, overlay: null, float: null },
    { kind: "leaf", srcIndex: empty.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: false, overlay: null, float: baseFD },
    { kind: "leaf", srcIndex: empty.index, opacity: 1, mode: "source-over", clip: true, visible: true, hasContent: false, overlay: null, float: clipFD },
  ];
  const accum = comp.composite(backend.texture, tree as never, N, N);
  const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
  // CPU 参照：base/clip 各 warp（同 mesh → 同 dst），clip 用 base alpha destination-in，再依次 source-over 底。
  const bw = renderQuadPerPixel(baseImg, sw, sh, mesh as never, "bicubic");
  const cw = renderQuadPerPixel(clipImg, sw, sh, mesh as never, "bicubic");
  const ref = document.createElement("canvas"); ref.width = N; ref.height = N; const rctx = ref.getContext("2d")!;
  rctx.drawImage(bgCanvas, 0, 0);
  if (bw) rctx.drawImage(bw.canvas as CanvasImageSource, bw.dstX, bw.dstY);   // 基底浮层
  if (cw && bw) {
    const cl = document.createElement("canvas"); cl.width = cw.canvas.width; cl.height = cw.canvas.height;
    const cc = cl.getContext("2d")!;
    cc.drawImage(cw.canvas as CanvasImageSource, 0, 0);
    cc.globalCompositeOperation = "destination-in";
    cc.drawImage(bw.canvas as CanvasImageSource, bw.dstX - cw.dstX, bw.dstY - cw.dstY);   // base alpha 蒙版（同 mesh 一般同偏移）
    rctx.drawImage(cl, cw.dstX, cw.dstY);
  }
  const { md, at } = maxPremulDiff(rctx.getImageData(0, 0, N, N).data, glpx, N);
  add("warpclip:组变换 clip 浮层裁基底 GPU vs CPU", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  bg.index.dispose(); empty.index.dispose(); glctx.gl.deleteTexture(baseTex); glctx.gl.deleteTexture(clipTex);
}

// ---- E3) 全管线 golden：真 BrushEngine 描边 → collectStamps → GPU 栅格 vs 解析公式参照 ----
//   验证「手感数学(CPU 出 stamp 列表) + GPU 栅格」整条管线：collectStamps 的 stamp（_walkStamps 间距 +
//   _stampParams 压感/taper）经 GPU 栅格，== 同 stamp 列表的解析 falloff（wash:max / buildup:over）。
//   v351：旧 CPU overlay/buffer 路径已归档（→ ARCHIVE），参照改由解析公式重算同一 stamp 列表（doc 坐标偏移），
//   不再读 getLiveOverlay。wash + buildup 两侧现都解析 → 都是真 gate（旧 buildup 缓存重采样发散已随 CPU 路径消失）。
function brushPipeDiff(glctx: GLContext, ras: GLStampRasterizer, mode: string): { md: number; bw: number; ai: number } | null {
  const doc = new PaintDoc({ width: 512, height: 512 });
  const eng = new BrushEngine();
  const s = resolveBrush({ size: 36, color: "#cc4488", preset: { shape: { kind: "round", hardness: 0.35 }, compositeMode: mode, spacing: 0.08 } });
  eng.beginStroke(doc.layers[0], s, 80, 90, 1.0, "brush");
  eng.extendStroke(160, 110, 0.95); eng.extendStroke(240, 180, 0.8); eng.extendStroke(320, 150, 0.6);
  const cs = eng.collectStamps();
  if (!cs || !cs.stamps.length) return null;
  const bw = cs.bw, bh = cs.bh, buildup = cs.shape.buildup;
  const color = cs.shape.color, hardness = cs.shape.hardness;
  const aspect = cs.shape.aspect ?? 1, rotation = cs.shape.rotation ?? 0;
  // CPU 参照（预乘）：把 stamps 按解析 falloff 栅格进 bbox（同 cpuStampRef，矩形 + doc 坐标偏移 cs.bx/by）。
  const cpu = new Uint8ClampedArray(bw * bh * 4);
  for (let py = 0; py < bh; py++) for (let px = 0; px < bw; px++) {
    const i = (py * bw + px) * 4;
    const dx0 = px + 0.5 + cs.bx, dy0 = py + 0.5 + cs.by;   // doc 坐标（栅格器同映射）
    if (buildup) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (const st of cs.stamps) {
        const sa = st.alpha * shapeAlpha(ellipDist(dx0 - st.x, dy0 - st.y, aspect, rotation), st.size / 2, hardness);
        if (sa <= 0) continue;
        ar = color[0] * sa + ar * (1 - sa); ag = color[1] * sa + ag * (1 - sa);
        ab = color[2] * sa + ab * (1 - sa); aa = sa + aa * (1 - sa);
      }
      cpu[i] = Math.round(ar * 255); cpu[i + 1] = Math.round(ag * 255); cpu[i + 2] = Math.round(ab * 255); cpu[i + 3] = Math.round(aa * 255);
    } else {
      let a = 0;
      for (const st of cs.stamps) a = Math.max(a, st.alpha * shapeAlpha(ellipDist(dx0 - st.x, dy0 - st.y, aspect, rotation), st.size / 2, hardness));
      cpu[i] = Math.round(color[0] * a * 255); cpu[i + 1] = Math.round(color[1] * a * 255); cpu[i + 2] = Math.round(color[2] * a * 255); cpu[i + 3] = Math.round(a * 255);
    }
  }
  const fbo = ras.rasterize(cs.stamps, cs.shape, cs.bx, cs.by, bw, bh);
  const gpu = readFBO(glctx, fbo.fbo, bw, bh);
  glctx.returnFBO(fbo);
  let md = 0, ai = 0;
  for (let i = 0; i < bw * bh * 4; i++) { const d = Math.abs(cpu[i] - gpu[i]); if (d > md) { md = d; ai = i - (i % 4); } }
  return { md, bw, ai };
}
function brushPipelineParity(glctx: GLContext, add: Add): void {
  const ras = new GLStampRasterizer(glctx);
  for (const mode of ["wash", "buildup"]) {
    const r = brushPipeDiff(glctx, ras, mode);
    if (!r) { add(`brushpipe:${mode} 取 stamps`, false, "null"); continue; }
    const p = r.ai / 4;
    add(`brushpipe:${mode} 真笔 collectStamps→GPU vs 解析公式`, r.md <= 4, `maxΔ=${r.md} @(${p % r.bw},${Math.floor(p / r.bw)})`);
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
  try { overlayParity(glctx, add); } catch (e) { add("overlay parity", false, String(e)); }
  try { bridgeParity(glctx, add); } catch (e) { add("bridge parity", false, String(e)); }
  try { tilePixelsParity(add); } catch (e) { add("tilepixels parity", false, String(e)); }
  try { stampParity(glctx, add); } catch (e) { add("stamp parity", false, String(e)); }
  try { brushPipelineParity(glctx, add); } catch (e) { add("brushpipe parity", false, String(e)); }
  try { checkerParity(glctx, add); } catch (e) { add("checker parity", false, String(e)); }
  try { floatParity(glctx, add); } catch (e) { add("float parity", false, String(e)); }
  try { warpParity(glctx, add); } catch (e) { add("warp parity", false, String(e)); }
  try { warpClipParity(glctx, add); } catch (e) { add("warpclip parity", false, String(e)); }

  const finalErr = gl.getError();   // 只读一次（getError 读后即清，二次读会误报 0）
  add("no GL error", finalErr === gl.NO_ERROR, `0x${finalErr.toString(16)}`);
  return { ok: checks.every((c) => c.ok), checks, error: null };
}

declare global { interface Window { __SMOKE__?: unknown; } }
try { (window as Window).__SMOKE__ = run(); }
catch (e) { (window as Window).__SMOKE__ = { ok: false, checks: [], error: String(e) }; }
