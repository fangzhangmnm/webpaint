// TileIndexTexture —— 单层的「tile 坐标 → 池 slice」映射，做成一张 GPU 小纹理（R32F，across×down）。
// 合成 shader 按 doc 坐标算出 tile 坐标，texelFetch 这张图拿到 slice（-1=空 tile=透明），再去 array 池采像素。
// 这是「多 tile 层一 pass 合成」的关键：不用每 tile 一个 draw，整层一张全屏 pass 自己查表定位。
//
// 大小极小（2K doc = 8×8 个 float）→ 整图重传成本可忽略；commit 后单 tile 变更也整传。
// 验证：纯 gl.*，node no-op → smoke harness 多 tile 自 diff（跨 tile 内容 vs Canvas2D 整图）。

import { tilesAcross, tilesDown } from "./tile-geometry.ts";
import type { LayerTileMap } from "./tile-store.ts";
import type { GLContext } from "./gl-context.ts";

export class TileIndexTexture {
  private _gl: WebGL2RenderingContext;
  readonly tex: WebGLTexture;
  readonly across: number;
  readonly down: number;
  private _data: Float32Array;   // across×down，每格 slice 或 -1

  constructor(glctx: GLContext, docW: number, docH: number) {
    const gl = glctx.gl;
    this._gl = gl;
    this.across = tilesAcross(docW);
    this.down = tilesDown(docH);
    this._data = new Float32Array(this.across * this.down).fill(-1);
    const tex = gl.createTexture();
    if (!tex) throw new Error("CREATE_INDEX_TEX_FAILED");
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.across, this.down);
    // 只 texelFetch/NEAREST 点采（不需 float-linear 扩展）。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._upload();
  }

  // 从 LayerTileMap 全量重建（tile (tx,ty)→slice，其余 -1）。
  updateFrom(layer: LayerTileMap): void {
    this._data.fill(-1);
    layer.forEachTile((t) => { this._data[t.ty * this.across + t.tx] = t.slice; });
    this._upload();
  }

  // 置单 tile 的 slice（-1 清空）。增量更新 / 测试构造用。
  setTile(tx: number, ty: number, slice: number): void {
    this._data[ty * this.across + tx] = slice;
    this._upload();
  }

  dispose(): void { this._gl.deleteTexture(this.tex); }

  private _upload(): void {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.across, this.down, gl.RED, gl.FLOAT, this._data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
