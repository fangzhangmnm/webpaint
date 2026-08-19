// 职责（单一）：管理笔架——预设存储（store.collection：逐 brush 一 item + 一条 .meta）、
//   笔架 sheet UI、笔设置编辑器、以及「活动预设 ↔ 每工具 dial 状态」的绑定。
//
// v2 重构（2026-07）：从旧 BrushRack god-class（IDB getMeta + no-op cloud stub）迁到 store.collection。
//   持久化 / 云同步 / 冲突 / 墓碑 全归 collection（红线在库内）；本类只做 app 层编排：
//   活动预设绑定、sheet chrome、设置编辑器 draft 生命周期、10 条命令（import/export/select/apply/
//   revert=reconcile/reset-builtin/new/delete/rename/move-to-folder）。**手感数值/公式全在 brushes.ts
//   与 resolved-brush.ts，本类一个数字不碰。**
//
// 反应式接线（v415 重做，消费方 currentBrush computed 靠此重算）：
//   笔架内容的**唯一反应式来源 = _brushesRef / _metaRef 两个 shallowRef**，
//   而它们的**唯一写入点 = collection.onChange**（本地写和云端写 store 一视同仁，见 collection.ts）。
//   → 依赖关系就是数据本身，结构上不可能"忘了通知"。
//
//   v415 前是手动计数器 dialReactive.rackVersion：12 处 `rackVersion++` + 3 处 `void rackVersion` 建依赖。
//   漏 bump 一处 = 改了笔但界面/引擎不更新（"功能不响应"级 bug，且 boot-smoke 抓不到）。已全部删除。

import { reactive, shallowRef } from "../vendor/vue/vue.esm-browser.prod.js";
import {
  defaultBrushForTool, brushesByTool, findBrush, newBrushId, brushFromJSON,
  makeBrush, loadBuiltinBrushes, getAllBrushes, getMeta, metaAppend, metaRemove, metaMove,
  metaPrependBuiltins, RACK_META_ID, DEFAULT_FOLDER,
  type RackMeta,
} from "./brushes.ts";
// resolveRef 内联（brush ref 解析：先 id 后 name 兜底；折 folder-merge 依赖）。
function resolveRef<T extends { id?: unknown; name?: unknown }>(list: T[], ref: { id?: unknown; name?: unknown }): T | null {
  return list.find((x) => ref.id != null && x.id === ref.id) ?? list.find((x) => ref.name != null && x.name === ref.name) ?? null;
}
import { collectFolders } from "./brush-rack-view.ts";
import { mountRackSheet } from "./ui/rack-sheet.ts";
import { mountBrushSettings } from "./ui/brush-config-view.ts";
import { exportBrush, exportRackFolder, buildRackCode, shareOrDownloadJSON } from "./brush-io.ts";
import type { Brush, BrushRackData } from "./brush-types.ts";
import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";
import type { EditMode } from "./edit-mode.ts";
import type { Collection } from "./app-store.ts";   // B2：类型经接缝转口
import { t } from "./i18n/index.ts";
import { reportError } from "./error-badge.ts";

// 惰性（不在模块 eval 期调 t()——那时 boot 门的 lang 还没 hydrate）：按 tool 现取标签。
const toolLabel = (tool: string): string => tool === "eraser" ? t("br.toolEraser") : tool === "brush" ? t("br.toolBrush") : (tool === "lasso" || tool === "fill") ? t("la.penSub") : tool;

