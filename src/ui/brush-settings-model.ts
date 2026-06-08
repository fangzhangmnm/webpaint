// 笔设置编辑器的纯模型（UI 深化 candidate 1）。
//
// 把旧 _renderBrushSettings 里散落的「schema 补缺」（`if (b.x == null) b.x = default`）收成一个
// 幂等纯函数：编辑器打开前补齐所有字段，模板就能无脑 v-model（不必到处判 undefined）。
// 也把 spacing 归一成 number（旧代码 spacing 可能是 number 或 {value}），模板只面对 number。
// node 可测（test/brush-settings-model.test.mjs）。

export interface BrushDraft {
  name?: string; tool?: string; folder?: string; blendMode?: string;
  shape?: { kind?: string; aspect?: number; rotation?: number; hardness?: number };
  size?: { base?: number; max?: number };
  sizeCoeff?: number; opaCoeff?: number; flowCoeff?: number;
  pressureGamma?: number; pressureLPF?: number; compositeMode?: string;
  defaultOpa?: number; pixelMode?: boolean;
  spacing?: number | { value?: number };
  taper?: { in?: number; out?: number };
  smooth?: { streamline?: number; stabilization?: number; pullStabilizer?: number; motionFilter?: number };
  smudge?: { strength?: number; dryness?: number };
  [k: string]: unknown;
}

// 原地补齐编辑器需要的全部字段（幂等）。返回同一对象（方便链式）。
// 默认值与旧 _renderBrushSettings 逐字对齐。
export function ensureBrushDraftDefaults(b: BrushDraft): BrushDraft {
  if (!b.shape) b.shape = {};
  if (b.shape.kind == null) b.shape.kind = "round";
  if (b.shape.aspect == null) b.shape.aspect = 1.0;
  if (b.shape.rotation == null) b.shape.rotation = 0;
  if (b.shape.hardness == null) b.shape.hardness = 1.0;

  if (!b.size) b.size = {};
  if (b.size.base == null) b.size.base = 12;
  if (b.size.max == null) b.size.max = 200;

  if (b.sizeCoeff == null) b.sizeCoeff = 0.6;
  if (b.opaCoeff == null) b.opaCoeff = 0.6;
  if (b.flowCoeff == null) b.flowCoeff = 0;
  if (b.pressureGamma == null) b.pressureGamma = 1.0;
  if (b.pressureLPF == null) b.pressureLPF = 50;
  if (b.compositeMode == null) b.compositeMode = "wash";
  if (b.defaultOpa == null) b.defaultOpa = 1.0;
  if (b.blendMode == null) b.blendMode = "source-over";
  b.pixelMode = !!b.pixelMode;

  if (!b.smooth) b.smooth = {};
  if (b.smooth.streamline == null) b.smooth.streamline = 0.3;
  if (b.smooth.stabilization == null) b.smooth.stabilization = 0;
  if (b.smooth.pullStabilizer == null) b.smooth.pullStabilizer = 0;
  if (b.smooth.motionFilter == null) b.smooth.motionFilter = 0;

  if (!b.taper) b.taper = {};
  if (b.taper.in == null) b.taper.in = 0;
  if (b.taper.out == null) b.taper.out = 0;

  // smudge 永远补（编辑器里可把 tool 切成 smudge，v-if 段需要字段在场）
  if (!b.smudge) b.smudge = {};
  if (b.smudge.strength == null) b.smudge.strength = 0.8;
  if (b.smudge.dryness == null) b.smudge.dryness = 0.1;

  // spacing 归一成 number（fraction）：旧值可能是 number 或 {value}
  b.spacing = (typeof b.spacing === "number") ? b.spacing : (b.spacing?.value ?? 0.06);

  return b;
}
