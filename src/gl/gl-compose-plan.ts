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
  blendMode: BlendMode;   // 笔刷混合模式（overlay 合到 base 用；erase 时忽略）
  ox: number; oy: number; ow: number; oh: number;   // doc 坐标 bbox（shader 按此映射，bbox 外透明）
  lockAlpha?: boolean;    // 锁α：overlay 裁到 base 现有 alpha（GPU stamp overlay 用；CPU canvas overlay 已预裁=false）
  selMask?: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null;   // 选区蒙版（同上，预裁的 CPU overlay=null）
}
// 自由变换浮层（floatFor 接缝，对齐 2D layer-composite.ts:143-145）= **GPU warp 输入**：未 warp 的源纹理 +
//   逆单应性 Hinv（doc→源单位方格）+ sampleMode。shader 逐 dst 像素 gather 采样。在源层 z 之上 source-over α=1，
//   **忽略源层 mode/opacity**（与 overlay 不同——overlay 随层）。
export interface FloatDesc {
  tex: WebGLTexture;      // 源纹理（未 warp，直值，srcW×srcH，常驻——拖动中只换 hinv）
  srcW: number; srcH: number;
  hinv: number[];         // 9，row-major，doc(x,y,1)→源 (u,v,w) 透视除
  mode: number;           // 0=nearest 1=bilinear 2=bicubic
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
  float?: FloatDesc | null;       // 自由变换浮层（null/缺省=无）
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
      // 浮层叶（自由变换中基底被挖洞 hasContent=false，但内容在 .float 里）也算有内容 → 仍当合法 clip 基底，
      //   否则组变换时 clip 浮层找不到基底、裁剪断掉（见 docs/20260628-transform-clip-gpu-warp.md）。
      const hasContent = n.kind === "group" ? n.visible : (n.visible && (n.hasContent || !!n.float));
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