// 构造期依赖（早于 SSoT 块构造，故 editMode 走 thunk 避 TDZ；DOM/icons/panels 等晚绑走 init()）。
export interface BrushRackDeps {
  collection: Collection;     // store.collection("brush-rack")：持久化 + 云同步唯一入口（红线在库内）
  state: EditorRuntimeState;  // 共享 SSoT（state.toolStates 反应式）
  dialReactive: DialReactive; // 共享 SSoT（当前 tool）
  editMode: () => EditMode;   // thunk：构造时 editMode 尚未定义
  setStatus: (text: string, persist?: boolean) => void;   // 第二参 = persist（消息是否常驻）
  confirm: (title: string, msg: string) => Promise<boolean>;
  openExclusive: (id: string) => void;
  closeExclusive: () => void;
  registerPanel: (id: string, h: { show: () => void; hide: () => void }) => void;
  isSignedIn: () => boolean;
  isOnline: () => boolean;
}
// init() 晚绑：DOM els + blendModes + panel 映射（这些常量定义在 app.ts 后段）。
interface RackEls {
  mount: HTMLElement; title: HTMLElement; sheet: HTMLElement; close: HTMLElement;
  newBtn: HTMLElement; importBtn: HTMLElement;
  refreshBtn?: HTMLElement; exportFolderBtn?: HTMLElement; resetBtn?: HTMLElement; dumpCodeBtn?: HTMLElement;
}
interface SettingsEls { view: HTMLElement; body: HTMLElement; save: HTMLElement; cancel: HTMLElement; }
export interface BrushRackUI {
  els: { rack: RackEls; settings: SettingsEls };
  blendModes: Record<string, string>;
  RACK_PANEL_BY_TOOL: Record<string, string>;
}

export class BrushRackController {
  // UI 字段（BrushRackUI）由 init() 晚绑 Object.assign 进来 → 构造期 cast 一次记录此事实，余处全类型化。
  d: BrushRackDeps & BrushRackUI;
  ui: { tool: string; folder: string };
  _editingId: string | null = null;
  _editingDraft: Brush | null = null;
  _bulkWrite = false;                 // 批量 setItem 期间压住 onChange（收尾统一刷一次），见 resetBuiltin
  _settingsUI: ReturnType<typeof mountBrushSettings> | null = null;

  constructor(deps: BrushRackDeps) {
    this.d = deps as BrushRackDeps & BrushRackUI;
    this.ui = reactive({ tool: "brush", folder: DEFAULT_FOLDER });
  }

  // 笔架内容的反应式镜像。**唯一写入点 = _syncFromCollection（只由 collection.onChange 与 load 调）**。
  //   读这两个 ref 就自动建立 Vue 依赖 → 不需要任何手动 bump。
  _brushesRef = shallowRef<Brush[]>([]);
  _metaRef = shallowRef<RackMeta>({ order: {} } as RackMeta);
  _syncFromCollection() {
    this._brushesRef.value = getAllBrushes(this.d.collection);
    this._metaRef.value = getMeta(this.d.collection);
  }
  // 瞬态 rack 视图（给 brushes.ts 的 { brushes } 型 helper 复用）——现在读的是反应式镜像。
  _view(): BrushRackData { return { brushes: this._brushesRef.value }; }
  _meta(): RackMeta { return this._metaRef.value; }
  get(): BrushRackData { return this._view(); }

  // ---- 预设存储：collection.init（本地 hydrate → 后台 reconcile + 新库 seed）----
  // **幂等**：memo 住首次 load 的 promise。boot 是 fire-and-forget 的，用户可能在它 resolve 前
  //   就点了「还原内置笔刷」——那时 collection.setItem 会抛「在 init() 前调用」。所以写路径先 await load()。
  _loadPromise: Promise<BrushRackData> | null = null;
  load(): Promise<BrushRackData> { return (this._loadPromise ??= this._load()); }
  async _load(): Promise<BrushRackData> {
    await this.d.collection.init();
    this.subscribeToCollection();
    this._syncFromCollection();   // collection.init 的 hydrate 发生在订阅之前 → 首帧手动灌一次
    // 自愈：collection **存在但一支笔都没有**（store 的 seed 只认 idb 有无、不认空——
    //   历史上被空 seed / emergency-only 腌坏的库，或用户把笔全删了）→ 自动补回内置笔。
    //   只在**完全空**时触发，不会跟「用户故意删掉某几支内置笔」打架。
    await this._healEmptyRack();
    this.applyToolState(this.d.editMode().current());
    return this.get();
  }

  // ---- 空笔架自愈（会话内持续重试）----
  // 为什么不是「补一次不行就算了、等下次开 app」：新用户首开如果正好离线 / json 还没缓上，
  //   笔架就是空的，而他**根本不知道**要去调试菜单点「还原内置笔刷」——等于 app 开箱即坏。
  //   所以失败不认命：退避重试 + online 事件重试，直到笔架有笔为止。
  // 静默（reportError 走 log 不弹 banner）：首开离线是良性场景，不该糊用户一脸红条；
  //   用户**手点**还原时才 surface（那是他主动发起的动作，必须给回音）。
  _healTimer: ReturnType<typeof setTimeout> | null = null;
  _healAttempt = 0;
  _healOnline: (() => void) | null = null;
  static HEAL_DELAYS_MS = [1000, 3000, 8000, 20000, 60000];   // 末项反复（空笔架 = app 不可用，值得一直试）

