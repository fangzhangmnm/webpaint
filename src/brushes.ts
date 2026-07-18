// Brush rack 数据模型 + 默认笔架。详 docs/20260529-brush-architecture.md。
//
// **v99 schema (Krita-aligned)**：
// - **三个压感 coeff** (sizeCoeff / opaCoeff / flowCoeff)：−1..1，0=不响应，
//   1=满压感线性，−1=反向。`signed_lerp(coeff, p) = amp + (1−amp)×p (coeff≥0)`
//   or `1 − (1−amp)×p (coeff<0)`，其中 amp = 1−|coeff|。
// - **opacity × flow 永远相乘**（Krita 4.2 起的标准；之前是加算被当 bug 修了）。
// - **compositeMode** = stroke buffer 内重叠合成方式（per-brush 标志）：
//     "wash"    = Alpha Darken：buffer = max(buffer, α_dab) → 自交不变深、单笔有上限
//     "buildup" = source-over：累积，可达 1.0（喷枪 feel）
// - **opacity / flow 不存** preset：选 preset 时 toolState.opacity = 1
//   （user：「默认 opacity 默认 flow 两个字段不要，都是 1」）。user 自己拉 slider / brush settings 调。
//   v415：dial 连 flow 这一轴都删了（钉死 1.0、无滑块 = 摆设）——压感对流量的影响走 per-preset flowCoeff。
// - **airbrush flag 没了**：buildup + opaCoeff=0 就是喷枪 feel，user 自己拉低 flow slider。
// - **pressureGamma**：p' = p^gamma，统一 power 曲线（默 1.0）。
// - **smooth**：per-preset 位置平滑参数（Procreate 两参：streamline / stabilization）。
//   v98 之前是全局 state.brush 上的，user：「smooth 没进笔刷，这个不是系统参数」。
//
// **不冻结字段**（user 当场调，不回写预设）：
//   size.base / color  + per-tool 的 opacity / flow
// **冻结字段**（显式「保存为预设」/「更新预设」才动）：
//   shape / coeffs / pressureGamma / compositeMode /
//   spacing / pixelMode / taper / hardness / 椭圆参数 / smooth

import type { Brush, BrushRackData } from "./brush-types.ts";
import { reportError } from "./error-badge.ts";

// getInitData 的初始项形状（与 store 的 CollectionInitItem 结构等价；不 import 库类型免耦合）。
export interface BrushInitItem { id: string; value: unknown; }
// 笔架 collection 的特殊项 id + .meta 值形状（per-folder 有序 brushId 列表；folder 归属仍在 brush.folder）。
export const RACK_META_ID = ".meta";
export interface RackMeta { folderOrder: string[]; order: Record<string, string[]>; }

// makeBrush 的命名参数形状（大多有默认值，name/tool 必填）。
interface MakeBrushArgs {
  id?: string;
  name: string;
  tool: string;
  folder?: string;
  size?: number;
  sizeBaseMax?: number;
  sizeCoeff?: number;
  opaCoeff?: number;
  flowCoeff?: number;
  pressureGamma?: number;
  pressureLPF?: number;
  compositeMode?: string;
  blendMode?: string;
  shapeKind?: string;
  aspect?: number;
  rotation?: number;
  hardness?: number;
  spacingValue?: number;
  pixelMode?: boolean;
  taperIn?: number;
  taperOut?: number;
  streamline?: number;
  stabilization?: number;
  defaultOpa?: number;
}

// builtin-brushes.json 的单条 spec（id/name/tool + 其余 makeBrush 参数收在 args）。
interface BrushSpec {
  id: string;
  name: string;
  tool: string;
  args?: Partial<MakeBrushArgs>;
}

// migrateBrush 的输入：IDB 老 schema brush，含已撤字段（flow/airbrush/opacity/...）。
// 迁移代码读写/删除大量动态历史字段，故 index 签名 any 兜底（documented last-resort：
// 这是按字段名擦写的迁移管线，不是稳定契约）。只把做算术/比较的嵌套形状显式列出。
interface LegacyBrush {
  size?: BrushSizeLegacy;
  flow?: { min?: number; pressureCurve?: number; base?: number };
  spacing?: { kind?: string; value?: number } | number;
  [k: string]: any;
}
interface BrushSizeLegacy {
  base?: number;
  max?: number;
  min?: number;
  pressureCurve?: number;
}

export const DEFAULT_FOLDER = "我的常用";

