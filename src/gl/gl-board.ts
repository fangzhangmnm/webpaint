// GLBoard —— 生产 board.ts 的 GL 渲染委托（docs/perf-webgl-memory-clip.md §5.5 接 board）。
// 放在 ?glboard=1 开关后面：board canvas(alpha) 在前只画 overlay/边框，本 GL canvas 垫在后面渲 doc。
// 脏策略：内容变(markContentDirty)且非 live-preview 时才 syncAll；描边中靠 live overlay，不重传；
//   pan/zoom 不重传（视口变不碰内容）。per-layer 脏 + bbox-sub overlay = 后续优化。
// 不碰生产 2D 路径：glboard=0 时 board 行为逐字不变。

import { GLContext } from "./gl-context.ts";
import { GLDocRenderer } from "./gl-doc-renderer.ts";
import type { OverlayInput, FloatInput, StampOverlayInput } from "./gl-doc-renderer.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import type { Background } from "./gl-compositor.ts";
import type { PooledFBO } from "./gl-context.ts";

export interface GLDoc { layers: DocNode[]; width: number; height: number; }
// board live-sync 接缝用的叶类型别名（结构上 = DocLeaf，board 传活动 Layer 进来重传）。
export type { DocLeaf as GLLeaf } from "./gl-doc-bridge.ts";

// **v351 起 GL 是唯一 display 路径**（2D display 已归档进 ARCHIVE/old-board-2d-display.ts）。恒开；
//   `?glboard=0` 过渡逃生已删（无 2D 可回退）。GL init 失败 → board 显「需 WebGL2」（_setupGLBoard catch + _renderFull）。
export function glBoardEnabled(): boolean { return true; }

// "#rrggbb" → [r,g,b] in [0,1]（void 底色 clear 用）。失败回退浅灰。
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0.9, 0.886, 0.839];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export class GLBoard {
  readonly canvas: HTMLCanvasElement;
  private _glctx: GLContext;
  private _renderer: GLDocRenderer;
  private _contentDirty = true;
  private _cache: PooledFBO | null = null;   // 缓存的 doc 合成（视口无关）→ pan/zoom 只 present 它，不重合成

  constructor(canvas: HTMLCanvasElement, capacity: number) {
    this.canvas = canvas;
    this._glctx = new GLContext(canvas);
    this._renderer = new GLDocRenderer(this._glctx, capacity);
    // context-loss：丢了 → 全量重传（从 layer pixels 稀疏 tile 重建）+ 缓存作废。
    this._glctx.onRestored = () => { this._contentDirty = true; this._cache = null; };
  }

  get memory() { return this._renderer.memory; }
  markContentDirty(): void { this._contentDirty = true; }

  // 渲染一帧。affine6 = board _applyDocTransform 的 device-px 6 参；canvasW/H = device px；scale = 视口缩放；
  //   voidColor = doc 外底色；docBg = doc 背景色（null=棋盘/透明，first cut 显 void）；
  //   livePreview = 描边/调整预览中；overlay = live 描边（null=无）。
  // **性能关键**：合成结果缓存（视口无关）。pan/zoom（内容没变）→ 只 present 缓存，不重合成（修 30fps）。
  //   重合成只在：内容脏(commit/undo/结构) 或 描边中(overlay/active 每帧变) 或 首帧/context 恢复。
  // 给 commit 用：栅格化 stroke stamp 列表 → straight RGBA canvas（board GL-commit 走 readback→editRegion）。
  rasterizeStrokeToCanvas(stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number) {
    return this._renderer.rasterizeStrokeToCanvas(stamps, shape, bx, by, bw, bh);
  }

  render(doc: GLDoc, affine6: number[], canvasW: number, canvasH: number, scale: number, voidColor: string, docBg: string | null, livePreview: boolean, overlay: OverlayInput | null, floats: FloatInput[] = [], stampOverlay: StampOverlayInput | null = null, liveSyncLeaf: DocLeaf | null = null, forceSync = false): void {
    if (this._glctx.isLost) return;
    // forceSync：livePreview 帧也强制全量同步一次（自由变换 lift 那帧——挖洞改了源层 tile，但 livePreview
    //   门控会挡住 syncAll → 否则 GPU 上是陈旧的无洞源层）。拖动中源层静止 → 不再 forceSync，保住 v352 零 per 帧成本。
    const contentChanged = (this._contentDirty && !livePreview) || forceSync;
    if (contentChanged) { this._renderer.syncAll(doc.layers, doc.width, doc.height); this._contentDirty = false; }
    // live-sync：原地改像素的笔（liquify/filterBrush/pixelMode）描边中，contentChanged 被 live 门控挡住 →
    //   只把活动叶每帧重传 GPU，下面 livePreview 重合成就能显 live 预览（buffered brush 走 overlay，liveSyncLeaf=null）。
    else if (livePreview && liveSyncLeaf) { this._renderer.syncLayer(liveSyncLeaf, doc.width, doc.height); }

    if (contentChanged || livePreview || !this._cache) {
      // GPU stamp overlay（brush 描边中）优先；否则 CPU canvas overlay（filter/liquify 等）。
      if (livePreview && stampOverlay) {
        this._renderer.setStampOverlay(stampOverlay);
      } else {
        this._renderer.setOverlay(livePreview ? overlay : null, doc.width, doc.height);
      }
      this._renderer.setFloats(floats, doc.width, doc.height);   // 自由变换浮层（空=无变换）
      // docBg：null=透明（void 透出）/ "checker"=棋盘背景 / "#rrggbb"=预乘纯色。
      const bg: Background | undefined = docBg === "checker" ? "checker"
        : docBg ? [...hexToRgb(docBg), 1] as [number, number, number, number] : undefined;
      const fresh = this._renderer.composite(doc.layers, doc.width, doc.height, bg);
      if (this._cache) this._renderer.returnFBO(this._cache);
      this._cache = fresh;
    }

    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    const [vr, vg, vb] = hexToRgb(voidColor);
    gl.clearColor(vr, vg, vb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._renderer.presentAffine(this._cache!.tex, doc.width, doc.height, affine6, canvasW, canvasH, scale < 1);
  }
}
