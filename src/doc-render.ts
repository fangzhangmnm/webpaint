// S9：doc 图层树 → 合成像素的**唯一生产面**（GL render-tree compositeOnce readback）。
// 旧 2D 规范合成器 layer-composite.ts 已归档为对拍参照（test/gl-smoke/reference-2d.ts）——
// display / 导出 / 缩略图 / mergedimage / PSD / 参考窗镜像从此同一个合成引擎，观感零漂移。
// app.ts 开机注入 board 后端；GL 不可用（无 WebGL2 / context lost）→ 返 null，调用方各自兜
// （导出=报错、autosave mergedimage=透明占位不阻塞落盘、镜像=保留上帧）。

type Bitmap = HTMLCanvasElement | OffscreenCanvas;

// 节点 = doc.ts 的 Layer|LayerGroup（结构化收：GL 侧只读 id/opacity/mode/clippingMask/visible/pixels/children）。
export type DocCompositorFn = (nodes: unknown[], docW: number, docH: number) => Bitmap | null;

let _fn: DocCompositorFn | null = null;
export function setDocCompositor(fn: DocCompositorFn): void { _fn = fn; }

/** nodes → 合成 canvas（**透明底**；doc 背景由调用方按需自铺）。null = GL 不可用。 */
export function renderNodesToCanvas(nodes: unknown[], docW: number, docH: number): Bitmap | null {
  return _fn ? _fn(nodes, docW, docH) : null;
}