  async _healEmptyRack(): Promise<void> {
    if (this._brushesRef.value.length > 0) return this._stopHeal();   // 已经有笔（含用户自己新建/云端拉到）
    const n = await this._restoreBuiltins(true);
    if (n > 0) return this._stopHeal();
    this._scheduleHeal();
  }
  _scheduleHeal(): void {
    if (this._healTimer != null) return;
    const D = BrushRackController.HEAL_DELAYS_MS;
    const delay = D[Math.min(this._healAttempt++, D.length - 1)];
    this._healTimer = setTimeout(() => { this._healTimer = null; void this._healEmptyRack(); }, delay);
    // node 测试里别把进程吊住（浏览器返回 number，没有 unref）
    (this._healTimer as unknown as { unref?: () => void })?.unref?.();
    if (!this._healOnline && typeof addEventListener === "function") {
      this._healOnline = () => { void this._healEmptyRack(); };   // 联网即刻重试，不等退避
      addEventListener("online", this._healOnline);
    }
  }
  _stopHeal(): void {
    if (this._healTimer != null) { clearTimeout(this._healTimer); this._healTimer = null; }
    if (this._healOnline && typeof removeEventListener === "function") {
      removeEventListener("online", this._healOnline);
      this._healOnline = null;
    }
    this._healAttempt = 0;
  }

  /** collection → 笔架的**唯一**绑定。本地写和云端写在 store 层已一视同仁，这里也不分。
   *  放在 load()（数据层）而非 init()（要 DOM）：绑定与 UI 无关，且这样才能 node 测。 */
  subscribeToCollection() {
    this.d.collection.onChange((ids: string[]) => {
      if (this._bulkWrite) return;                 // 批量写（resetBuiltin）自己在收尾统一刷一次
      // ★镜像**必须**先刷，且不受下面两个守卫管辖：
      //   守卫管的是「要不要动 toolState」，镜像管的是「笔架内容是什么」。
      //   v415 初版把这行漏了 → 编辑保存/新建/删除/导入/云端拉取全都不刷新笔架和引擎
      //   （改了笔按保存却没效果）。正是本文件头部声称已结构性杜绝的那类 bug。
      this._syncFromCollection();
      const onlyMeta = ids.length > 0 && ids.every((id) => id === RACK_META_ID);
      if (this._editingId == null && !onlyMeta) this.applyToolState(this.d.editMode().current());
    });
  }
  // 事件驱动重拉云端（刷新按钮 / 前台）。
  reconcileWithRemote() { return this.d.collection.reconcileWithRemote(); }   // 返 ReconcileResult：调用方须读 status（v436）

