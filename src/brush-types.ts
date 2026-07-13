// brush-types.ts —— brush / 笔架数据形状的单一 TS 描述。
//
// 运行时真源仍是 brushes.js（.js，checkJs:false）。这里**诚实描述**消费方（brush-rack / brush-io）
// 实际读写到的字段，挂 `[k]: unknown` index 兜底动态/未列字段——非穷举、非新契约，只是把抄在多处的
// 隐式 any 收成一处可复用的形状。改 brushes.js 的字段时同步收紧此处（as-of v305 / 2026-06-19）。

export interface BrushSize { base: number; max?: number; }
export interface BrushShape {
  kind?: string; aspect?: number; rotation?: number; hardness?: number; textureB64?: string | null;
}
export interface BrushTaper { in?: number; out?: number; }
export interface BrushSmooth { streamline?: number; stabilization?: number; }

export interface Brush {
  id: string;
  name: string;
  tool: string;
  folder?: string;
  // 笔架内排序键（全局单调；filter by tool/folder 保序 = 保夹内顺序）。collection 逐 item 存，items() 顺序不保证 → 靠 order 复原用户排列。
  order?: number;
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
  uat?: number;
  [k: string]: unknown;
}

export interface BrushRackData {
  version: number;
  brushes: Brush[];
  trash?: unknown[];   // tombstone 数组（{id,uat}）；存同步在此进出，留 unknown 不绑死 server 形状
  resetAt?: number;
  [k: string]: unknown;
}
