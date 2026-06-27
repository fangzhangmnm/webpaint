// GLBoard —— 生产 board.ts 的 GL 渲染委托（docs/perf-webgl-memory-clip.md §5.5 接 board）。
// 放在 ?glboard=1 开关后面：board canvas(alpha) 在前只画 overlay/边框，本 GL canvas 垫在后面渲 doc。
// 脏策略：内容变(markContentDirty)且非 live-preview 时才 syncAll；描边中靠 live overlay，不重传；
//   pan/zoom 不重传（视口变不碰内容）。per-layer 脏 + bbox-sub overlay = 后续优化。
// 不碰生产 2D 路径：glboard=0 时 board 行为逐字不变。

import { GLContext } from "./gl-context.ts";
import { GLDocRenderer } from "./gl-doc-renderer.ts";
import type { OverlayInput } from "./gl-doc-renderer.ts";
import type { DocNode } from "./gl-doc-bridge.ts";

export interface GLDoc { layers: DocNode[]; width: number; height: number; }

// URL 开关（默认关 → 生产零变更）。
export function glBoardEnabled(): boolean {
  try { return new URLSearchParams(location.search).get("glboard") === "1"; }
  catch { return false; }
}

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

  constructor(canvas: HTMLCanvasElement, capacity: number) {
    this.canvas = canvas;
    this._glctx = new GLContext(canvas);
    this._renderer = new GLDocRenderer(this._glctx, capacity);
    // context-loss：丢了 → 全量重传（从 layer canvas 重建 tile）。
    this._glctx.onRestored = () => { this._contentDirty = true; };
  }

  get memory() { return this._renderer.memory; }
  markContentDirty(): void { this._contentDirty = true; }

  // 渲染一帧。affine6 = board _applyDocTransform 的 device-px 6 参；canvasW/H = device px；
  //   voidColor = doc 外底色；docBg = doc 背景色（null=棋盘/透明，first cut 显 void）；
  //   livePreview = 描边/调整预览中（true → 不重传，靠 overlay）；overlay = live 描边（null=无）。
  render(doc: GLDoc, affine6: number[], canvasW: number, canvasH: number, voidColor: string, docBg: string | null, livePreview: boolean, overlay: OverlayInput | null): void {
    if (this._glctx.isLost) return;
    if (this._contentDirty && !livePreview) {
      this._renderer.syncAll(doc.layers, doc.width, doc.height);
      this._contentDirty = false;
    }
    this._renderer.setOverlay(overlay, doc.width, doc.height);
    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    const [vr, vg, vb] = hexToRgb(voidColor);
    gl.clearColor(vr, vg, vb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // doc 背景：opaque → 预乘 = 直值（a=1）。棋盘/null → 透明（first cut 显 void）。
    const bg: [number, number, number, number] | undefined = docBg ? [...hexToRgb(docBg), 1] as [number, number, number, number] : undefined;
    this._renderer.renderToScreenAffine(doc.layers, doc.width, doc.height, affine6, canvasW, canvasH, bg);
  }
}