  // ---- 活动预设 ↔ tool dial 绑定 ----
  // shapeBrush alias 到 brush（ADR-0005）：形状笔共享笔架 + 共享当前笔/dial，零自有 toolState 持久化
  // v0.7.26 选区笔走笔架（user：「笔架不是有滤镜笔画画笔橡皮笔吗，加一个选区笔就行了」）：
  //   lasso/fill 模式的 rack key = "selPen"（第四个 rack 工具类别；子工具 pen 消费 currentBrush，
  //   其余子工具不吃笔——映射无副作用）
  getRackToolKey(tool: string) {
    if (tool === "airbrush" || tool === "shapeBrush") return "brush";
    if (tool === "lasso" || tool === "fill") return "selPen";
    return tool;
  }
  defaultToolStateFor(tool: string) {
    const brush = defaultBrushForTool(this._view(), tool);
    if (brush) return { size: brush.size.base, opacity: 1.0, activeBrushId: brush.id, activeBrushName: brush.name };
    return { size: 12, opacity: 1.0, activeBrushId: null, activeBrushName: null };
  }
  // healing 回写版（显式路径用）
  findToolBrush(ts: ToolDial | null | undefined) {
    if (!ts) return null;
    const b = resolveRef(this._brushesRef.value, { id: ts.activeBrushId, name: ts.activeBrushName }) as Brush | null;
    if (b) { ts.activeBrushId = b.id; ts.activeBrushName = b.name; }
    return b;
  }
  // 纯查找（currentBrush computed 用：computed 内绝不可写 reactive）
  findToolBrushPure(ts: ToolDial | null | undefined) {
    if (!ts) return null;
    // 读镜像 = 建立反应式依赖（currentBrush computed 靠这条重算）。**只读不写**——computed 内绝不可写 reactive。
    return resolveRef(this._brushesRef.value, { id: ts.activeBrushId, name: ts.activeBrushName }) as Brush | null;
  }
  // v0.6.14 缺笔自愈（纯派生，**不回写 dial**）：dial 指的笔 id+name 都解析不到（被删/还没 sync 到）
  //   → 当前笔退到该工具默认笔，保证引擎吃到的是笔架里真实存在的笔（而非 DEFAULT_CONFIG 幽灵笔）。
  //   不回写是有意的：存档里的 activeBrushId 保持原样，缺的笔从云端 sync 回来那一刻自动复原。
  //   空笔架（还没 hydrate / 真空）→ null，交给 resolveBrush 的 DEFAULT 兜底 + _healEmptyRack。
  resolveActiveBrushPure(ts: ToolDial | null | undefined, tool: string) {
    return this.findToolBrushPure(ts)
      ?? (defaultBrushForTool(this._view(), this.getRackToolKey(tool)) as Brush | null);
  }
  applyToolState(tool: string) {
    const key = this.getRackToolKey(tool);
    const ts = this.d.state.toolStates[key];
    if (!ts) return;
    if (ts.activeBrushId == null) Object.assign(ts, this.defaultToolStateFor(key));
    this.findToolBrush(ts);
  }
  writeCurrentToolSize(v: number) {
    const ts = this.d.state.toolStates[this.getRackToolKey(this.d.editMode().current())];
    if (ts) ts.size = v;
  }
  writeCurrentToolOpacity(v: number) {
    const ts = this.d.state.toolStates[this.getRackToolKey(this.d.editMode().current())];
    if (ts) ts.opacity = v;
  }
  selectBrushPresetForTool(tool: string, brushId: string) {
    const key = this.getRackToolKey(tool);
    const ts = this.d.state.toolStates[key];
    if (!ts) return;
    const brush = findBrush(this._view(), brushId);
    if (!brush) return;
    ts.activeBrushId = brushId;
    ts.activeBrushName = brush.name;
    ts.size = brush.size.base;
    ts.opacity = brush.defaultOpa ?? 1.0;
    if (key === this.getRackToolKey(this.d.editMode().current())) this.applyToolState(this.d.editMode().current());
  }

  // ---- 笔架 sheet ----
  showSheet(tool: string) {
    this.ui.tool = tool;
    const folders = collectFolders(brushesByTool(this._view(), this.getRackToolKey(tool)), DEFAULT_FOLDER);
    if (!folders.includes(this.ui.folder)) this.ui.folder = folders[0] || DEFAULT_FOLDER;
    this.d.els.rack.title.textContent = t("br.rackTitle", { tool: toolLabel(tool) });
    this.d.els.rack.sheet.classList.remove("hidden");
  }
  hideSheet() {
    this.d.els.rack.sheet.classList.add("hidden");
    void this.d.collection.flushLocal();   // 卸载兜底：内存 env 立即落本地缓存（云推由 collection 自持防抖 / reconcile 兜底）
  }

