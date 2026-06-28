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

// ---- E5) floatFor 接缝 golden：GL 浮层 pass vs 2D drawImage(float) source-over ----
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
  const tree = [{ kind: "leaf", srcIndex: lt.index, opacity: 1, mode: "source-over", clip: false, visible: true, hasContent: true, overlay: null, float: { tex: ftex, ox: fx, oy: fy, ow: fw, oh: fh } }];
  const accum = comp.composite(backend.texture, tree as never, N, N);
  const glpx = readComposite(glctx, comp, accum, N); glctx.returnFBO(accum);
  const ref = document.createElement("canvas"); ref.width = N; ref.height = N;
  const rctx = ref.getContext("2d")!;
  rctx.drawImage(baseCanvas, 0, 0); rctx.drawImage(floatCanvas, fx, fy);   // 浮层 source-over 底（α=1，忽略层 mode/opacity）
  const refData = rctx.getImageData(0, 0, N, N).data;
  const { md, at } = maxPremulDiff(refData, glpx, N);
  add("float:GL 浮层 pass vs 2D drawImage source-over", md <= 4, `maxΔ=${md} ${md > 4 ? at : ""}`);
  lt.index.dispose(); glctx.gl.deleteTexture(ftex);
}

// ---- E3) 全管线 golden：真 BrushEngine CPU 描边(getLiveOverlay) vs collectStamps→GPU 栅格 ----
//   验证「手感数学(CPU 出 stamp) + GPU 栅格」整条管线匹配**真 CPU 笔刷**（非公式再实现）。
//   两边都是 pre-opacity 的 stroke 像素（frozen+tail）；CPU overlay 直 α → 转预乘 vs GPU 预乘。
function cpuStraightToPremul(straight: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(straight.length);
  for (let i = 0; i < straight.length; i += 4) {
    const a = straight[i + 3];
    out[i] = Math.round(straight[i] * a / 255); out[i + 1] = Math.round(straight[i + 1] * a / 255);
    out[i + 2] = Math.round(straight[i + 2] * a / 255); out[i + 3] = a;
  }
  return out;
}
function brushPipeDiff(glctx: GLContext, ras: GLStampRasterizer, mode: string): { md: number; bw: number; ai: number; cpu: Uint8Array; gpu: Uint8Array } | null {
  const doc = new PaintDoc({ width: 512, height: 512 });
  const eng = new BrushEngine();
  const s = resolveBrush({ size: 36, color: "#cc4488", preset: { shape: { kind: "round", hardness: 0.35 }, compositeMode: mode, spacing: 0.08 } });
  eng.beginStroke(doc.layers[0], s, 80, 90, 1.0, "brush");
  eng.extendStroke(160, 110, 0.95); eng.extendStroke(240, 180, 0.8); eng.extendStroke(320, 150, 0.6);
  const ov = eng.getLiveOverlay();
  const cs = eng.collectStamps();
  if (!ov || !cs) return null;
  const bw = ov.bboxW, bh = ov.bboxH;
  const ovData = (ov.canvas as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, bw, bh).data;
  const cpu = cpuStraightToPremul(ovData);
  const fbo = ras.rasterize(cs.stamps, cs.shape, ov.bboxX, ov.bboxY, bw, bh);
  const gpu = readFBO(glctx, fbo.fbo, bw, bh);
  glctx.returnFBO(fbo);
  let md = 0, ai = 0;
  for (let i = 0; i < bw * bh * 4; i++) { const d = Math.abs(cpu[i] - gpu[i]); if (d > md) { md = d; ai = i - (i % 4); } }
  return { md, bw, ai, cpu, gpu };
}
function brushPipelineParity(glctx: GLContext, add: Add): void {
  const ras = new GLStampRasterizer(glctx);
  // WASH：CPU(_washMaxInto) 与 GPU 同走**解析 falloff** → 全管线对真 CPV 笔刷应紧匹配（gate）。
  const w = brushPipeDiff(glctx, ras, "wash");
  if (!w) { add("brushpipe:wash 取 overlay/stamps", false, "null"); return; }
  const wp = w.ai / 4;
  add("brushpipe:wash 真CPU笔刷 vs collectStamps→GPU", w.md <= 8, `maxΔ=${w.md} @(${wp % w.bw},${Math.floor(wp / w.bw)})`);
  // BUILDUP：CPU(_buildupOverInto) 用**缓存重采样 stamp**(baseSize 64→drawImage 缩放)，GPU 用解析 → 天然发散。
  //   非 bug（stampParity 已证 GPU buildup 对解析公式 Δ1）；GPU 与 wash 一致、更干净，但**变了旧 buildup 观感**。
  //   = 手感判断项（user 真机定）。此处只**记录**发散量、不 gate（≤120 仅防爆/退化哨兵）。
  const b = brushPipeDiff(glctx, ras, "buildup");
  if (b) add(`brushpipe:buildup 发散(CPU缓存stamp vs GPU解析,手感待定) maxΔ=${b.md}`, b.md <= 120, `cpu=[${b.cpu[b.ai]},${b.cpu[b.ai + 1]},${b.cpu[b.ai + 2]},${b.cpu[b.ai + 3]}] gpu=[${b.gpu[b.ai]},${b.gpu[b.ai + 1]},${b.gpu[b.ai + 2]},${b.gpu[b.ai + 3]}]`);
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

  const finalErr = gl.getError();   // 只读一次（getError 读后即清，二次读会误报 0）
  add("no GL error", finalErr === gl.NO_ERROR, `0x${finalErr.toString(16)}`);
  return { ok: checks.every((c) => c.ok), checks, error: null };
}

declare global { interface Window { __SMOKE__?: unknown; } }
try { (window as Window).__SMOKE__ = run(); }
catch (e) { (window as Window).__SMOKE__ = { ok: false, checks: [], error: String(e) }; }
