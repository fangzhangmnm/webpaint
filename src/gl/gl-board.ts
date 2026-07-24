// GLBoard —— board.ts 的 GL 渲染接缝（薄壳）。S7 起内部 = RenderTreeGL（render-plan 执行器）：
//   脏跟踪/缓存/重合成决策全部下沉到执行器（plan 签名 + display 缓存 + 段缓存）；本类只管
//   canvas/context 生命周期 + 输入翻译。板级契约不变：markContentDirty = 内容/结构变了；
//   pan/zoom 帧自动走「只 present」快路径；context-loss 自愈。
// 旧 GLDocRenderer 的 livePreview/forceSync 门控在此消亡：sync 已增量化（tile 身份去重 +
//   contentVersion 快路径），每帧对 plan 的 live 叶做 sync 即可——lift 挖洞、liquify 逐帧改层
//   这些「旧门控的例外」现在都是自然路径（版本变了就重传变更 tile）。参数保留（兼容 board 调用）。

import { GLContext } from "./gl-context.ts";
import { RenderTreeGL } from "./render-tree-gl.ts";
import type { FloatInput, OverlayInput, SurrogateInput } from "./render-tree-gl.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import type { Background } from "./gl-compositor.ts";

export interface GLDoc { layers: DocNode[]; width: number; height: number; }
// board live-sync 接缝用的叶类型别名（结构上 = DocLeaf，board 传活动 Layer 进来）。
export type { DocLeaf as GLLeaf } from "./gl-doc-bridge.ts";

// "#rrggbb" → [r,g,b] in [0,1]（void 底色 clear 用）。失败回退浅灰。
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0.9, 0.886, 0.839];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export class GLBoard {
  readonly canvas: HTMLCanvasElement;
  private _glctx: GLContext;
  private _tree: RenderTreeGL;

  constructor(canvas: HTMLCanvasElement, maxSlices: number) {
    this.canvas = canvas;
    this._glctx = new GLContext(canvas);
    this._tree = new RenderTreeGL(this._glctx, maxSlices);
    // context-loss：底层纹理/FBO 全没了 → 执行器全量作废，下帧从 CPU SSoT 重建（CPU 恒驻留）。
    this._glctx.onRestored = () => { this._tree.handleContextRestored(); };
  }

  get memory() { return this._tree.memory; }
  get stats(): { passes: number; floatPasses: number } { return this._tree.stats; }
  get fboPoolStats(): { count: number; bytes: number } { return this._tree.fboPoolStats; }
  get frameStats() { return this._tree.frameStats; }
  markContentDirty(): void { this._tree.markDirty(); }

  // S8 brush commit：merge(base⊕stroke) 在 GPU（live 同一 shader）→ tile-diff 落盘 → GPU 收养。
  //   apply = CPU 落盘回调（Layer.applyRegionDiff）。false = GPU 无法保证完整（调用方按未提交处理）。
  commitBrushStroke(
    leafId: number, pixels: LayerPixels, ov: OverlayInput, docW: number, docH: number,
    apply: (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => { tx: number; ty: number }[],
  ): boolean {
    if (this._glctx.isLost) return false;
    return this._tree.commitBrushStroke(leafId, pixels, ov, docW, docH, apply);
  }

  // S9 导出/缩略图合成面：一次性合成 → canvas（透明底）。GL lost → null（调用方兜）。
  compositeToCanvas(nodes: DocNode[], docW: number, docH: number): HTMLCanvasElement | null {
    if (this._glctx.isLost) return null;
    return this._tree.compositeToCanvas(nodes, docW, docH);
  }

  // S8 吸管：一次性合成（compositeOnce，不建缓存）+ 1px readback。bg 语义同 render 的 docBg。
  pickColor(doc: GLDoc, docBg: string | null, x: number, y: number, surrogate: SurrogateInput | null = null, overlay: OverlayInput | null = null): [number, number, number, number] | null {
    if (this._glctx.isLost) return null;
    const bg: Background | undefined = docBg === "checker" ? "checker"
      : docBg ? [...hexToRgb(docBg), 1] as [number, number, number, number] : undefined;
    return this._tree.pickColor(doc.layers, doc.width, doc.height, bg, x, y, surrogate, overlay);
  }

  // 给自由变换 commit 用：warp 源 → straight RGBA canvas（_bakeDown 走 readback→editRegion，复用 live warp）。
  warpToCanvas(srcCanvas: TexImageSource, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) {
    return this._tree.warpToCanvas(srcCanvas, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  // 渲染一帧。affine6 = board _applyDocTransform 的 device-px 6 参；canvasW/H = device px。
  // liveSyncLeaf 只取 id（标 updated，像素变更由 contentVersion 快路径自己发现）。
  //   （S8e：旧 livePreview/forceSync 门控参数已拆——执行器增量 sync 后它们只剩历史意义。）
  render(doc: GLDoc, affine6: number[], canvasW: number, canvasH: number, scale: number, voidColor: string, docBg: string | null, floats: FloatInput[] = [], stampOverlay: OverlayInput | null = null, liveSyncLeaf: DocLeaf | null = null, surrogate: SurrogateInput | null = null): void {
    if (this._glctx.isLost) return;
    const bg: Background | undefined = docBg === "checker" ? "checker"
      : docBg ? [...hexToRgb(docBg), 1] as [number, number, number, number] : undefined;
    this._tree.renderFrame(
      doc.layers, doc.width, doc.height, bg,
      affine6, canvasW, canvasH, scale, hexToRgb(voidColor),
      floats, stampOverlay, surrogate, liveSyncLeaf ? liveSyncLeaf.id : null,
    );
  }
}
