// GL 合成计划（纯逻辑，node 可测）。把「图层树节点」的 clip 基底解析 + 组隔离判定收成一处，
// 与 2D 规范合成器 layer-composite.ts 的语义**逐条对齐**（那边已是 deep module A、有测试）。
// GLCompositor 的递归执行器消费这两个判定；像素正确性由 smoke 拿真 compositeLayers 当 golden 验。
//
// CompNode = 合成器输入节点（与 doc.ts 的 Layer/LayerGroup 解耦——board 接线时翻译过来）。
//   叶携带 GL 资源（srcIndex），但本文件纯判定不碰它。

import type { TileIndexTexture } from "./tile-index.ts";
import type { BlendMode } from "./blend-glsl.ts";

// live 描边 overlay（活动叶层叠加）：**bbox 尺寸**直值纹理 + doc 坐标 bbox（origin/size）+ 不透明度 + 擦除。
//   blendMode-overlay 暂缓。
export interface OverlayDesc {
  tex: WebGLTexture;
  opacity: number;
  erase: boolean;
  ox: number; oy: number; ow: number; oh: number;   // doc 坐标 bbox（shader 按此映射，bbox 外透明）
}
export interface CompLeaf {
  kind: "leaf";
  srcIndex: TileIndexTexture;
  opacity: number;
  mode: BlendMode;
  clip: boolean;          // 是否剪裁层
  visible: boolean;
  hasContent: boolean;    // 有像素（空层不能当 clip 基底；对齐 2D 的 bboxW>0&&bboxH>0）
  overlay?: OverlayDesc | null;   // 活动叶的 live 描边 overlay（null/缺省=无）
}
export interface CompGroup {
  kind: "group";
  children: CompNode[];
  opacity: number;
  mode: BlendMode | "pass-through";
  clip: boolean;
  visible: boolean;
}
export type CompNode = CompLeaf | CompGroup;

// 某层级兄弟数组的剪裁基底解析（与 layer-composite.ts computeClipBaseForNodes 逐行对齐）：
//   clip 节点 → 同级下方最近的「非clip、可见、有内容」节点为基底；连续 clip 链共基底；
//   基底自身 / 无基底 → null。叶有内容=hasContent；组有内容=可见（无法廉价知空组，安全上界）。
export function resolveClipBases(nodes: CompNode[]): (CompNode | null)[] {
  const out: (CompNode | null)[] = new Array(nodes.length).fill(null);
  let base: CompNode | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.clip && base) {
      out[i] = base;
    } else {
      out[i] = null;
      const hasContent = n.kind === "group" ? n.visible : (n.visible && n.hasContent);
      if (!n.clip && hasContent) base = n;
    }
  }
  return out;
}

// 组是否需要隔离（先合 buffer 再整体混）。pass-through 是唯一非隔离态（对齐 layer-composite.ts
//   groupNeedsIsolation，v278 起 mode==="pass-through" 是显式默认；其余一切都隔离）。
export function needsIsolation(g: CompGroup): boolean {
  return g.mode !== "pass-through" || g.opacity < 1 || g.clip;
}

// 隔离组整体混时的有效 blend：pass-through 被 opacity<1/clip 逼到隔离 → 整体按 source-over（穿透≠混合模式）。
export function groupUnitMode(g: CompGroup): BlendMode {
  return g.mode === "pass-through" ? "source-over" : g.mode;
}
