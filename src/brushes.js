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
// - **smooth**：per-preset 位置平滑参数（Procreate 两参：streamline / stabilization）。
//   v98 之前是全局 state.brush 上的，user：「smooth 没进笔刷，这个不是系统参数」。
//
// **不冻结字段**（user 当场调，不回写预设）：
//   size.base / color  + per-tool 的 opacity / flow
// **冻结字段**（显式「保存为预设」/「更新预设」才动）：
//   shape / coeffs / pressureGamma / compositeMode /
//   spacing / pixelMode / taper / hardness / 椭圆参数 / smudge / smooth

export const RACK_VERSION = 2;     // v2: brush 加 uat；rack 加 trash[]/resetAt；删 activeByTool（活动笔归 per-doc toolStates）。Folder shape，见 docs/folderflow-build-plan.md
export const DEFAULT_FOLDER = "我的常用";
// 迁移 / 出厂基准 uat：> resetAt(0) 故不被水位误丢；任何真实编辑(Date.now())必胜过它。
export const PRE_HISTORY_UAT = 1;

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
  // v102+: pressure low-pass filter（ms，时间域 IIR）
  // 解 "勾线转角顿一下 out-leg 变细" —— LPF 让落点过去几十毫秒的高 pressure 仍留尾巴
  pressureLPF = 0,
  compositeMode = "wash",
  blendMode = "source-over",   // v163: per-brush 混合模式（multiply/screen/... ＝ Canvas2D globalCompositeOperation）
  shapeKind = "round", aspect = 1.0, rotation = 0, hardness = 1.0,
  textureB64 = null,
  spacingValue = 0.06,
  pixelMode = false,
  taperIn = 0, taperOut = 0,
  smudge = null,
  // 位置平滑（per-brush，Procreate 两参，详 docs/brush-procreate-smoothing.md）
  streamline = 0.15, stabilization = 0,
  // v99r2：defaultOpa 留着，默认 1.0；user 编辑笔可以改成 0.6 当 sketch 默认
  defaultOpa = 1.0,
  // v2: last user-action-time —— FolderFlow 合并键（见 src/store/folder-merge.js）。
  uat = PRE_HISTORY_UAT,
}) {
  return {
    id, uat, name, tool, folder,
    shape: { kind: shapeKind, aspect, rotation, hardness, textureB64 },
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
    smudge,
    smooth: { streamline, stabilization },
  };
}

// 默认笔架——每工具一组开箱即用 preset。
// v122 r2：default-brushes.json 从 src/ 挪到根，改 runtime fetch（user：「async fetch，
// 什么时候拿到什么时候填，之前填空」）。SW precache 离线兜底；fetch 失败也不卡 boot。
// **stable ID**：以 "default-{tool}-{slug}" 形式固定。bump 时新 default 通过 id 比对
// merge 到用户 rack（不覆盖用户改过的 brush，但缺失的会补上）。
// **shapes 不在 rack 里**——shapes 工具复用 brush rack（getRackToolKey）。
let _defaultsSpec = [];      // fetch 回来前是空，回来后就是 default-brushes.json 内容
const _defaultsPromise = (async () => {
  try {
    const url = new URL("./default-brushes.json", document.baseURI).href;
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = await r.json();
    if (!Array.isArray(json)) throw new Error("default-brushes.json 不是数组");
    _defaultsSpec = json;
  } catch (e) {
    console.warn("[brushes] default-brushes.json 加载失败 → rack 走空兜底（emergency brush 顶上）。IDB 有的话照常用。", e);
    _defaultsSpec = [];
  }
  return _defaultsSpec;
})();
// 给 app.js 拿到这个 promise → boot 后 .then() retroactively merge
export function defaultsPromise() { return _defaultsPromise; }
export function getDefaultsSpec() { return _defaultsSpec; }

