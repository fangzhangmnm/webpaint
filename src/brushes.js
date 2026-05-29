// Brush rack 数据模型 + 默认笔架。详 conversation v80→v81。
//
// **设计原则**：
// - 整个笔架 = 一个 JSON（一个 etag，conflict 简单）
// - brushes 是 flat array，每个 brush 标 tool + folder
// - folder 是 implicit（同 folder 字段就在同 folder 里）
// - activeByTool 记每个工具的当前 brush
// - tool 类型：brush / smudge / eraser / shapes / airbrush
//   shapes 没有自己的 brush rack（共用 brush 当 shape style）
//
// **持久化** 双路径：
// - 本地 IDB（META store, key="brush-rack"）—— 离线第一公民
// - OneDrive Apps/WebPaint/brush-rack.json —— v82+ sync gate 同模式
//
// **不冻结的字段**（用户当场调，**不**回写预设）：
//   size.base / opacity / color
// **冻结的字段**（只有显式「保存为预设」/「更新预设」才动）：
//   shape / size.curve / flow / spacing / bufferMode / taper / hardness / 椭圆参数

export const RACK_VERSION = 1;
export const DEFAULT_FOLDER = "我的常用";

// 生成 brush id（v4 UUID-ish，crypto.randomUUID 兼容性兜底）
export function newBrushId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "b-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// 一个 brush 的完整 schema（注释里 ★ 标必填，其他都有 default）。
//
//   {
//     id: "uuid",                         ★ 唯一 id
//     name: "勾线",                       ★ 显示名
//     tool: "brush" | "smudge" | "eraser" | "shapes" | "airbrush",   ★
//     folder: "我的常用",                 默认 DEFAULT_FOLDER
//     shape: {
//       kind: "round" | "ellipse" | "texture",
//       aspect: 1.0,                     椭圆长短轴比（kind=ellipse 时用）
//       rotation: 0,                     椭圆长轴角度（度）
//       hardness: 0.8,                   边缘衰减；1=硬，0=纯软
//       textureB64: null,                kind=texture 时填 PNG base64
//     },
//     size: {
//       base: 12,                        当前 size 值（用户拖滑块改这个）
//       min: 1, max: 200,
//       pressureCurve: 1.0,              0 = 没压感；1 = 线性；>1 = 后半段陡
//     },
//     flow: {
//       base: 1.0,                       single-stamp alpha base
//       pressureCurve: 0.0,              0 = 跟压力无关；>0 = 跟
//     },
//     opacity: 1.0,                      最终 cap
//     spacing: {
//       kind: "distance" | "time",
//       value: 0.12,                     **fraction of size**（不是 px），跟 engine 一致
//                                        time 模式时是 ms
//     },
//     bufferMode: "stroke-buffer" | "direct-layer",
//                                        spacing 跟 buffer 强耦合：
//                                        distance → stroke-buffer
//                                        time → direct-layer
//                                        （但留字段给 future）
//     taper: { in: 0, out: 0 },          0..1 笔头 / 笔尾 size 衰减
//     smudge: { strength: 0.8, dryness: 0.1 } | null,
//                                        tool=smudge 时填
//   }

function makeBrush({
  id = newBrushId(),
  name,
  tool,
  folder = DEFAULT_FOLDER,
  size = 12, sizeMin = 1, sizeMax = 200, sizePressureCurve = 1.0,
  flow = 1.0, flowPressureCurve = 0.0,
  opacity = 1.0,
  shapeKind = "round", aspect = 1.0, rotation = 0, hardness = 1.0,
  textureB64 = null,
  spacingKind = "distance", spacingValue = 0.12,    // **fraction of size**（同 BrushEngine 默认 0.12）
  bufferMode = null,        // 不填 = 跟 spacingKind 推
  taperIn = 0, taperOut = 0,
  smudge = null,
}) {
  if (bufferMode == null) {
    bufferMode = spacingKind === "time" ? "direct-layer" : "stroke-buffer";
  }
  return {
    id, name, tool, folder,
    shape: { kind: shapeKind, aspect, rotation, hardness, textureB64 },
    size: { base: size, min: sizeMin, max: sizeMax, pressureCurve: sizePressureCurve },
    flow: { base: flow, pressureCurve: flowPressureCurve },
    opacity,
    spacing: { kind: spacingKind, value: spacingValue },
    bufferMode,
    taper: { in: taperIn, out: taperOut },
    smudge,
  };
}