  // ---- 还原内置笔刷（**非破坏性**）：内置笔逐 setItem 覆盖同 id（uat=now 胜过任何用户改动），
  //   **不删任何用户笔**；.meta 里把内置 id 提到各 folder 最前。取代旧 makeDefaultRack 全量抹除。
  //   返回还原了几支；**0 = 失败**（内置笔数据没加载到，已 surface）——调用方据此报真话，别谎报成功。----
  async restoreBuiltins(): Promise<number> {
    await this.load();            // boot 未 resolve 就点按钮 → 否则 setItem 抛「在 init() 前调用」
    const n = await this._restoreBuiltins();
    if (n === 0) this._scheduleHeal();   // 手点也失败了 → 挂上后台重试，用户不必自己盯着再点
    return n;
  }
  /** @param silent 后台自愈用：失败只 log，不弹 banner（首开离线是良性场景）。 */
  async _restoreBuiltins(silent = false): Promise<number> {
    const builtins = await loadBuiltinBrushes();
    if (!builtins) {
      // 兜底的 emergency 笔**不写库**（会被推上云、污染所有设备）。如实报错，让用户知道该重试/联网。
      reportError(new Error("[rack] builtin brush data failed to load (offline, or site missing builtin-brushes.json); this restore was cancelled."),
                  silent ? "log" : "warning");
      return 0;
    }
    // 批量写：collection 现在每次 setItem 都 fire onChange（本地写也通知）。~60 支笔逐条刷 = 60 次
    //   applyToolState + 60 次镜像刷新。压住信号，收尾统一刷一次。
    this._bulkWrite = true;
    try {
      for (const b of builtins) this.d.collection.setItem(b.id, b);
      const byFolder: Record<string, string[]> = {};
      for (const b of builtins) (byFolder[b.folder || DEFAULT_FOLDER] ||= []).push(b.id);
      this.d.collection.setItem(RACK_META_ID, metaPrependBuiltins(this._meta(), byFolder));
    } finally { this._bulkWrite = false; }
    this._syncFromCollection();   // 批量写期间压住了 onChange → 收尾统一刷一次镜像
    this.applyToolState(this.d.editMode().current());
    return builtins.length;
  }