// fetch 失败 + IDB 也空时的兜底：至少一个能画的笔，UI 不挂。
function _emergencyBrush(uat = PRE_HISTORY_UAT) {
  return makeBrush({
    id: "emergency-brush", name: "默认笔", tool: "brush",
    size: 12, hardness: 0.8, sizeCoeff: 0.6, opaCoeff: 0.6, uat,
  });
}

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
  // v99 smooth：之前在 system state.brush 上的字段挪进 preset（v243 收成两参）
  if (!b.smooth) {
    b.smooth = { streamline: 0.15, stabilization: 0 };
  }
  // v2: 老笔无 uat → pre-history 基准（任何真实编辑都胜过它）
  if (b.uat == null) b.uat = PRE_HISTORY_UAT;
  return b;
}

function specToBrush(spec, uat = PRE_HISTORY_UAT) {
  return makeBrush({ id: spec.id, name: spec.name, tool: spec.tool, ...spec.args, uat });
}

// resetAt=0 → 首 boot（出厂笔 uat=PRE_HISTORY）；resetAt>0 → 恢复出厂
// （出厂笔 uat 须 > resetAt，否则刚重置就被自己的水位线丢掉）。
export function makeDefaultRack({ resetAt = 0 } = {}) {
  const uat = resetAt > 0 ? resetAt + 1 : PRE_HISTORY_UAT;
  let brushes = _defaultsSpec.map((s) => specToBrush(s, uat));
  if (brushes.length === 0) brushes = [_emergencyBrush(uat)];
  return { version: RACK_VERSION, brushes, trash: [], resetAt };
}

// 给 IDB 已有 rack 补缺：遍历 _defaultsSpec，缺哪个 ID 就 push 一份。
// v122 r2 改原子语义（user：「不是 merge，而是直接改数组 ref，这样就 atomic」）：
//   - 不 mutate 输入 rack
//   - 算完整新 rack（含原 brushes + 缺失 defaults），一次性返回
//   - 返回 null 表示不需要改 → caller 不 swap，省一次 UI 刷
//   - 返回新 rack 时 caller 做 `_brushRack = newRack` 单写 = atomic
// 注：_defaultsSpec 还空时（fetch 没回），返回 null = no-op；fetch 回来后 app.js 再调一次。
// 也承担 v1→v2 迁移：补 trash[]/resetAt、删 activeByTool、置 version。
export function mergeMissingDefaults(rack) {
  if (!rack || !Array.isArray(rack.brushes)) return null;
  const ids = new Set(rack.brushes.map((b) => b.id));
  const trashIds = new Set((rack.trash || []).map((t) => t.id));   // 已删的 default 不复活
  const missing = _defaultsSpec.filter((s) => !ids.has(s.id) && !trashIds.has(s.id));
  const needsFields = !Array.isArray(rack.trash) || rack.resetAt == null
    || rack.activeByTool != null || rack.version !== RACK_VERSION;
  if (missing.length === 0 && !needsFields) return null;
  const resetAt = rack.resetAt || 0;
  const uat = resetAt > 0 ? resetAt + 1 : PRE_HISTORY_UAT;
  const out = {
    ...rack,
    version: RACK_VERSION,
    brushes: [...rack.brushes, ...missing.map((s) => specToBrush(s, uat))],
    trash: Array.isArray(rack.trash) ? rack.trash : [],
    resetAt,
  };
  delete out.activeByTool;
  return out;
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
  if (!Array.isArray(obj.trash)) obj.trash = [];
  if (obj.resetAt == null) obj.resetAt = 0;
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
  // v132 filterBrush 是新工具类别，自己的 rack（不串到 brush）
  return rack.brushes.filter((b) => b.tool === tool);
}
export function brushesByFolder(rack, folder) {
  return rack.brushes.filter((b) => b.folder === folder);
}
// 某工具的「代表笔」——给 defaultToolStateFor 取初值。
// activeByTool 已废（v2：活动笔归 per-doc toolStates，见 docs/folderflow-build-plan.md §6）；
// 这里就取该工具第一支笔当默认。
export function defaultBrushForTool(rack, tool) {
  return brushesByTool(rack, tool)[0] || null;
}
