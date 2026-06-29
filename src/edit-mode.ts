// EditMode —— 独占编辑状态机，"我现在在什么编辑模式"的 SSoT。**单轴**。
//
// 设计定稿见 docs/20260531-tool-mode-state-machine.md，领域词见 CONTEXT.md (EditMode / Transient)。给下个 AI：
//
// - 命名：叫 EditMode 不叫 Mode，因为 "mode" 在本仓重载严重（L.mode 混合模式 / liquify.mode /
//   body.dataset.mode 图库 / blend mode）。EditMode = 当前处于哪种编辑模式。
// - **单轴**：current() 是一个 enum（CAPS 的 key）。持久工具（brush/eraser/lasso/...）和 transient
//   （transform/crop/adjust）平级，差别只是 transient 是"多 step、需 commit/cancel、ctrl-z=取消"那类。
// - **为什么不是双轴**：单轴让 current() 成为唯一公开主读取器 → 忘了考虑 transient 的代码 **fail-safe**
//   （拿到 "transform"，canDraw=false，不画），而非 fail-open（拿到底层 "brush" 而误触 stroke）。
//   transient 期间结构上不可能起 stroke → 没有杂散像素进 undo 栈 → 根除一整类 undo bleaching。
//   白送：工具按钮高亮 / slider 禁用 / 路由 全从 current() 干净派生（"transient 工具栏不高亮"正是发现双轴不行的契机）。
// - transient 结束回到的工具 = returnTo 覆盖 > 进来前那个持久工具(_returnTool) > brush 兜底。
//   _returnTool **只从持久 mode 捕获**（transient→transient 不覆盖），且**不对外暴露**（更彻底：外部只读 current()）。
// - 两个语义旋钮写在 CAPS（SSoT 定义语义，不硬编码）：onToolSwitch（点工具=apply/cancel）、returnTo。
// - 纯 in-process，谓词 O(1) 查表。单次手势进行中不是 transient——那是 PixelEdit 的 tx。

const FALLBACK_TOOL = "brush";   // returnTool 兜底

// 一条 mode 的能力描述。transient 专属的两个语义旋钮 onToolSwitch/returnTo 为可选。
interface Cap {
  canDraw: boolean;
  allowsColor: boolean;
  cursor: string;
  ctrlZ: string;
  transient: boolean;
  onToolSwitch?: string;
  returnTo?: string | null;
}
type EditModeName = keyof typeof CAPS;

// 进 transient 时携带的 apply/abort 闭包。
interface TransientHooks {
  apply: (() => void) | null;
  abort: (() => void) | null;
}

// 能力表 = 纯数据，一张 flat enum。新增滤镜/笔刷 effect = payload，不动此表（见 docs 两个 payload 家族）。
const CAPS: Record<string, Cap> = {
  // 持久·交互式 stamp 工具（brush-driven）：canDraw、笔刷 cursor、ctrlZ history、产 "stroke" PixelEdit。
  brush:       { canDraw: true,  allowsColor: true,  cursor: "brush", ctrlZ: "history",         transient: false },
  // eraser allowsColor:true（2026-06-06 user 改）：橡皮本身不吃 state.color，但禁用色板按钮**误导**
  //   （看着像坏了/弹不出来）。放开 = 橡皮时可预选下一笔颜色，免去 iPad 来回切工具。别改回 false。
  eraser:      { canDraw: true,  allowsColor: true,  cursor: "brush", ctrlZ: "history",         transient: false },
  filterBrush: { canDraw: true,  allowsColor: false, cursor: "brush", ctrlZ: "history",         transient: false }, // liquify/色彩笔 = payload
  liquify:     { canDraw: true,  allowsColor: false, cursor: "ring",  ctrlZ: "history",         transient: false },
  // 非绘画持久工具
  picker:      { canDraw: false, allowsColor: true,  cursor: "none",  ctrlZ: "history",         transient: false },
  lasso:       { canDraw: false, allowsColor: true,  cursor: "none",  ctrlZ: "history",         transient: false },
  hand:        { canDraw: false, allowsColor: false, cursor: "grab",  ctrlZ: "history",         transient: false },
  // 半模态 transient（多 step、commit/cancel、ctrl-z=取消）。canDraw=false → 期间不可能起 stroke。
  //   onToolSwitch: 期间点别的工具 = "apply"(commit) 还是 "cancel" 这个 transient
  //   returnTo:     commit/cancel 按钮 + 非工具决定性动作落到哪个工具；null = 回到进来前那个持久工具
  transform:   { canDraw: false, allowsColor: false, cursor: "none",  ctrlZ: "abort-transient", transient: true, onToolSwitch: "apply", returnTo: null },
  crop:        { canDraw: false, allowsColor: false, cursor: "none",  ctrlZ: "abort-transient", transient: true, onToolSwitch: "apply", returnTo: null },
  adjust:      { canDraw: false, allowsColor: false, cursor: "none",  ctrlZ: "abort-transient", transient: true, onToolSwitch: "apply", returnTo: null },
};
const FALLBACK = CAPS.brush;