export function newBrushId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "b-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function makeBrush({
  id = newBrushId(),
  name,
  tool,
  folder = DEFAULT_FOLDER,
  size = 12, sizeBaseMax = 200,
  sizeCoeff = 0.6, opaCoeff = 0.6, flowCoeff = 0,
  pressureGamma = 1.0,
  // v102+: pressure low-pass filter（ms，时间域 IIR）
  // 解 "勾线转角顿一下 out-leg 变细" —— LPF 让落点过去几十毫秒的高 pressure 仍留尾巴
  pressureLPF = 0,
  compositeMode = "wash",
  blendMode = "source-over",   // v163: per-brush 混合模式（multiply/screen/... ＝ Canvas2D globalCompositeOperation）
  shapeKind = "round", aspect = 1.0, rotation = 0, hardness = 0.75,   // 与 DEFAULT_CONFIG / ensureBrushConfigDefaults / resolveBrush 统一（v415：此前三处 0.75/1.0/1.0 各说各话）
  spacingValue = 0.06,
  pixelMode = false,
  taperIn = 0, taperOut = 0,
  // 位置平滑（per-brush，Procreate，详 docs/20260613-brush-procreate-smoothing.md）
  streamline = 0.15, stabilization = 0,
  // v99r2：defaultOpa 留着，默认 1.0；user 编辑笔可以改成 0.6 当 sketch 默认
  defaultOpa = 1.0,
}: MakeBrushArgs): Brush {
  return {
    id, name, tool, folder,
    shape: { kind: shapeKind, aspect, rotation, hardness },
    size: { base: size, max: sizeBaseMax },
    sizeCoeff, opaCoeff, flowCoeff,
    pressureGamma,
    pressureLPF,
    defaultOpa,
    compositeMode,
    blendMode,
    spacing: spacingValue,
    pixelMode,
    taper: { in: taperIn, out: taperOut },
    smooth: { streamline, stabilization },
  };
}

// 出厂笔 spec 源——每工具一组开箱即用 preset。
// v122 r2：builtin-brushes.json 从 src/ 挪到根，改 runtime fetch（user：「async fetch，
// 什么时候拿到什么时候填，之前填空」）。SW precache 离线兜底；fetch 失败也不卡 boot。
// **stable ID**：以 "default-{tool}-{slug}" 形式固定——resetBuiltin 靠 id 比对覆盖同 id 用户笔。
// **shapes/airbrush 工具已撤**（v96/v120）——BRUSH_GROUP 仍含其 tool 值，仅为老 preset 数据向后兼容。
let _builtinSpec: BrushSpec[] = [];      // fetch 回来前是空，回来后就是 builtin-brushes.json 内容
const _builtinPromise = (async () => {
  try {
    const url = new URL("./builtin-brushes.json", document.baseURI).href;
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = await r.json();
    if (!Array.isArray(json)) throw new Error("builtin-brushes.json 不是数组");
    _builtinSpec = json;
  } catch (e) {
    reportError(new Error("[brushes] builtin-brushes.json 加载失败 → 走空兜底（emergency brush 顶上）。" + String(e)), "log");
    _builtinSpec = [];
  }
  return _builtinSpec;
})();

// fetch 失败时的兜底：至少一个能画的笔，UI 不挂。
function _emergencyBrush(): Brush {
  return makeBrush({
    id: "emergency-brush", name: "默认笔", tool: "brush",
    size: 12, hardness: 0.8, sizeCoeff: 0.6, opaCoeff: 0.6,
  });
}

// 出厂笔（specToBrush 化；fetch 失败 → emergency 兜底）。await 内部 fetch promise（幂等缓存）。
//   给 collection.getInitData（新库 seed）与 controller.resetBuiltin（非破坏性覆盖同 id）共用。
export async function builtinBrushes(): Promise<Brush[]> {
  const specs = await _builtinPromise;
  const brushes = specs.map((s) => specToBrush(s));
  return brushes.length ? brushes : [_emergencyBrush()];
}

// —— .meta（per-folder 有序 brushId）纯操作（无副作用，node 可测）——
export function emptyMeta(): RackMeta { return { folderOrder: [], order: {} }; }

// 追加 id 到 folder 列表末尾（folder 不在则登记）；已在该 folder 则原样返回。
export function metaAppend(meta: RackMeta, folder: string, id: string): RackMeta {
  const folderOrder = meta.folderOrder.includes(folder) ? meta.folderOrder : [...meta.folderOrder, folder];
  const cur = meta.order[folder] || [];
  const list = cur.includes(id) ? cur : [...cur, id];
  return { folderOrder, order: { ...meta.order, [folder]: list } };
}

