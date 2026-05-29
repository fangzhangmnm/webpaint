// Brush rack 数据模型 + 默认笔架。详 docs/brush-architecture.md。
//
// **v99 schema (Krita-aligned)**：
// - **三个压感 coeff** (sizeCoeff / opaCoeff / flowCoeff)：−1..1，0=不响应，
//   1=满压感线性，−1=反向。`signed_lerp(coeff, p) = amp + (1−amp)×p (coeff≥0)`
//   or `1 − (1−amp)×p (coeff<0)`，其中 amp = 1−|coeff|。
// - **opacity × flow 永远相乘**（Krita 4.2 起的标准；之前是加算被当 bug 修了）。
// - **compositeMode** = stroke buffer 内重叠合成方式（per-brush 标志）：
//     "wash"    = Alpha Darken：buffer = max(buffer, α_dab) → 自交不变深、单笔有上限
//     "buildup" = source-over：累积，可达 1.0（喷枪 feel）
// - **opacity / flow 不存** preset：选 preset 时 toolState.opacity = 1, toolState.flow = 1
//   （user：「默认 opacity 默认 flow 两个字段不要，都是 1」）。user 自己拉 slider / brush settings 调。
// - **airbrush flag 没了**：buildup + opaCoeff=0 就是喷枪 feel，user 自己拉低 flow slider。
// - **pressureGamma**：p' = p^gamma，统一 power 曲线（默 1.0）。
// - **smooth**：per-preset 位置平滑参数（streamline / stabilization / pullStabilizer / motionFilter）。
//   v98 之前是全局 state.brush 上的，user：「smooth 没进笔刷，这个不是系统参数」。
//
// **不冻结字段**（user 当场调，不回写预设）：
//   size.base / color  + per-tool 的 opacity / flow
// **冻结字段**（显式「保存为预设」/「更新预设」才动）：
//   shape / coeffs / pressureGamma / compositeMode /
//   spacing / pixelMode / taper / hardness / 椭圆参数 / smudge / smooth

export const RACK_VERSION = 1;
export const DEFAULT_FOLDER = "我的常用";

export function newBrushId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "b-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function makeBrush({
  id = newBrushId(),
  name,
  tool,
  folder = DEFAULT_FOLDER,
  size = 12, sizeBaseMax = 200,
  sizeCoeff = 0.6, opaCoeff = 0.6, flowCoeff = 0,
  pressureGamma = 1.0,
  compositeMode = "wash",
  shapeKind = "round", aspect = 1.0, rotation = 0, hardness = 1.0,
  textureB64 = null,
  spacingValue = 0.06,
  pixelMode = false,
  taperIn = 0, taperOut = 0,
  smudge = null,
  // 位置平滑（per-brush，v99 起从 system 挪进 preset）
  streamline = 0.3, stabilization = 0, pullStabilizer = 0, motionFilter = 0,
}) {
  return {
    id, name, tool, folder,
    shape: { kind: shapeKind, aspect, rotation, hardness, textureB64 },
    size: { base: size, max: sizeBaseMax },
    sizeCoeff, opaCoeff, flowCoeff,
    pressureGamma,
    compositeMode,
    spacing: spacingValue,
    pixelMode,
    taper: { in: taperIn, out: taperOut },
    smudge,
    smooth: { streamline, stabilization, pullStabilizer, motionFilter },
  };
}