export class EditMode {
  _current: string;
  _returnTool: string;
  _transient: TransientHooks | null;

  constructor({ initialTool = "brush" }: { initialTool?: string } = {}) {
    this._current = initialTool;      // 单轴：当前 mode（CAPS key）
    this._returnTool = initialTool;   // transient 结束回到的持久 tool（内部，只从持久 mode 捕获）
    this._transient = null;           // 当前 transient 的 { apply, abort }（仅 transient 时非 null）
  }

  // ---- 当前身份 + 谓词（O(1) 查表）----
  current() { return this._current; }
  _cap()    { return CAPS[this._current] || FALLBACK; }
  isTransient()      { return this._cap().transient; }
  canDraw()          { return this._cap().canDraw; }       // 该模式准不准动 layer 像素（层可见性另在 seam 查）
  allowsColor()      { return this._cap().allowsColor; }   // color 面板/slider 是否相关
  cursor()           { return this._cap().cursor; }        // "brush"|"ring"|"grab"|"none"
  showsBrushCursor() { return this._cap().cursor === "brush"; }
  ctrlZMeans()       { return this._cap().ctrlZ; }         // "history" | "abort-transient"

  // transient 结束进哪个工具：returnTo 覆盖 > 进来前持久工具 > brush 兜底。读 _cap() 须在改 _current 前调。
  _targetTool() { return this._cap().returnTo || this._returnTool || FALLBACK_TOOL; }

  // ---- 切持久工具 ----
  // 切工具 = 用户决定性动作。transient 期间按该 transient 的 onToolSwitch 语义 apply/cancel 它，再进点的工具。
  setTool(tool: string) {
    if (this.isTransient()) {
      this._clearTransient(this._cap().onToolSwitch === "cancel" ? "abort" : "apply");
      this._current = tool; this._returnTool = tool; this._emit();
      return;
    }
    if (this._current === tool) return;
    this._current = tool; this._returnTool = tool; this._emit();
  }

  // ---- transient ----
  // 进 transform/crop/adjust。_returnTool 只从持久 mode 捕获（transient→transient 先 apply 旧的，不覆盖）。
  enterTransient(name: string, { apply = null, abort = null }: Partial<TransientHooks> = {}) {
    if (!this.isTransient()) this._returnTool = this._current;
    this._clearTransient("apply");      // silent；下面统一 emit 一次
    this._current = name;
    this._transient = { apply, abort };
    this._emit();
  }
  // commit 后正常退（调用方已自行 commit，这里只回 _targetTool，不调 apply/abort）。
  exitTransient() {
    if (!this.isTransient()) return;
    const target = this._targetTool();
    this._transient = null;
    this._current = target;
    this._emit();
  }
  // 非工具决定性动作（save/进图库/...）：always apply（要烤进再持久化），回 _targetTool。
  applyPendingTransient() {
    if (!this.isTransient()) return;
    const target = this._targetTool();
    this._clearTransient("apply");
    this._current = target;
    this._emit();
  }
  // ctrl-z / cancel：abort 当前 transient，回 _targetTool。
  abortTransient() {
    if (!this.isTransient()) return;
    const target = this._targetTool();
    this._clearTransient("abort");
    this._current = target;
    this._emit();
  }
  hasPendingTransient() { return this.isTransient(); }

  // 内部：跑当前 transient 的 apply|abort，清 _transient，**不改 _current、不 emit**（调用方决定）。
  // 先清字段再跑闭包，防闭包内重入看到旧 transient。返回是否确有动作。
  _clearTransient(action: string) {
    const t = this._transient;
    if (!t) return false;
    this._transient = null;
    try { (action === "abort" ? t.abort : t.apply)?.(); }
    catch (e) { console.warn(`[edit-mode] transient ${action} failed:`, e); }
    return true;
  }

  // 每次状态变 → emit。UI 监听重新派生：工具按钮高亮(current)、slider 禁用(!canDraw/!allowsColor)、cursor。
  _emit() {
    window.dispatchEvent(new CustomEvent("wp:modechange", {
      detail: { mode: this._current, transient: this.isTransient() },
    }));
  }
}