// 从所有 folder 列表移除 id。
export function metaRemove(meta: RackMeta, id: string): RackMeta {
  const order: Record<string, string[]> = {};
  for (const f of Object.keys(meta.order)) order[f] = meta.order[f].filter((x) => x !== id);
  return { folderOrder: meta.folderOrder, order };
}

// 把 id 挪到 target folder（先从各处摘除，再追加到 target 末尾）。
export function metaMove(meta: RackMeta, id: string, toFolder: string): RackMeta {
  return metaAppend(metaRemove(meta, id), toFolder, id);
}

// resetBuiltin 用：把出厂 id（按 folder 分组）提到各自 folder 列表**最前**，用户笔留其后。
export function metaPrependBuiltins(meta: RackMeta, builtinsByFolder: Record<string, string[]>): RackMeta {
  const folders = [...new Set([...Object.keys(builtinsByFolder), ...meta.folderOrder])];
  const order: Record<string, string[]> = {};
  for (const f of folders) {
    const builtins = builtinsByFolder[f] || [];
    const rest = (meta.order[f] || []).filter((x) => !builtins.includes(x));
    order[f] = [...builtins, ...rest];
  }
  for (const f of Object.keys(meta.order)) if (!(f in order)) order[f] = meta.order[f];
  return { folderOrder: folders, order };
}

// 从一组笔攒初始 .meta（按 folder 保序分组）。
export function buildInitMeta(brushes: Brush[]): RackMeta {
  let meta = emptyMeta();
  for (const b of brushes) meta = metaAppend(meta, b.folder || DEFAULT_FOLDER, b.id);
  return meta;
}

// collection.getInitData（新库 seed）：出厂笔逐 item + 一条 .meta。store 内容无关，此为 app 域构造。
export async function builtinBrushInitData(): Promise<BrushInitItem[]> {
  const brushes = await builtinBrushes();
  const meta = buildInitMeta(brushes);
  return [
    ...brushes.map((b) => ({ id: b.id, value: b as unknown })),
    { id: RACK_META_ID, value: meta as unknown },
  ];
}