// 默认笔架——每工具一个开箱即用 preset。
// **stable ID**：以 "default-{tool}-{slug}" 形式固定。bump 时新 default 通过 id 比对
// merge 到用户 rack（不覆盖用户改过的 brush，但缺失的会补上）—— 解决 stale default 问题。
// **shapes 不在 rack 里**（v89 起）—— shapes 工具复用 brush 当前 preset
// （user：「笔刷和形状用同样的 brush class，没有单独的形状笔，就是同一个 ref」）
const DEFAULTS_SPEC = [
  // ---- brush（草图、勾线、平涂三件套）----
  { id: "default-brush-pencil",   name: "铅笔",   tool: "brush",
    args: { size: 8, hardness: 0.6, flow: 0.5, flowPressureCurve: 1.0, opacity: 0.6 } },
  { id: "default-brush-ink",      name: "勾线",   tool: "brush",
    args: { size: 4, hardness: 1.0, flow: 1.0, opacity: 1.0, sizePressureCurve: 1.5, taperIn: 0.3, taperOut: 0.3 } },
  { id: "default-brush-fill",     name: "平涂",   tool: "brush",
    args: { size: 24, hardness: 1.0, flow: 1.0, opacity: 1.0, sizePressureCurve: 0 } },

  // ---- airbrush（user 要 2 个：大喷枪喷大关系 + 小喷枪当画笔用）----
  { id: "default-airbrush-big",   name: "大喷枪", tool: "airbrush",
    args: { size: 120, hardness: 0, flow: 0.04, opacity: 1.0, spacingKind: "time", spacingValue: 16 } },
  { id: "default-airbrush-small", name: "小喷枪", tool: "airbrush",
    args: { size: 24, hardness: 0.2, flow: 0.08, opacity: 1.0, spacingKind: "time", spacingValue: 16 } },

  // ---- smudge ----
  { id: "default-smudge-soft",    name: "涂抹",   tool: "smudge",
    args: { size: 16, hardness: 0.6, smudge: { strength: 0.8, dryness: 0.1 } } },

  // ---- eraser（user 要 2 个：硬橡皮 + 软橡皮）----
  // 硬橡皮：压感控制大小 / 满流量。精修线稿
  { id: "default-eraser-hard",    name: "硬橡皮", tool: "eraser",
    args: { size: 16, hardness: 1.0, flow: 1.0, opacity: 1.0,
            sizePressureCurve: 1.5, flowPressureCurve: 0 } },
  // 软橡皮：压感控制流量 / size 弱变。柔淡
  { id: "default-eraser-soft",    name: "软橡皮", tool: "eraser",
    args: { size: 32, hardness: 0.2, flow: 0.5, opacity: 0.7,
            sizePressureCurve: 0.3, flowPressureCurve: 1.0 } },
];
function specToBrush(spec) {
  const b = makeBrush({ id: spec.id, name: spec.name, tool: spec.tool, ...spec.args });
  return b;
}

export function makeDefaultRack() {
  const brushes = DEFAULTS_SPEC.map(specToBrush);
  const activeByTool = {};
  for (const b of brushes) {
    if (!activeByTool[b.tool]) activeByTool[b.tool] = b.id;
  }
  return { version: RACK_VERSION, brushes, activeByTool };
}

// 给 IDB 已有 rack 补缺：遍历 DEFAULTS_SPEC，缺哪个 ID 就 push 一份。
// 用户改过的 default brush 仍保留（id 已存在，跳过）。新版加新 default 自动出现。
// 返回 true = 改动了，需要持久化。
export function mergeMissingDefaults(rack) {
  if (!rack || !Array.isArray(rack.brushes)) return false;
  const ids = new Set(rack.brushes.map((b) => b.id));
  let changed = false;
  for (const spec of DEFAULTS_SPEC) {
    if (!ids.has(spec.id)) {
      rack.brushes.push(specToBrush(spec));
      changed = true;
    }
  }
  // activeByTool 缺工具的 → 用新默认填
  if (!rack.activeByTool) { rack.activeByTool = {}; changed = true; }
  for (const spec of DEFAULTS_SPEC) {
    if (!rack.activeByTool[spec.tool]) {
      rack.activeByTool[spec.tool] = spec.id;
      changed = true;
    }
  }
  return changed;
}

// 序列化/反序列化：直接 JSON.stringify/parse 就行（无 Blob/Canvas）。
// textureB64 是 string，包含在 JSON 里。
export function rackToJSON(rack) {
  return JSON.stringify(rack, null, 2);
}
export function rackFromJSON(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== "object") throw new Error("rack JSON 格式不对");
  if (!Array.isArray(obj.brushes)) throw new Error("rack 缺 brushes");
  // version 迁移留位（目前只 v1）
  if (obj.version !== RACK_VERSION) {
    console.warn(`[brushes] rack version ${obj.version} ≠ ${RACK_VERSION}; 当 ${RACK_VERSION} 用`);
  }
  return obj;
}

// 单个 brush export / import（用户分享单笔用）
export function brushToJSON(brush) {
  return JSON.stringify(brush, null, 2);
}
export function brushFromJSON(text) {
  const obj = JSON.parse(text);
  if (!obj.id || !obj.name || !obj.tool) throw new Error("brush JSON 缺必填字段");
  // 导入时重新发 id，避免和现有 id 冲突
  obj.id = newBrushId();
  return obj;
}

// 工具方法
export function findBrush(rack, id) {
  return rack.brushes.find((b) => b.id === id) || null;
}
export function brushesByTool(rack, tool) {
  return rack.brushes.filter((b) => b.tool === tool);
}
export function brushesByFolder(rack, folder) {
  return rack.brushes.filter((b) => b.folder === folder);
}
export function getActiveBrush(rack, tool) {
  const id = rack.activeByTool?.[tool];
  return id ? findBrush(rack, id) : null;
}
