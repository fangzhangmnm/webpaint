// GLBoard —— board.ts 的 GL 渲染接缝（薄壳）。T6 起内部 = GlRoom（机房五件套 + 共享台面）上的
// 双 facade：RenderTree（tree composite：脏跟踪/段缓存/display 快路径）+ RasterService（一次性
// 算像素：烤定/导出/吸管/warp）。板级契约不变：markContentDirty = 内容/结构变了；pan/zoom 帧
// 自动走「只 present」快路径；context-loss 自愈。
// C1：context 创建翻壳——壳（board.ts）造好 BrowserGl2Port 递入，本类只见 Gl2Port 契约。

import type { Gl2Port } from "../common/gl2-port.ts";
import { GlRoom } from "../backend/gl/gl-room.ts";
import { RenderTree } from "../backend/gl/render-tree.ts";
import { RasterService } from "../backend/gl/raster-service.ts";
import type { FloatInput, OverlayInput, SurrogateInput } from "../backend/gl/gl-room.ts";
import type { LayerPixels } from "../backend/tiles/tile-layer.ts";
import type { DocNode, DocLeaf } from "../backend/gl/gl-doc-bridge.ts";
import type { Background, ScreenGridBg } from "../backend/gl/gl-compositor.ts";

export interface GLDoc { layers: DocNode[]; width: number; height: number; }
// board live-sync 接缝用的叶类型别名（结构上 = DocLeaf，board 传活动 Layer 进来）。
export type { DocLeaf as GLLeaf } from "../backend/gl/gl-doc-bridge.ts";

// "#rrggbb" → [r,g,b] in [0,1]（void 底色 clear 用）。失败回退浅灰。
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0.9, 0.886, 0.839];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export class GLBoard {
  private _glctx: Gl2Port;
  private _room: GlRoom;
  private _tree: RenderTree;
  private _raster: RasterService;

  constructor(glctx: Gl2Port, maxSlices: number) {
    this._glctx = glctx;
    this._room = new GlRoom(this._glctx, maxSlices);
    this._tree = new RenderTree(this._room);
    this._raster = new RasterService(this._room);
    // context-loss（Port onInvalidated 广播：结构已重建/generation 已 ++）：底层纹理/FBO 全没了
    //   → 机房+执行器全量作废，下帧从 CPU SSoT 重建（CPU 恒驻留）。
    this._glctx.onInvalidated(() => { this._tree.handleContextRestored(); });
  }

  get memory() { return this._room.memory; }
  get stats(): { passes: number; floatPasses: number } { return this._room.stats; }
  get fboPoolStats(): { count: number; bytes: number } { return this._room.fboPoolStats; }
  get frameStats() { return this._tree.frameStats; }
  markContentDirty(): void { this._tree.markDirty(); }

  // S8 brush commit：merge(base⊕stroke) 在 GPU（live 同一 shader）→ tile-diff 落盘 → GPU 收养。
  //   apply = CPU 落盘回调（Layer.applyRegionDiff）。false = GPU 无法保证完整（调用方按未提交处理）。
  commitBrushStroke(
    leafId: number, pixels: LayerPixels, ov: OverlayInput, docW: number, docH: number,
    apply: (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => { tx: number; ty: number }[],
  ): boolean {
    if (this._glctx.isLost) return false;
    return this._raster.bakeStamps(leafId, pixels, ov, docW, docH, apply);
  }

  // v0.7.25 选区笔：stamps → bbox RGBA 字节（纯光栅，不进树）。GL lost → null（调用方走 CPU disc 回退）。
  rasterizeStampsToBytes(
    stamps: Parameters<RasterService["rasterizeStampsToBytes"]>[0],
    shape: Parameters<RasterService["rasterizeStampsToBytes"]>[1],
    bx: number, by: number, bw: number, bh: number,
  ): Uint8ClampedArray | null {
    if (this._glctx.isLost) return null;
    return this._raster.rasterizeStampsToBytes(stamps, shape, bx, by, bw, bh);
  }

  // 字节合成面（v0.6.39）：merge-down/collapse/导出等字节 op 用；GL lost → null。
  //   （C1：canvas 包装面 compositeToCanvas 撤出 src/gl——屏显域 canvas 归壳，board.ts 自包字节。）
  //   surrogate/overlay（v0.9.18 timelapse 采帧 WYSIWYG，同 pickColor 待遇）：save/export 不传，语义不变。
  compositeToBytes(nodes: DocNode[], docW: number, docH: number,
                   surrogate: SurrogateInput | null = null, overlay: OverlayInput | null = null): { data: Uint8ClampedArray; w: number; h: number } | null {
    if (this._glctx.isLost) return null;
    return this._raster.compositeToBytes(nodes, docW, docH, surrogate, overlay);
  }

  // S8 吸管：一次性合成（compositeOnce，不建缓存）+ 1px readback。bg 语义同 render 的 docBg。
  pickColor(doc: GLDoc, docBg: string | null, x: number, y: number, surrogate: SurrogateInput | null = null, overlay: OverlayInput | null = null): [number, number, number, number] | null {
    if (this._glctx.isLost) return null;
    const bg: Background | undefined = docBg === "checker" ? "checker"
      : docBg ? [...hexToRgb(docBg), 1] as [number, number, number, number] : undefined;
    return this._raster.pickColor(doc.layers, doc.width, doc.height, bg, x, y, surrogate, overlay);
  }

  // 给自由变换 commit 用：warp 源 → straight RGBA **字节**（_bakeDown typed-array source-over 落层，
  //   复用 live warp；v0.6.38 去 canvas 化）。
  warpToBytes(src: Parameters<RasterService["warpToBytes"]>[0], srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) {
    return this._raster.warpToBytes(src, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  // 渲染一帧。affine6 = board _applyDocTransform 的 device-px 6 参；canvasW/H = device px。
  // liveSyncLeaf 只取 id（标 updated，像素变更由 contentVersion 快路径自己发现）。
  // gridBg 非空 = 透明显示模式（docBg 应为 null）：present 时整屏「主题底(voidColor)+点网格」，doc 真透明叠上。
  render(doc: GLDoc, affine6: number[], canvasW: number, canvasH: number, scale: number, voidColor: string, docBg: string | null, floats: FloatInput[] = [], stampOverlay: OverlayInput | null = null, liveSyncLeaf: DocLeaf | null = null, surrogate: SurrogateInput | null = null, gridBg: { dotColor: string; stepPx: number; radiusPx: number } | null = null): void {
    if (this._glctx.isLost) return;
    const bg: Background | undefined = docBg === "checker" ? "checker"
      : docBg ? [...hexToRgb(docBg), 1] as [number, number, number, number] : undefined;
    const screenGrid: ScreenGridBg | null = gridBg
      ? { bg: hexToRgb(voidColor), dot: hexToRgb(gridBg.dotColor), stepPx: gridBg.stepPx, radiusPx: gridBg.radiusPx }
      : null;
    this._tree.renderFrame(
      doc.layers, doc.width, doc.height, bg,
      affine6, canvasW, canvasH, scale, hexToRgb(voidColor),
      floats, stampOverlay, surrogate, liveSyncLeaf ? liveSyncLeaf.id : null, screenGrid,
    );
  }
}
