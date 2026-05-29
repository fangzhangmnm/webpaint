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
//       value: 1.5,                      px (distance) or ms (time)
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
  spacingKind = "distance", spacingValue = 1.5,
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

// 默认笔架——6 个 brush 覆盖每个工具一个开箱即用的 preset。
//
// 用户第一次进 WebPaint（IDB 空）时落地这套。每个工具就有 1 个能用的笔。
// 用户后续可改 / 加 / 删。
export function makeDefaultRack() {
  const brushes = [
    makeBrush({
      name: "铅笔",
      tool: "brush",
      size: 8, hardness: 0.6,
      flow: 0.5, flowPressureCurve: 1.0,    // 压力 → flow（user 要求 sketch 半透明压感）
      opacity: 0.6,
    }),
    makeBrush({
      name: "勾线",
      tool: "brush",
      size: 4, hardness: 1.0,
      flow: 1.0,
      opacity: 1.0,
      sizePressureCurve: 1.5,               // 压力 → size taper
      taperIn: 0.3, taperOut: 0.3,
    }),
    makeBrush({
      name: "平涂",
      tool: "brush",
      size: 24, hardness: 1.0,
      flow: 1.0,
      opacity: 1.0,
      sizePressureCurve: 0.0,               // 平涂不要压感
    }),
    makeBrush({
      name: "软喷枪",
      tool: "airbrush",
      size: 40, hardness: 0.0,              // 纯软高斯
      flow: 0.05,                           // 每 stamp 5% alpha，hover 累积
      opacity: 1.0,
      spacingKind: "time", spacingValue: 16,// 60fps 一 stamp
    }),
    makeBrush({
      name: "涂抹",
      tool: "smudge",
      size: 16, hardness: 0.6,
      smudge: { strength: 0.8, dryness: 0.1 },
    }),
    makeBrush({
      name: "软橡皮",
      tool: "eraser",
      size: 32, hardness: 0.3,
      flow: 0.4, opacity: 0.6,              // eraser 用 dst-out，flow/opacity 控擦力度
    }),
  ];
  const activeByTool = {};
  for (const b of brushes) {
    if (!activeByTool[b.tool]) activeByTool[b.tool] = b.id;
  }
  return {
    version: RACK_VERSION,
    brushes,
    activeByTool,
  };
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
