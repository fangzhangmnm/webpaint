// GLTileBackend —— TileBackend 的真 WebGL2 adapter（TEXTURE_2D_ARRAY 池）。
// fake backend 的 GPU 对应物；TilePool 通过它把 tile 像素放进/读出 GPU。
//
// **关键内存语义（texStorage3D 预分配）**：WebGL2 的 immutable array texture 在创建时即按
//   TILE×TILE×capacity 全量分配显存——不是用多少分多少。所以：
//     committedBytes = capacity × TILE_BYTES（创建即承诺，固定）。
//   稀疏性的意义因此是：**多层共享这一个定额池**——空 tile 不占 slice，于是同样预算里能塞下
//   远多于「层数×满幅」的层（= Procreate 的 bounded-pool + 分页模型）。池满 → TileResidency 逐冷
//   tile（压缩到备份、还 slice）。capacity 该取「显存预算 / TILE_BYTES」，Stage 0 真机校准。
//   （懒增长/多 array 池避免轻文档也承诺满预算 = Stage 2/TileResidency 优化，本骨架先固定 capacity。）
//
// 验证边界：纯 gl.*，node no-op → 由 Playwright 真 Chromium WebGL2 smoke 验上传→读回 round-trip。

import { TILE_SIZE } from "./tile-geometry.ts";
import { TILE_BYTES } from "./tile-store.ts";
import type { TileBackend } from "./tile-store.ts";
import type { GLContext } from "./gl-context.ts";

export class GLTileBackend implements TileBackend {
  readonly capacity: number;
  private _gl: WebGL2RenderingContext;
  private _tex: WebGLTexture;
  private _readFbo: WebGLFramebuffer | null = null;
  private _zero: Uint8Array;   // 共享零缓冲（clearSlice 复用，免每次新建）

  constructor(glctx: GLContext, capacity: number) {
    const gl = glctx.gl;
    this._gl = gl;
    this.capacity = capacity;
    const tex = gl.createTexture();
    if (!tex) throw new Error("CREATE_ARRAY_TEX_FAILED");
    this._tex = tex;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    // immutable storage：1 mip、RGBA8、TILE×TILE×capacity。整块显存在此刻被承诺。
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TILE_SIZE, TILE_SIZE, capacity);
    // 1:1 doc 分辨率采样（视口缩放在最终 present 那步做，不在采 tile 时）→ NEAREST 精确无边渗。
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this._zero = new Uint8Array(TILE_BYTES);
  }

  // 给合成器采样用（绑这张 array texture，按 slice 索引采）。
  get texture(): WebGLTexture { return this._tex; }
  get committedBytes(): number { return this.capacity * TILE_BYTES; }

  clearSlice(slice: number): void {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._tex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slice, TILE_SIZE, TILE_SIZE, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, this._zero);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  // pixels = TILE_BYTES 的 RGBA8 直存（非预乘；预乘在合成 shader 里做）。
  uploadSlice(slice: number, pixels: Uint8Array): void {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._tex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slice, TILE_SIZE, TILE_SIZE, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  // 读回：array texture 不能直接 readPixels → 把目标 slice 挂到临时 FBO 再 readPixels。
  readSlice(slice: number): Uint8Array {
    const gl = this._gl;
    if (!this._readFbo) this._readFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this._tex, 0, slice);
    const out = new Uint8Array(TILE_BYTES);
    gl.readPixels(0, 0, TILE_SIZE, TILE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
