// brush-types.ts —— brush / 笔架数据形状的单一 TS 描述。
//
// 运行时真源仍是 brushes.js（.js，checkJs:false）。这里**诚实描述**消费方（brush-rack / brush-io）
// 实际读写到的字段，挂 `[k]: unknown` index 兜底动态/未列字段——非穷举、非新契约，只是把抄在多处的
// 隐式 any 收成一处可复用的形状。改 brushes.js 的字段时同步收紧此处（as-of v305 / 2026-06-19）。

export interface BrushSize { base: number; max?: number; }
// kind: "round" | "ellipse"。**没有 texture** —— 纹理笔尚未实现，v415 把那条死线整条清了
//   （下拉项选了没反应、textureB64 存而不读）。将来真做纹理笔时 greenfield 重来，别复活这些残骸。
export interface BrushShape {
  kind?: string; aspect?: number; rotation?: number; hardness?: number;
}
export interface BrushTaper { in?: number; out?: number; }
export interface BrushSmooth { streamline?: number; stabilization?: number; }

export interface Brush {
  id: string;
  name: string;
  tool: string;
  folder?: string;
  size: BrushSize;
  shape?: BrushShape;
  sizeCoeff?: number;
  opaCoeff?: number;
  flowCoeff?: number;
  pressureGamma?: number;
  pressureLPF?: number;
  defaultOpa?: number;
  compositeMode?: string;
  blendMode?: string;
  spacing?: number | { value?: number };
  pixelMode?: boolean;
  taper?: BrushTaper;
  smooth?: BrushSmooth;
  creation_time?: number;   // 新建/复制笔一瞬填；仅作者/版权签名参考，不进同步机制（uat 归 collection 内部盖戳）。
  [k: string]: unknown;
}

// 瞬态视图（controller 从 collection 现攒 { brushes: getAllBrushes(coll) }）——不再是持久化结构。
//   旧的 version/trash/resetAt 随 uat/水位线机制一并撤（collection 用 tombstone + 内部 uat-LWW）。
export interface BrushRackData {
  version?: number;
  brushes: Brush[];
  [k: string]: unknown;
}