// 默认笔架——每工具一组开箱即用 preset。
// **stable ID**：以 "default-{tool}-{slug}" 形式固定。bump 时新 default 通过 id 比对
// merge 到用户 rack（不覆盖用户改过的 brush，但缺失的会补上）。
// **shapes 不在 rack 里**——shapes 工具复用 brush rack（getRackToolKey）。
const DEFAULTS_SPEC = [
  // 铅笔：sketch。opacity 压感主轴（轻=淡），flow 也略跟。Wash 让自交不变深。
  // size 6（user iPad 调）
  { id: "default-brush-pencil",   name: "铅笔",   tool: "brush",
    args: { size: 6, sizeBaseMax: 80, hardness: 0.5,
            sizeCoeff: 0.4, opaCoeff: 0.7, flowCoeff: 0.3,
            spacingValue: 0.06, compositeMode: "wash" } },
  // 勾线：强 size 压感，起末 stylistic taper。Wash。
  // hardness 0.5（user iPad 调；之前 1.0 太硬）
  { id: "default-brush-ink",      name: "勾线",   tool: "brush",
    args: { size: 6, sizeBaseMax: 60, hardness: 0.5,
            sizeCoeff: 0.8, opaCoeff: 0, flowCoeff: 0,
            spacingValue: 0.04, compositeMode: "wash",
            taperIn: 0.3, taperOut: 0.3 } },
  // 平涂：大笔填色，强 size 压感。Wash 单笔封顶（user.opacity slider 控）。
  // size 50 + sizeCoeff 1.0（user iPad 调；之前 24/0.8 太小不够灵敏）
  { id: "default-brush-fill",     name: "平涂",   tool: "brush",
    args: { size: 50, sizeBaseMax: 200, hardness: 1.0,
            sizeCoeff: 1.0, opaCoeff: 0, flowCoeff: 0,
            spacingValue: 0.06, compositeMode: "wash" } },

  // 大喷枪：size 固定（sizeCoeff=0）；flow 跟压感；Build-Up 可喷到 100%。
  // user 自己拉低 flow slider 当喷雾 feel。
  { id: "default-airbrush-big",   name: "大喷枪", tool: "brush",
    args: { size: 300, sizeBaseMax: 800, hardness: 0,
            sizeCoeff: 0, opaCoeff: 0, flowCoeff: 1.0,
            spacingValue: 0.05, compositeMode: "buildup" } },
  // 小喷枪：当 sketch 用，size 略跟压感。Build-Up。
  { id: "default-airbrush-small", name: "小喷枪", tool: "brush",
    args: { size: 16, sizeBaseMax: 200, hardness: 0.15,
            sizeCoeff: 0.4, opaCoeff: 0, flowCoeff: 1.0,
            spacingValue: 0.05, compositeMode: "buildup" } },

  // 涂抹（smudge）：sample + blend 走专用 path。
  { id: "default-smudge-soft",    name: "涂抹",   tool: "smudge",
    args: { size: 16, sizeBaseMax: 80, hardness: 0.6,
            sizeCoeff: 0.2, opaCoeff: 0, flowCoeff: 1.0,
            spacingValue: 0.06, compositeMode: "buildup",
            smudge: { strength: 0.8, dryness: 0.1 } } },

  // 硬橡皮：精修线稿，强 size 压感。Wash。
  // size 50 + opaCoeff 0（user iPad 调；之前 16 太小、opaCoeff 1.0 让轻压几乎擦不掉）
  { id: "default-eraser-hard",    name: "硬橡皮", tool: "eraser",
    args: { size: 50, sizeBaseMax: 100, hardness: 1.0,
            sizeCoeff: 0.8, opaCoeff: 0, flowCoeff: 0,
            spacingValue: 0.04, compositeMode: "wash" } },
  // 软橡皮：喷枪 eraser；Build-Up，flow 跟压感。
  { id: "default-eraser-soft",    name: "软橡皮", tool: "eraser",
    args: { size: 60, sizeBaseMax: 300, hardness: 0,
            sizeCoeff: 0, opaCoeff: 0, flowCoeff: 1.0,
            spacingValue: 0.05, compositeMode: "buildup" } },

  // 像素笔：1px stamps，无限硬，spacing 50%；pixelMode 整数 snap + 无 AA + 0 streamline。
  { id: "default-brush-pixel",    name: "像素笔", tool: "brush",
    args: { size: 4, sizeBaseMax: 64, hardness: 1.0,
            sizeCoeff: 0, opaCoeff: 0, flowCoeff: 0,
            spacingValue: 0.5, compositeMode: "wash",
            pixelMode: true,
            streamline: 0 } },
];

// IDB 老 schema 兼容（v82~v98 → v99）：
// - 老 spacing { kind, value } / size.pressureCurve / flow.pressureCurve / bufferMode / airbrush / opacity / flow.base / flow.min / size.min
// - v98 的 defaultOpa / defaultFlow 也删（user：「默认 opacity 默认 flow 两个字段不要，都是 1」）
// - v99 加 smooth 字段（user：「smooth 没进笔刷」）
export function migrateBrush(b) {
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
  // v98 defaultOpa / defaultFlow：删（toolState 选 preset 时硬编码 1.0）
  delete b.defaultOpa;
  delete b.defaultFlow;
  if (b.pressureGamma == null) b.pressureGamma = 1.0;
  // compositeMode：airbrush=true → buildup；否则 wash
  if (b.compositeMode == null) {
    b.compositeMode = b.airbrush ? "buildup" : "wash";
  }
  delete b.airbrush;
  delete b.bufferMode;
  // v99 smooth：之前在 system state.brush 上的 4 个字段挪进 preset
  if (!b.smooth) {
    b.smooth = { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 };
  }
  return b;
}

function specToBrush(spec) {
  return makeBrush({ id: spec.id, name: spec.name, tool: spec.tool, ...spec.args });
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
  if (!rack.activeByTool) { rack.activeByTool = {}; changed = true; }
  for (const spec of DEFAULTS_SPEC) {
    if (!rack.activeByTool[spec.tool]) {
      rack.activeByTool[spec.tool] = spec.id;
      changed = true;
    }
  }
  return changed;
}

// 序列化
export function rackToJSON(rack) {
  return JSON.stringify(rack, null, 2);
}
export function rackFromJSON(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== "object") throw new Error("rack JSON 格式不对");
  if (!Array.isArray(obj.brushes)) throw new Error("rack 缺 brushes");
  if (obj.version !== RACK_VERSION) {
    console.warn(`[brushes] rack version ${obj.version} ≠ ${RACK_VERSION}; 当 ${RACK_VERSION} 用`);
  }
  return obj;
}

// 单 brush export / import
export function brushToJSON(brush) {
  return JSON.stringify(brush, null, 2);
}
export function brushFromJSON(text) {
  const obj = JSON.parse(text);
  if (!obj.id || !obj.name || !obj.tool) throw new Error("brush JSON 缺必填字段");
  obj.id = newBrushId();
  migrateBrush(obj);
  return obj;
}

// 工具方法
export function findBrush(rack, id) {
  return rack.brushes.find((b) => b.id === id) || null;
}
// brush 工具池子包含 airbrush + shapes 老笔（共享 brush rack）
const BRUSH_GROUP = ["brush", "airbrush", "shapes"];
export function brushesByTool(rack, tool) {
  if (tool === "brush") {
    return rack.brushes.filter((b) => BRUSH_GROUP.includes(b.tool));
  }
  return rack.brushes.filter((b) => b.tool === tool);
}
export function brushesByFolder(rack, folder) {
  return rack.brushes.filter((b) => b.folder === folder);
}
export function getActiveBrush(rack, tool) {
  const id = rack.activeByTool?.[tool];
  return id ? findBrush(rack, id) : null;
}
