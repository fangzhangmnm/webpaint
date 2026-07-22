// doc 图层树 → GL 合成器输入的桥：docTreeToComp（doc 节点树 Layer|LayerGroup → CompNode 树，
//   纯翻译，node 可测）+ safeMode。
// 用**结构化类型**接 doc 节点（不 import doc.ts）→ gl/ 保持独立深模块；board 传结构兼容的真节点即可。
// （S7：uploadLayerToTiles 死——上传统一走 cpu-gpu-tile-bridge（tile-bridge.ts），增量、按 tile 身份去重。）

import { BLEND_MODES } from "./blend-glsl.ts";
import type { BlendMode } from "./blend-glsl.ts";
import type { IndexTexture } from "./gpu-tile-pool.ts";
import type { CompNode, OverlayDesc, FloatDesc } from "./gl-compose-plan.ts";
import type { LayerPixels } from "./tile-pixels.ts";

// 结构化 doc 节点（与 doc.ts Layer/LayerGroup 字段兼容）。
// pixels = 该层稀疏 tile SoT（GL 直读上传；canvas/bbox 是派生视图，GL 路径不再需要）。
export interface DocLeaf {
  isGroup: false; id: number;
  opacity: number; mode: string; clippingMask: boolean; visible: boolean;
  pixels: LayerPixels;
}
export interface DocGroup {
  isGroup: true; id: number;
  opacity: number; mode: string; clippingMask: boolean; visible: boolean; children: DocNode[];
}
export type DocNode = DocLeaf | DocGroup;

// 安全 blend：doc.mode 是字符串；非 12 可分离的回退 source-over（与现 2D 行为一致——
//   layer-composite.ts:136 把未知 mode 当 source-over）。组的 "pass-through" 单独保留。
const MODE_SET = new Set<string>(BLEND_MODES);
export function safeMode(mode: string): BlendMode {
  return MODE_SET.has(mode) ? (mode as BlendMode) : "source-over";
}

// doc 节点树 → CompNode 树。resourceFor(leaf) 给该叶的 index + 是否有内容（空层不能当 clip 基底）。
// overlayFor(leaf) 可选：给某叶（通常活动层）挂 live 描边 overlay（null=无）。
// floatFor(leaf) 可选：给某叶（自由变换源层）挂 warp 后的浮层（null=无）。
export function docTreeToComp(
  nodes: DocNode[],
  resourceFor: (leaf: DocLeaf) => { index: IndexTexture; hasContent: boolean },
  overlayFor?: (leaf: DocLeaf) => OverlayDesc | null,
  floatFor?: (leaf: DocLeaf) => FloatDesc | null,
): CompNode[] {
  return nodes.map((n) => docNodeToComp(n, resourceFor, overlayFor, floatFor));
}
function docNodeToComp(
  n: DocNode,
  resourceFor: (leaf: DocLeaf) => { index: IndexTexture; hasContent: boolean },
  overlayFor?: (leaf: DocLeaf) => OverlayDesc | null,
  floatFor?: (leaf: DocLeaf) => FloatDesc | null,
): CompNode {
  if (!n.isGroup) {
    const r = resourceFor(n);
    return { kind: "leaf", srcIndex: r.index, opacity: n.opacity, mode: safeMode(n.mode), clip: !!n.clippingMask, visible: !!n.visible, hasContent: r.hasContent, overlay: overlayFor ? overlayFor(n) : null, float: floatFor ? floatFor(n) : null };
  }
  return {
    kind: "group",
    children: n.children.map((c) => docNodeToComp(c, resourceFor, overlayFor, floatFor)),
    opacity: n.opacity,
    mode: n.mode === "pass-through" ? "pass-through" : safeMode(n.mode),
    clip: !!n.clippingMask,
    visible: !!n.visible,
  };
}