// —— collection ↔ 瞬态 rack 视图桥（controller 用；结构型 CollectionLike 免耦合 store 类型）——
export interface CollectionLike {
  entries(): { id: string; value: unknown }[];
  getItem(id: string, def?: unknown): unknown;
}
// 按 .meta 排序：folder 间按 folderOrder，folder 内按 order[folder]；不在 order 的（未登记新笔）落该 folder 末尾。
//   稳定：同 rank 保原插入序。lookup（findBrush by id）不受影响；仅显示顺序用。无 .meta → 恒等（插入序）。
export function orderBrushesByMeta(brushes: Brush[], meta: RackMeta): Brush[] {
  const folderRank = (f: string): number => { const i = meta.folderOrder.indexOf(f); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const withinRank = (b: Brush): number => { const l = meta.order[b.folder || DEFAULT_FOLDER]; const i = l ? l.indexOf(b.id) : -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return brushes.map((b, i) => ({ b, i })).sort((x, y) => {
    const fr = folderRank(x.b.folder || DEFAULT_FOLDER) - folderRank(y.b.folder || DEFAULT_FOLDER);
    if (fr) return fr;
    const wr = withinRank(x.b) - withinRank(y.b);
    return wr || (x.i - y.i);
  }).map((e) => e.b);
}
// 全部笔（过滤 .meta 特殊项，按 .meta 排序 → resetBuiltin 的「出厂笔在最前」等可见）。
export function getAllBrushes(coll: CollectionLike): Brush[] {
  const brushes = coll.entries().filter((e) => e.id !== RACK_META_ID).map((e) => e.value as Brush);
  return orderBrushesByMeta(brushes, getMeta(coll));
}
// .meta 值（缺则空）。
export function getMeta(coll: CollectionLike): RackMeta {
  const m = coll.getItem(RACK_META_ID, emptyMeta()) as RackMeta | undefined;
  return m && Array.isArray(m.folderOrder) && m.order ? m : emptyMeta();
}

// IDB 老 schema 兼容（v82~v98 → v99）：
// - 老 spacing { kind, value } / size.pressureCurve / flow.pressureCurve / bufferMode / airbrush / opacity / flow.base / flow.min / size.min
// - v98 的 defaultOpa / defaultFlow 也删（user：「默认 opacity 默认 flow 两个字段不要，都是 1」）
// - v99 加 smooth 字段（user：「smooth 没进笔刷」）
export function migrateBrush(b: LegacyBrush): LegacyBrush {
  if (!b) return b;
  // 老 spacing { kind, value } → 标量
  if (b.spacing && typeof b.spacing === "object") {
    b.spacing = (b.spacing.kind === "time") ? 0.05 : (b.spacing.value || 0.06);
  }
  // size coeff：v97 sizeMin → coeff = 1 − sizeMin；更老 pressureCurve >0 → 0.6，=0 → 0
  if (b.sizeCoeff == null) {
    const sm = b.size?.min;
    if (sm != null) b.sizeCoeff = Math.max(-1, Math.min(1, 1 - sm));
    else {
      const pc = b.size?.pressureCurve;
      b.sizeCoeff = (pc == null || pc > 0) ? 0.6 : 0;
    }
  }
  if (b.size) {
    delete b.size.min;
    delete b.size.pressureCurve;
  }
  // flow coeff：v97 flowMin → coeff = 1 − flowMin；更老 pressureCurve >0 → 1，=0 → 0
  if (b.flowCoeff == null) {
    const fm = b.flow?.min;
    if (fm != null) b.flowCoeff = Math.max(-1, Math.min(1, 1 - fm));
    else {
      const pc = b.flow?.pressureCurve;
      b.flowCoeff = (pc != null && pc > 0) ? 1.0 : 0;
    }
  }
  delete b.flow;
  // opaCoeff：legacy 无 → airbrush 时 0，其他 0.6
  if (b.opaCoeff == null) {
    b.opaCoeff = b.airbrush ? 0 : 0.6;
  }
  delete b.opacity;
  // v99r2：defaultOpa 留着（默认 1.0），defaultFlow 撤
  if (b.defaultOpa == null) b.defaultOpa = 1.0;
  delete b.defaultFlow;
  if (b.pressureGamma == null) b.pressureGamma = 1.0;
  if (b.pressureLPF == null) b.pressureLPF = 0;
  delete b.flowScale;                          // v106 撤
  delete b.spacingFlowMul;                     // 顺便清未出生的字段
  // compositeMode：airbrush=true → buildup；否则 wash
  if (b.compositeMode == null) {
    b.compositeMode = b.airbrush ? "buildup" : "wash";
  }
  delete b.airbrush;
  delete b.bufferMode;
  // v99 smooth：之前在 system state.brush 上的字段挪进 preset（v243 收两参）
  if (!b.smooth) {
    b.smooth = { streamline: 0.15, stabilization: 0 };
  }
  return b;
}

function specToBrush(spec: BrushSpec): Brush {
  return makeBrush({ id: spec.id, name: spec.name, tool: spec.tool, ...spec.args });
}

// 单 brush export / import
export function brushToJSON(brush: Brush): string {
  return JSON.stringify(brush, null, 2);
}
export function brushFromJSON(text: string): LegacyBrush {
  const obj = JSON.parse(text);
  if (!obj.id || !obj.name || !obj.tool) throw new Error("brush JSON 缺必填字段");
  obj.id = newBrushId();
  migrateBrush(obj);
  return obj;
}

// 工具方法
export function findBrush(rack: BrushRackData, id: string): Brush | null {
  return rack.brushes.find((b) => b.id === id) || null;
}
// brush 工具池子含已撤工具的老 preset（airbrush/shapes 工具撤了，但用户老 rack 里的 preset 仍要可见）
const BRUSH_GROUP = ["brush", "airbrush", "shapes"];
export function brushesByTool(rack: BrushRackData, tool: string): Brush[] {
  if (tool === "brush") {
    return rack.brushes.filter((b) => BRUSH_GROUP.includes(b.tool));
  }
  // v132 filterBrush 是新工具类别，自己的 rack（不串到 brush）
  return rack.brushes.filter((b) => b.tool === tool);
}
// （brushesByFolder 已删 v415：零调用者。笔架按夹分组走 brush-rack-view.collectFolders + brushesByTool。）
// 某工具的「代表笔」——给 defaultToolStateFor 取初值。
// activeByTool 已废（v2：活动笔归 per-doc toolStates，见 docs/20260606-folderflow-build-plan.md §6）；
// 这里就取该工具第一支笔当默认。
export function defaultBrushForTool(rack: BrushRackData, tool: string): Brush | null {
  return brushesByTool(rack, tool)[0] || null;
}