  _nextBrushName() {
    // 序号扫描按**当前语言**的新笔前缀（名字是数据，不跨语言迁移；换语言从 1 重新起序无害）
    const base = t("name.brushBase").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${base}\\s*(\\d+)$`);
    let max = 0;
    for (const b of getAllBrushes(this.d.collection)) { const m = re.exec(b.name); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    return t("name.newBrushN", { n: max + 1 });
  }
  // v232 (user：「新建笔从当前 active 笔拷贝，名字也从原名派生」)：「水彩」→「水彩 2」→「水彩 3」。
  // 去掉原名尾部数字得 base，扫全架同 base 的最大序号 +1（base 本身算 1）。
  _deriveBrushName(srcName: string) {
    const base = String(srcName || "").replace(/\s*\d+$/, "").trim() || t("name.brushBase");
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\d+)$`);
    let max = 1;
    for (const b of getAllBrushes(this.d.collection)) {
      const m = re.exec(b.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${base} ${max + 1}`;
  }

  // ---- 笔设置编辑器（draft → 存才落 collection）----
  openBrushSettings(brushId: string, newDraft?: Brush) {
    let draft: Brush;
    if (newDraft) draft = newDraft;
    else { const b = findBrush(this._view(), brushId); if (!b) return; draft = JSON.parse(JSON.stringify(b)); }
    this._editingId = brushId;
    this._editingDraft = draft;
    this._settingsUI!.open(draft);
    this.d.els.settings.view.classList.remove("hidden");
  }
  closeBrushSettings(save: boolean) {
    if (save && this._editingDraft) {
      const draft = this._editingDraft;
      this.d.collection.setItem(draft.id, draft);        // 逐 item 写；uat 由 collection 内部盖戳
      this._ensureMetaPlacement(draft.id, draft.folder || DEFAULT_FOLDER);   // 新建 → 追加；改了 folder → 移动；原地 → no-op
      const targetTool = this.d.editMode().current() === "airbrush" ? "brush" : draft.tool;
      if (this.getRackToolKey(this.d.editMode().current()) === this.getRackToolKey(targetTool)) {
        this.selectBrushPresetForTool(this.d.editMode().current(), draft.id);
      } else {
        this.selectBrushPresetForTool(targetTool, draft.id);
      }
      this.d.setStatus(t("br.saved", { name: draft.name }));
    }
    this._editingId = null;
    this._editingDraft = null;
    this._settingsUI!.close();
    this.d.els.settings.view.classList.add("hidden");
  }
  // 确保 id 恰好落在 target folder（不在别处）。已就位 → 不写（免无谓 .meta 同步 / 假冲突）。
  _ensureMetaPlacement(id: string, folder: string) {
    const meta = this._meta();
    const inTarget = (meta.order[folder] || []).includes(id);
    const elsewhere = Object.entries(meta.order).some(([f, l]) => f !== folder && l.includes(id));
    if (inTarget && !elsewhere) return;
    this.d.collection.setItem(RACK_META_ID, metaMove(meta, id, folder));
  }
  async deleteEditingBrush() {
    const b = this._editingDraft;
    if (!b || this._editingId == null) return;
    if (!(await this.d.confirm(t("br.deleteBrushTitle"), t("br.deleteBrushMsg", { name: b.name })))) return;
    const id = this._editingId;
    this.d.collection.deleteItem(id);                                   // null 墓碑（LWW；跨设备传播删除）
    this.d.collection.setItem(RACK_META_ID, metaRemove(this._meta(), id));
    this._editingId = null;
    this._editingDraft = null;
    this._settingsUI!.close();
    this.d.els.settings.view.classList.add("hidden");
    // 删的若正是当前活动笔，toolState 还指着这个死 id。上面两次 setItem 都发生在 _editingId 清空**前**，
    //   被 onChange 的编辑期守卫挡掉了 → 必须在这里显式补一次自愈，否则笔要到下次别的事件才恢复。
    this.applyToolState(this.d.editMode().current());
    this.d.setStatus(t("br.deleted"));
  }

  // move-to-folder 命令（当前无 UI 触发；方法暴露给将来 sheet 的「移动到」）。
  moveBrushToFolder(id: string, folder: string) {
    const b = findBrush(this._view(), id);
    if (!b) return;
    this.d.collection.setItem(id, { ...b, folder });
    this.d.collection.setItem(RACK_META_ID, metaMove(this._meta(), id, folder));
  }

  // ---- 装配：mount sheet/settings 组件 + 注册 panel + 绑 DOM 事件 + 订阅云变 ----
  init(ui: BrushRackUI) {
    Object.assign(this.d, ui);   // 晚绑 els/blendModes/RACK_PANEL_BY_TOOL
    const els = this.d.els.rack, sEls = this.d.els.settings;

    // rack-sheet Vue 组件
    mountRackSheet(els.mount, {
      defaultFolder: DEFAULT_FOLDER,
      getBrushes: () => brushesByTool(this._view(), this.getRackToolKey(this.ui.tool)),
      getRackEmpty: () => this._brushesRef.value.length === 0,
      getFolder: () => this.ui.folder,
      getActiveId: () => this.d.state.toolStates[this.getRackToolKey(this.ui.tool)]?.activeBrushId ?? null,
      onSelectFolder: (f: string) => { this.ui.folder = f; },
      onSelectBrush: (id: string) => { this.selectBrushPresetForTool(this.ui.tool, id); this.d.closeExclusive(); },
      onEditBrush: (id: string) => { this.d.closeExclusive(); this.openBrushSettings(id); },
      onReset: async () => {
        const n = await this.restoreBuiltins();
        this.d.setStatus(n ? t("br.rackRestored", { n }) : t("br.rackRestoreFailed"), true);
      },
    });

    // brush-settings 编辑器 Vue 组件
    this._settingsUI = mountBrushSettings(sEls.body, {
      blendModes: this.d.blendModes,
      onDelete: () => this.deleteEditingBrush(),
      onExport: () => { if (this._editingDraft) exportBrush(this._editingDraft); },
    });

    // collection.onChange = 笔架的**唯一**变更信号（本地 setItem 与云端 pull 一视同仁，store 刻意不给区分度）。
    //   → 刷 sheet/currentBrush + 补活动笔。
    // ⚠ 两个守卫都是**载重**的，不是巧合，别删：
    //   ① _editingId != null（笔设置编辑中）→ 不碰 toolState，免打扰用户正在改的 draft。
    //      closeBrushSettings 里 setItem 先发生、_editingId 后清，靠的就是这条挡住重入自打扰。
    //   ② 只有 .meta 变（纯排序/归夹）→ 活动笔不可能受影响，跳过 applyToolState。
    // （collection.onChange 的订阅已挪进 load()——它是**数据层**绑定，不该埋在要 DOM 的 init 里，
    //   而且埋在这里就没法 node 测。见 load()。）

    // 注册 exclusive panel（多 tool → 同 panel id 去重，第一个赢）
    const registered = new Set<string>();
    for (const tool of Object.keys(this.d.RACK_PANEL_BY_TOOL)) {
      const id = this.d.RACK_PANEL_BY_TOOL[tool];
      if (registered.has(id)) continue;
      registered.add(id);
      this.d.registerPanel(id, { show: () => this.showSheet(tool), hide: () => this.hideSheet() });
    }

    // DOM 事件
    els.close.addEventListener("click", () => this.d.closeExclusive());
    els.newBtn.addEventListener("click", () => this._onNewBrush());
    els.importBtn.addEventListener("click", () => this._onImport());
    sEls.save.addEventListener("click", () => this.closeBrushSettings(true));
    sEls.cancel.addEventListener("click", () => this.closeBrushSettings(false));
    if (els.exportFolderBtn) els.exportFolderBtn.addEventListener("click", async () => {
      const n = await exportRackFolder(this._view(), this.ui.tool, this.ui.folder);
      this.d.setStatus(n ? t("br.folderExported", { folder: this.ui.folder, n }) : t("br.folderEmpty"), !n);
    });
    if (els.refreshBtn) els.refreshBtn.addEventListener("click", async () => {
      this.d.setStatus(t("br.refreshing"));
      // 读 status，别只 await（v436）：以前这里没有任何终态提示，离线/被拒/推失败
      //   全都表现为「正在刷新…」永远挂着。
      const r = await this.reconcileWithRemote();
      const bad = r.status === "offline" || r.status === "invalid" || r.status === "dirty" || r.status === "error";
      this.d.setStatus(bad ? t("br.refreshFailed", { status: r.status }) : t("br.refreshed"), bad);
    });
    if (els.resetBtn) els.resetBtn.addEventListener("click", async () => {
      if (!(await this.d.confirm(t("br.resetRackTitle"), t("br.resetRackMsg")))) return;
      const n = await this.restoreBuiltins();
      this.d.setStatus(n ? t("br.rackRestored", { n }) : t("br.rackRestoreFailed"), true);
    });
    if (els.dumpCodeBtn) els.dumpCodeBtn.addEventListener("click", async () => {
      await shareOrDownloadJSON(new Blob([buildRackCode(this._view())], { type: "text/javascript" }), "builtin-brushes.js", t("rack.shareTitle"));
      this.d.setStatus(t("br.codeExported", { n: getAllBrushes(this.d.collection).length }));
    });
  }

  _onNewBrush() {
    const activeId = this.d.state.toolStates[this.getRackToolKey(this.ui.tool)]?.activeBrushId;
    const all = getAllBrushes(this.d.collection);
    let source = activeId ? findBrush(this._view(), activeId) : null;
    if (!source) {
      const inFolder = (brushesByTool(this._view(), this.ui.tool) as Brush[]).filter((b) => (b.folder || DEFAULT_FOLDER) === this.ui.folder);
      source = inFolder[0] || all[0] || null;
    }
    let newB: Brush;
    if (source) {
      newB = JSON.parse(JSON.stringify(source));
      newB.id = newBrushId();
      newB.name = this._deriveBrushName(source.name);
      newB.folder = this.ui.folder;
      newB.tool = this.ui.tool;
    } else {
      newB = makeBrush({ id: newBrushId(), name: this._nextBrushName(), tool: this.ui.tool, folder: this.ui.folder });
    }
    newB.creation_time = Date.now();   // 新建/复制笔一瞬（作者签名参考；不进同步机制）
    this.d.closeExclusive();
    this.openBrushSettings(newB.id, newB);   // 存才落 collection（closeBrushSettings save → setItem + .meta append）
  }
  _onImport() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.style.display = "none";
    inp.addEventListener("change", async () => {
      const file = inp.files?.[0];
      if (!file) return;
      try {
        const b = brushFromJSON(await file.text()) as Brush;
        b.folder = this.ui.folder;
        b.tool = this.ui.tool;
        b.creation_time = Date.now();
        this.d.collection.setItem(b.id, b);
        this.d.collection.setItem(RACK_META_ID, metaAppend(this._meta(), b.folder || DEFAULT_FOLDER, b.id));
          this.d.setStatus(t("br.imported", { name: b.name }));
      } catch (e) { this.d.setStatus(t("br.importFailed", { error: String((e as { message?: unknown })?.message || e) }), true); }
      document.body.removeChild(inp);
    });
    document.body.appendChild(inp);
    inp.click();
  }
}
