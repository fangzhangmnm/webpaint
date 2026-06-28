// doc 图层树 → GL 合成器输入的桥（docs/perf-webgl-memory-clip.md §5.5 接 board）。
// 两件事：
//   ① uploadLayerToTiles：Layer 的**稀疏 tile 直接上传** GPU（无 Canvas2D 中转 = canvas 不在 GPU 路径上，
//      切片④）。空 / 全透明 tile 已被 LayerPixels 剪枝 → forEachTile 只吐有内容的 tile。
//   ② docTreeToComp：doc 节点树（Layer|LayerGroup）→ CompNode 树（纯翻译，node 可测）。
// 用**结构化类型**接 doc 节点（不 import doc.ts）→ gl/ 保持独立深模块；board 传结构兼容的真节点即可。

import { tilesAcross } from "./tile-geometry.ts";
import { LayerTileMap } from "./tile-store.ts";
import type { TilePool } from "./tile-store.ts";
import { TileIndexTexture } from "./tile-index.ts";
import { BLEND_MODES } from "./blend-glsl.ts";
import type { BlendMode } from "./blend-glsl.ts";
import type { CompNode, OverlayDesc } from "./gl-compose-plan.ts";
import type { GLTileBackend } from "./tile-backend-gl.ts";
import type { GLContext } from "./gl-context.ts";
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

export interface LayerTiles {
  index: TileIndexTexture;
  tileMap: LayerTileMap;
}

// 把一个 Layer 的稀疏 tile **直接上传** GPU（无 Canvas2D 中转，切片④）。
// LayerPixels 已剪枝空/全透明 tile → forEachTile 只吐有内容的 tile，且每 tile = 满 256² RGBA、
// 对齐全局 tile 网格 → 1:1 拷进 GPU slice，零重切片/零 drawImage/零 getImageData。
export function uploadLayerToTiles(
  glctx: GLContext, backend: GLTileBackend, pool: TilePool,
  layer: { pixels: LayerPixels },
  docW: number, docH: number,
): LayerTiles {
  const across = tilesAcross(docW);
  const tileMap = new LayerTileMap(pool, across);
  const index = new TileIndexTexture(glctx, docW, docH);
  layer.pixels.forEachTile((tx, ty, data) => {
    const tile = tileMap.tileAt(tx, ty, { create: true });
    if (!tile) return;  // 池满（软上限压力，TileResidency 接入后逐冷 tile）
    backend.uploadSlice(tile.slice, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    index.setTile(tx, ty, tile.slice);
  });
  return { index, tileMap };
}

// doc 节点树 → CompNode 树。resourceFor(leaf) 给该叶的 index + 是否有内容（空层不能当 clip 基底）。
// overlayFor(leaf) 可选：给某叶（通常活动层）挂 live 描边 overlay（null=无）。
export function docTreeToComp(
  nodes: DocNode[],
  resourceFor: (leaf: DocLeaf) => { index: TileIndexTexture; hasContent: boolean },
  overlayFor?: (leaf: DocLeaf) => OverlayDesc | null,
): CompNode[] {
  return nodes.map((n) => docNodeToComp(n, resourceFor, overlayFor));
}
function docNodeToComp(
  n: DocNode,
  resourceFor: (leaf: DocLeaf) => { index: TileIndexTexture; hasContent: boolean },
  overlayFor?: (leaf: DocLeaf) => OverlayDesc | null,
): CompNode {
  if (!n.isGroup) {
    const r = resourceFor(n);
    return { kind: "leaf", srcIndex: r.index, opacity: n.opacity, mode: safeMode(n.mode), clip: !!n.clippingMask, visible: !!n.visible, hasContent: r.hasContent, overlay: overlayFor ? overlayFor(n) : null };
  }
  return {
    kind: "group",
    children: n.children.map((c) => docNodeToComp(c, resourceFor, overlayFor)),
    opacity: n.opacity,
    mode: n.mode === "pass-through" ? "pass-through" : safeMode(n.mode),
    clip: !!n.clippingMask,
    visible: !!n.visible,
  };
}
