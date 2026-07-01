// GLBoard —— board.ts 的 GL 渲染委托（v351 起唯一 display 路径；docs/20260614-perf-webgl-memory-clip.md §5.5）。
// board canvas(alpha:true) 在前只画 lasso overlay/边框，本 GL canvas 垫在后面渲 doc。
// 脏策略：内容变(markContentDirty)且非 live-preview 时才 syncAll；描边中靠 GPU stamp overlay/live-sync seam，
//   不重传；pan/zoom 不重传（视口变不碰内容）。per-layer 脏 + bbox-sub = 后续优化（见 perf-optimization-backlog）。

import { GLContext } from "./gl-context.ts";
import { GLDocRenderer } from "./gl-doc-renderer.ts";
import type { FloatInput, StampOverlayInput, SurrogateInput } from "./gl-doc-renderer.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import type { Background } from "./gl-compositor.ts";
import type { PooledFBO } from "./gl-context.ts";

export interface GLDoc { layers: DocNode[]; width: number; height: number; }
// board live-sync 接缝用的叶类型别名（结构上 = DocLeaf，board 传活动 Layer 进来重传）。
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
  private _renderer: GLDocRenderer;
  private _contentDirty = true;
  private _cache: PooledFBO | null = null;   // 缓存的 doc 合成（视口无关）→ pan/zoom 只 present 它，不重合成
  private _lastDocW = -1; private _lastDocH = -1;   // doc 尺寸变检测（→ 清 FBO 池，旧尺寸 FBO 永不再命中）

  constructor(canvas: HTMLCanvasElement, capacity: number) {
    this.canvas = canvas;
    this._glctx = new GLContext(canvas);
    this._renderer = new GLDocRenderer(this._glctx, capacity);
    // context-loss：丢了 → 底层 array texture 也失效 → 先重建后端+复位池+清陈旧 tiles，再全量重传。
    //   被驱逐层的 raw 也随 GPU 没了（只剩压缩备份）→ 先 recoverAll 从备份解驱逐（_needRecover 门），再 syncAll 重传。
    this._glctx.onRestored = () => {
      this._renderer.handleContextRestored();   // 重建后端 array texture + 复位池 + 清陈旧 _layerTiles（旧句柄已死）
      this._contentDirty = true; this._cache = null; this._needRecover = true;
    };
  }

  private _needRecover = false;    // context-loss 后待从备份重物化被驱逐层（recoverAll 在 syncAll 前跑）
  private _recovering = false;     // recoverAll 进行中：跳过合成帧（别从空 raw 合成）

  // board 每次活动层变时转发：pin 新活动 + 备份驱逐切走的冷层。
  setActiveLeaf(leaf: DocLeaf | null): void { this._renderer.setActiveLeaf(leaf); }
  get residencyBackupBytes(): number { return this._renderer.residencyBackupBytes; }

  get memory() { return this._renderer.memory; }
  // 上一帧合成 pass 计数（dev HUD；只在内容/描边帧更新——pan/zoom 只 present 缓存不重合成，故读数冻在上次合成）。
  get stats(): { passes: number; floatPasses: number } { return this._renderer.stats; }
  get fboPoolStats(): { count: number; bytes: number } { return this._renderer.fboPoolStats; }
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

  // 给自由变换 commit 用：warp 源 → straight RGBA canvas（_bakeDown 走 readback→editRegion，复用 live warp）。
  warpToCanvas(srcCanvas: TexImageSource, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) {
    return this._renderer.warpToCanvas(srcCanvas, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  render(doc: GLDoc, affine6: number[], canvasW: number, canvasH: number, scale: number, voidColor: string, docBg: string | null, livePreview: boolean, floats: FloatInput[] = [], stampOverlay: StampOverlayInput | null = null, liveSyncLeaf: DocLeaf | null = null, forceSync = false, surrogate: SurrogateInput | null = null): void {
    if (this._glctx.isLost) return;
    // context-loss 恢复：先从压缩备份重物化被驱逐层的 CPU raw，再让下帧 syncAll 重传 GPU。async → 恢复中跳帧
    //   （别从空 raw 合成成空层）。恢复完 markContentDirty，下帧正常全量重传。
    if (this._needRecover && !this._recovering) {
      this._needRecover = false; this._recovering = true;
      this._renderer.recoverAll(doc.layers)
        .then(() => { this._recovering = false; this._contentDirty = true; })
        .catch(() => { this._recovering = false; this._contentDirty = true; });
    }
    if (this._recovering) return;
    // doc 尺寸变（改分辨率/裁剪）：池里全是旧 doc 尺寸 FBO，永不再命中 → 主动清掉真删 GL（旧的大、早放早好），
    //   缓存作废、下帧全量重传。比等 cap 惰性驱逐更干净（否则会同时压两个 doc 尺寸的 FBO）。
    if (doc.width !== this._lastDocW || doc.height !== this._lastDocH) {
      if (this._cache) { this._renderer.returnFBO(this._cache); this._cache = null; }
      this._glctx.clearPool();
      this._contentDirty = true;
      this._lastDocW = doc.width; this._lastDocH = doc.height;
    }
    // forceSync：livePreview 帧也强制全量同步一次（自由变换 lift 那帧——挖洞改了源层 tile，但 livePreview
    //   门控会挡住 syncAll → 否则 GPU 上是陈旧的无洞源层）。拖动中源层静止 → 不再 forceSync，保住 v352 零 per 帧成本。
    const contentChanged = (this._contentDirty && !livePreview) || forceSync;
    if (contentChanged) { this._renderer.syncAll(doc.layers, doc.width, doc.height); this._contentDirty = false; }
    // live-sync：原地改像素的笔（liquify/filterBrush/pixelMode）描边中，contentChanged 被 live 门控挡住 →
    //   只把活动叶每帧重传 GPU，下面 livePreview 重合成就能显 live 预览（buffered brush 走 overlay，liveSyncLeaf=null）。
    else if (livePreview && liveSyncLeaf) { this._renderer.syncLayer(liveSyncLeaf, doc.width, doc.height); }
    // 颜色调整 live preview：把活动层的替身 canvas 当它的 GPU tiles 上传（非破坏，layer.pixels 不动）。livePreview
    //   下 syncAll 已被门控挡住 → 不会覆盖。清除替身后 board markContentDirty → syncAll 从真像素恢复。
    if (surrogate) this._renderer.syncLayerFromCanvas(surrogate.layerId, surrogate.canvas, surrogate.bx, surrogate.by, surrogate.w, surrogate.h, doc.width, doc.height);

    if (contentChanged || livePreview || !this._cache) {
      // brush live = GPU stamp overlay（描边中）；否则清掉上帧 overlay（filter/liquify/pixel 走 live-sync seam，无 overlay）。
      if (livePreview && stampOverlay) this._renderer.setStampOverlay(stampOverlay, doc.width, doc.height);
      else this._renderer.clearOverlay();
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
