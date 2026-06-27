// doc 图层树 → GL 合成器输入的桥（docs/perf-webgl-memory-clip.md §5.5 接 board）。
// 两件事：
//   ① uploadLayerToTiles：Layer 的 Canvas2D bbox 像素 → 稀疏 tile（空 tile 跳过=稀疏内存杠杆）+ TileIndexTexture。
//   ② docTreeToComp：doc 节点树（Layer|LayerGroup）→ CompNode 树（纯翻译，node 可测）。
// 用**结构化类型**接 doc 节点（不 import doc.ts）→ gl/ 保持独立深模块；board 传结构兼容的真节点即可。

import { TILE_SIZE, tilesAcross, forEachTileInRect } from "./tile-geometry.ts";
import { LayerTileMap } from "./tile-store.ts";
import type { TilePool } from "./tile-store.ts";
import { TileIndexTexture } from "./tile-index.ts";
import { BLEND_MODES } from "./blend-glsl.ts";
import type { BlendMode } from "./blend-glsl.ts";
import type { CompNode } from "./gl-compose-plan.ts";
import type { GLTileBackend } from "./tile-backend-gl.ts";
import type { GLContext } from "./gl-context.ts";

// 结构化 doc 节点（与 doc.ts Layer/LayerGroup 字段兼容）。
export interface DocLeaf {
  isGroup: false; id: number;
  opacity: number; mode: string; clippingMask: boolean; visible: boolean;
  bboxX: number; bboxY: number; bboxW: number; bboxH: number; canvas: CanvasImageSource;
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

// 把一个 Layer 的 bbox 像素切成稀疏 tile 上传。空层 / 全透明 tile 跳过。
// scratch = 复用的 256² 离屏（避免每层每 tile 新建）。
export function uploadLayerToTiles(
  glctx: GLContext, backend: GLTileBackend, pool: TilePool,
  layer: { bboxX: number; bboxY: number; bboxW: number; bboxH: number; canvas: CanvasImageSource },
  docW: number, docH: number, scratch: HTMLCanvasElement,
): LayerTiles {
  const across = tilesAcross(docW);
  const tileMap = new LayerTileMap(pool, across);
  const index = new TileIndexTexture(glctx, docW, docH);
  if (layer.bboxW <= 0 || layer.bboxH <= 0) return { index, tileMap };   // 空层 = 0 tile

  scratch.width = TILE_SIZE; scratch.height = TILE_SIZE;
  const sctx = scratch.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  forEachTileInRect(layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH, docW, docH, (tx, ty) => {
    sctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    // 把 layer.canvas（doc 区 [bboxX,bboxY]+bbox）画到 scratch，使 doc(tx·256,ty·256) → scratch(0,0)
    sctx.drawImage(layer.canvas, layer.bboxX - tx * TILE_SIZE, layer.bboxY - ty * TILE_SIZE);
    const data = sctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    let any = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) { any = true; break; }
    if (!any) return;   // 全透明 tile 跳过（稀疏）
    const tile = tileMap.tileAt(tx, ty, { create: true });
    if (!tile) return;  // 池满（软上限压力，TileResidency 接入后逐冷 tile）
    backend.uploadSlice(tile.slice, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    index.setTile(tx, ty, tile.slice);
  });
  return { index, tileMap };
}

// doc 节点树 → CompNode 树。resourceFor(leaf) 给该叶的 index + 是否有内容（空层不能当 clip 基底）。
export function docTreeToComp(
  nodes: DocNode[],
  resourceFor: (leaf: DocLeaf) => { index: TileIndexTexture; hasContent: boolean },
): CompNode[] {
  return nodes.map((n) => docNodeToComp(n, resourceFor));
}
function docNodeToComp(
  n: DocNode,
  resourceFor: (leaf: DocLeaf) => { index: TileIndexTexture; hasContent: boolean },
): CompNode {
  if (!n.isGroup) {
    const r = resourceFor(n);
    return { kind: "leaf", srcIndex: r.index, opacity: n.opacity, mode: safeMode(n.mode), clip: !!n.clippingMask, visible: !!n.visible, hasContent: r.hasContent };
  }
  return {
    kind: "group",
    children: n.children.map((c) => docNodeToComp(c, resourceFor)),
    opacity: n.opacity,
    mode: n.mode === "pass-through" ? "pass-through" : safeMode(n.mode),
    clip: !!n.clippingMask,
    visible: !!n.visible,
  };
}
