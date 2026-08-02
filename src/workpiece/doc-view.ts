// doc-view —— ctx.doc 的手写只读窄接口（v0.8.3 · S3 编译级收口，ADR-0007）。
//
// 为什么手写：`Readonly<PaintDoc>` 冻不住方法（mutator 方法仍可调）——只有显式列举读面才能让
// 「裸写 = 编译错」。PaintDoc 结构性满足本接口，组合根零 cast 直塞；消费方经 ctx.doc 只能读。
// 写路径（全部经 workpiece 组件，见各处）：
//   结构/属性/焦点 → workpiece.layers（LayerTree：写即记账 + treeTx + setActive 显式非 undo 焦点写）
//   选区           → workpiece.sel（SelectionFace：commitPreApplied + beginPreview tx）
//   像素           → ctx.pixelHistory（PixelTx）
//   整 doc 几何    → doc-ops.runDocTransform（tx 信封）
//   装载/换文档    → ctx.docRaw（session-state 生命周期唯一持证人，见 app-context.ts）
// 引擎单例（input/lasso/board/floating-transform）经构造注入拿真 PaintDoc——它们是声明过的写者，
// 不走 ctx.doc。类型经 `PaintDoc[...]` 索引取，源变自动跟。

import type { PaintDoc } from "../doc.ts";

export interface DocView {
  readonly width: number;
  readonly height: number;
  readonly layers: ReadonlyArray<PaintDoc["layers"][number]>;   // 元素仍是活对象（叶像素归 pixel-tx 管辖）；数组本身不可增删
  readonly activeId: number | null;
  readonly activeIndex: number;
  readonly backgroundColor: string;
  readonly selection: PaintDoc["selection"];
  readonly referenceLayerId: number | null;
  readonly maxLayers: number;
  readonly activeLayer: PaintDoc["activeLayer"];

  readonly findLayer: PaintDoc["findLayer"];
  readonly locateNode: PaintDoc["locateNode"];
  readonly canMoveLayer: PaintDoc["canMoveLayer"];
  readonly activeEditableLeaf: PaintDoc["activeEditableLeaf"];
  readonly activeNodeHidden: PaintDoc["activeNodeHidden"];
  readonly getReferenceLayer: PaintDoc["getReferenceLayer"];
  readonly getFloodSourceLayer: PaintDoc["getFloodSourceLayer"];
  readonly layerSpec: PaintDoc["layerSpec"];
}
