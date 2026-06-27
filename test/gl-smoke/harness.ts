// GL smoke harness（在真浏览器 WebGL2 里跑，由 Playwright 驱动）。
// 验 node 测不到的部分：GLContext 真能起、shader 真能编、FBO 真完整、GLTileBackend 真 GPU 上传→读回。
// 不验像素美学/手感（那是 iPad 批）；只验「GL 管线不炸、簿记在真 GPU 上 round-trip 正确」。
//
// 结果写到 window.__SMOKE__ = { ok, checks:[{name,ok,detail}], error }，run.mjs 读它断言。

import { GLContext } from "../../src/gl/gl-context.ts";
import { GLTileBackend } from "../../src/gl/tile-backend-gl.ts";
import { TilePool, LayerTileMap, TILE_BYTES } from "../../src/gl/tile-store.ts";
import { TILE_SIZE } from "../../src/gl/tile-geometry.ts";

interface Check { name: string; ok: boolean; detail: string; }

function run(): { ok: boolean; checks: Check[]; error: string | null } {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  const glctx = new GLContext(canvas);
  const gl = glctx.gl;

  // 1) caps 合理
  add("caps.maxTextureSize≥4096", glctx.caps.maxTextureSize >= 4096, `${glctx.caps.maxTextureSize}`);
  add("caps.maxArrayLayers≥256", glctx.caps.maxArrayLayers >= 256, `${glctx.caps.maxArrayLayers}`);
  add("caps.maxTextureUnits≥8", glctx.caps.maxTextureUnits >= 8, `${glctx.caps.maxTextureUnits}`);
  add("caps.floatColorBuffer", glctx.caps.floatColorBuffer, `${glctx.caps.floatColorBuffer}`);

  // 2) trivial program 编译/链接
  try {
    glctx.program("smoke",
      `#version 300 es
       layout(location=0) in vec2 a; void main(){ gl_Position=vec4(a*2.0-1.0,0,1); }`,
      `#version 300 es
       precision highp float; out vec4 o; void main(){ o=vec4(1,0,0,1); }`);
    add("program.compile+link", true);
  } catch (e) { add("program.compile+link", false, String(e)); }

  // 3) FBO 完整性（RGBA8 必过；float 若 caps 支持也要过）
  try {
    const f8 = glctx.borrowFBO(64, 64, false);
    add("fbo.rgba8.complete", !!f8.fbo);
    glctx.returnFBO(f8);
  } catch (e) { add("fbo.rgba8.complete", false, String(e)); }
  if (glctx.caps.floatColorBuffer) {
    try {
      const ff = glctx.borrowFBO(64, 64, true);
      add("fbo.rgba16f.complete", !!ff.fbo);
      glctx.returnFBO(ff);
    } catch (e) { add("fbo.rgba16f.complete", false, String(e)); }
  }

  // 4) GLTileBackend 真 GPU 上传→读回 round-trip（node 测不到的核心）
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

  // 5) clearSlice 真置零
  try {
    backend.uploadSlice(3, new Uint8Array(TILE_BYTES).fill(200));
    backend.clearSlice(3);
    const out = backend.readSlice(3);
    let allZero = true;
    for (let i = 0; i < TILE_BYTES; i += 997) if (out[i] !== 0) { allZero = false; break; }
    add("backend.clearSlice→zero", allZero, allZero ? "" : `nonzero@sample`);
  } catch (e) { add("backend.clearSlice→zero", false, String(e)); }

  // 6) TilePool + LayerTileMap over 真 backend：建/传/读/释放/复用
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

  // 7) 全程无 GL error
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
