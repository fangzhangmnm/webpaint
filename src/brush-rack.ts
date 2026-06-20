// 职责（单一）：管理笔架——预设存储（IDB + 云同步）、笔架 sheet UI、笔设置编辑器、
// 以及「活动预设 ↔ 每工具 dial 状态」的绑定。
//
// 最小接口：构造拿依赖（共享 SSoT: state.toolStates / dialReactive + 编排件），暴露
// load/getRackToolKey/findToolBrushPure/applyToolState/selectBrushPresetForTool/openBrushSettings/
// showSheet/markChanged/reset/checkCloud + get()。引擎读的 currentBrush 仍在 app，调本类的纯查找。
//
// 旧 app.js 的 _brushRack/rackUi/loadBrushRack/persistBrushRack/markRackChanged/applyToolState/
// selectBrushPresetForTool/_showRackSheet/mountRackSheet/rack 云图标态机/新建·导入/笔设置编辑器
// 全部搬来（classify + copy-paste），app.js 短路成构造 + 事件绑定。

import { reactive } from "../vendor/vue/vue.esm-browser.prod.js";
import { getMeta, setMeta } from "./storage.ts";
import {
  makeDefaultRack, mergeMissingDefaults, migrateBrush, defaultBrushForTool,
  brushesByTool, findBrush, newBrushId, brushFromJSON, DEFAULT_FOLDER,
} from "./brushes.ts";
import { resolveRef } from "./app-store.ts";
import { collectFolders } from "./brush-rack-view.ts";
import { mountRackSheet } from "./ui/rack-sheet.ts";
import { mountBrushSettings } from "./ui/brush-settings.ts";
import { exportBrush, exportRackFolder, buildRackCode, shareOrDownloadJSON } from "./brush-io.ts";
import type { Brush, BrushRackData } from "./brush-types.ts";
import type { EditorRuntimeState, DialReactive, ToolDial } from "./app-context.ts";
import type { EditMode } from "./edit-mode.ts";

const RACK_META_KEY = "brush-rack";
const TOOL_LABEL: Record<string, string> = { brush: "笔刷", eraser: "橡皮" };

// 笔架同步编排句柄（folder-sync store；诚实描述本类调到的成员）。
interface RackSyncResult {
  folder?: { version: number; items: Brush[]; trash?: unknown[]; resetAt?: number };
  status?: string;
  error?: unknown;
}
interface RackStore {
  edit(): void;
  status(o: { signedIn: boolean; online: boolean }): string;
  sync(): Promise<void>;
  isDirty(): boolean;
  flush(): void;
  configure(opts: {
    canSync: () => boolean;
    snapshot: () => unknown;
    onBusyChange: () => void;
    onResult: (res: RackSyncResult) => void | Promise<void>;
  }): void;
}

// 构造期依赖（早于 SSoT 块构造，故 editMode 走 thunk 避 TDZ；DOM/icons/panels 等晚绑走 init()）。
export interface BrushRackDeps {
  state: EditorRuntimeState;  // 共享 SSoT（state.toolStates 反应式）
  dialReactive: DialReactive; // 共享 SSoT（rackVersion bump / tool）
  editMode: () => EditMode;   // thunk：构造时 editMode 尚未定义
  setStatus: (m: string, e?: boolean) => void;
  confirm: (title: string, msg: string) => Promise<boolean>;
  openExclusive: (id: string) => void;
  closeExclusive: () => void;
  registerPanel: (id: string, h: { show: () => void; hide: () => void }) => void;
  rackStore: RackStore;
  setRackDirty: (d: boolean) => void;
  isSignedIn: () => boolean;
  isOnline: () => boolean;
}
// init() 晚绑：DOM els + icons + blendModes + panel 映射（这些常量定义在 app.js 后段）。
interface RackEls {
  mount: HTMLElement; title: HTMLElement; sheet: HTMLElement; close: HTMLElement;
  newBtn: HTMLElement; importBtn: HTMLElement;
  cloudPushBtn?: HTMLElement; exportFolderBtn?: HTMLElement; resetBtn?: HTMLElement; dumpCodeBtn?: HTMLElement;
}
interface SettingsEls { view: HTMLElement; body: HTMLElement; save: HTMLElement; cancel: HTMLElement; }
export interface BrushRackUI {
  els: { rack: RackEls; settings: SettingsEls };
  icons: { check: string; busy: string; upload: string; disk: string };
  blendModes: Record<string, string>;
  RACK_PANEL_BY_TOOL: Record<string, string>;
}

export class BrushRack {
  // UI 字段（BrushRackUI）由 init() 晚绑 Object.assign 进来 → 构造期 cast 一次记录此事实，余处全类型化。
  d: BrushRackDeps & BrushRackUI;
  _rack: BrushRackData | null = null;
  ui: { tool: string; folder: string };
  _cloudState = "no-auth";
  _editingId: string | null = null;
  _editingDraft: Brush | null = null;
  _settingsUI: ReturnType<typeof mountBrushSettings> | null = null;

  constructor(deps: BrushRackDeps) {
    this.d = deps as BrushRackDeps & BrushRackUI;
    this.ui = reactive({ tool: "brush", folder: DEFAULT_FOLDER });
  }

  get() { return this._rack; }
  setRack(r: BrushRackData) { this._rack = r; }   // boot 的 default-merge / 兜底用

  // ---- 预设存储 ----
  async load() {
    this._rack = await this._loadRack();
    this.d.dialReactive.rackVersion++;
    return this._rack;
  }
  async _loadRack() {
    try {
      let stored = await getMeta(RACK_META_KEY) as BrushRackData | null;
      if (stored && Array.isArray(stored.brushes) && stored.brushes.length > 0) {
        let migrated = false;
        for (const b of stored.brushes) {
          const before = JSON.stringify(b);
          migrateBrush(b);
          if (JSON.stringify(b) !== before) migrated = true;
        }
        const newRack = mergeMissingDefaults(stored);
        if (newRack) stored = newRack;
        if (migrated || newRack) { try { await setMeta(RACK_META_KEY, stored); } catch {} }
        return stored;
      }
    } catch (e) { console.warn("[brush-rack] load failed:", e); }
    const rack = makeDefaultRack();
    try { await setMeta(RACK_META_KEY, rack); } catch (e) { console.warn("[brush-rack] save default failed:", e); }
    return rack;
  }
  async persist() {
    if (!this._rack) return;
    try { await setMeta(RACK_META_KEY, this._rack); }
    catch (e) { console.warn("[brush-rack] persist failed:", e); }
  }
  // 笔架内容变了单一入口：落本地 + 标脏排防抖同步 + 刷 icon + bump rackVersion（当前笔/sheet 重算）。
  markChanged() {
    this.persist();
    this.d.rackStore.edit();
    this.refreshCloudState();
    this.d.dialReactive.rackVersion++;
  }

  // ---- 活动预设 ↔ tool dial 绑定 ----
  getRackToolKey(tool: string) { return tool === "airbrush" ? "brush" : tool; }
  defaultToolStateFor(tool: string) {
    if (this._rack) {
      const brush = defaultBrushForTool(this._rack, tool);
      if (brush) return { size: brush.size.base, opacity: 1.0, flow: 1.0, activeBrushId: brush.id, activeBrushName: brush.name };
    }
    return { size: 12, opacity: 1.0, flow: 1.0, activeBrushId: null, activeBrushName: null };
  }
  // healing 回写版（显式路径用）
  findToolBrush(ts: ToolDial | null | undefined) {
    if (!ts || !this._rack) return null;
    const b = resolveRef(this._rack.brushes, { id: ts.activeBrushId, name: ts.activeBrushName }) as Brush | null;
    if (b) { ts.activeBrushId = b.id; ts.activeBrushName = b.name; }
    return b;
  }
  // 纯查找（currentBrush computed 用：computed 内绝不可写 reactive）
  findToolBrushPure(ts: ToolDial | null | undefined) {
    if (!ts || !this._rack) return null;
    return resolveRef(this._rack.brushes, { id: ts.activeBrushId, name: ts.activeBrushName }) as Brush | null;
  }
  applyToolState(tool: string) {
    if (!this._rack) return;
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
    const brush = findBrush(this._rack!, brushId);
    if (!brush) return;
    ts.activeBrushId = brushId;
    ts.activeBrushName = brush.name;
    ts.size = brush.size.base;
    ts.opacity = brush.defaultOpa ?? 1.0;
    ts.flow = 1.0;
    if (key === this.getRackToolKey(this.d.editMode().current())) this.applyToolState(this.d.editMode().current());
  }

  // ---- 云图标态机 ----
  refreshCloudState() {
    this._cloudState = this.d.rackStore.status({ signedIn: this.d.isSignedIn(), online: this.d.isOnline() });
    this._updateCloudIcon();
  }
  _updateCloudIcon() {
    const btn = this.d.els.rack.cloudPushBtn;
    if (!btn) return;
    const I = this.d.icons;
    const ICON: Record<string, string> = { synced: I.check, busy: I.busy, dirty: I.upload, offline: I.disk, "no-auth": I.disk };
    const TITLE: Record<string, string> = {
      synced: "笔架 已同步云端", busy: "笔架 上传中…", dirty: "笔架 待推 — 点推送",
      offline: "笔架 离线 — 仅本地", "no-auth": "笔架 未登录 — 登 OneDrive 自动同步",
    };
    btn.innerHTML = ICON[this._cloudState] || ICON.synced;
    btn.title = TITLE[this._cloudState] || "";
    btn.dataset.state = this._cloudState;
  }
  async syncCloud() { await this.d.rackStore.sync(); this.refreshCloudState(); }
  async checkCloud() {
    if (!this.d.isSignedIn() || !this.d.isOnline()) return;
    await this.syncCloud();
  }

  // ---- 笔架 sheet ----
  showSheet(tool: string) {
    if (!this._rack) return;
    this.ui.tool = tool;
    const folders = collectFolders(brushesByTool(this._rack, this.getRackToolKey(tool)), DEFAULT_FOLDER);
    if (!folders.includes(this.ui.folder)) this.ui.folder = folders[0] || DEFAULT_FOLDER;
    this.d.els.rack.title.textContent = `笔架 · ${TOOL_LABEL[tool] || tool}`;
    this.d.els.rack.sheet.classList.remove("hidden");
    this.refreshCloudState();
  }
  hideSheet() {
    this.d.els.rack.sheet.classList.add("hidden");
    if (this.d.rackStore.isDirty()) this.persist();
    this.d.rackStore.flush();
  }

  reset(factory: boolean) {
    this._rack = makeDefaultRack(factory ? { resetAt: Date.now() } : undefined);
    for (const t of Object.keys(this.d.state.toolStates)) {
      this.d.state.toolStates[t].activeBrushId = null;
      Object.assign(this.d.state.toolStates[t], this.defaultToolStateFor(t));
    }
    this.markChanged();
    this.applyToolState(this.d.editMode().current());
  }

  _nextBrushName() {
    const re = /^新笔\s*(\d+)$/;
    let max = 0;
    for (const b of this._rack!.brushes) { const m = re.exec(b.name); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    return `新笔 ${max + 1}`;
  }
  // v232 (user：「新建笔从当前 active 笔拷贝，名字也从原名派生」)：「水彩」→「水彩 2」→「水彩 3」。
  // 去掉原名尾部数字得 base，扫全架同 base 的最大序号 +1（base 本身算 1）。
  _deriveBrushName(srcName: string) {
    const base = String(srcName || "").replace(/\s*\d+$/, "").trim() || "新笔";
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\d+)$`);
    let max = 1;
    for (const b of this._rack!.brushes) {
      const m = re.exec(b.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${base} ${max + 1}`;
  }

  // ---- 笔设置编辑器（draft → 存才落 rack）----
  openBrushSettings(brushId: string, newDraft?: Brush) {
    let draft: Brush;
    if (newDraft) draft = newDraft;
    else { const b = findBrush(this._rack!, brushId); if (!b) return; draft = JSON.parse(JSON.stringify(b)); }
    this._editingId = brushId;
    this._editingDraft = draft;
    this._settingsUI!.open(draft);
    this.d.els.settings.view.classList.remove("hidden");
  }
  closeBrushSettings(save: boolean) {
    if (save && this._editingDraft) {
      const draft = this._editingDraft, rack = this._rack!;   // 编辑期 rack 必已 load
      draft.uat = Date.now();
      const idx = rack.brushes.findIndex((x) => x.id === this._editingId);
      if (idx >= 0) rack.brushes[idx] = draft;
      else rack.brushes.push(draft);
      this.markChanged();
      const targetTool = this.d.editMode().current() === "airbrush" ? "brush" : draft.tool;
      if (this.getRackToolKey(this.d.editMode().current()) === this.getRackToolKey(targetTool)) {
        this.selectBrushPresetForTool(this.d.editMode().current(), draft.id);
      } else {
        this.selectBrushPresetForTool(targetTool, draft.id);
      }
      this.d.dialReactive.rackVersion++;
      this.d.setStatus(`已保存：${draft.name}`);
    }
    this._editingId = null;
    this._editingDraft = null;
    this._settingsUI!.close();
    this.d.els.settings.view.classList.add("hidden");
  }
  async deleteEditingBrush() {
    const b = this._editingDraft;
    if (!b) return;
    if (!(await this.d.confirm("删除这支笔？", `「${b.name}」（不可撤销）`))) return;
    const rack = this._rack!;
    const idx = rack.brushes.findIndex((x) => x.id === this._editingId);
    if (idx >= 0) {
      rack.brushes.splice(idx, 1);
      if (!Array.isArray(rack.trash)) rack.trash = [];
      rack.trash.push({ id: this._editingId, uat: Date.now() });
      this.markChanged();
      this.d.dialReactive.rackVersion++;
    }
    this._editingId = null;
    this._editingDraft = null;
    this._settingsUI!.close();
    this.d.els.settings.view.classList.add("hidden");
    this.d.setStatus("已删除");
  }

  // ---- 装配：mount sheet/settings 组件 + rackStore.configure + 注册 panel + 绑 DOM 事件 ----
  init(ui: BrushRackUI) {
    Object.assign(this.d, ui);   // 晚绑 els/icons/blendModes/RACK_PANEL_BY_TOOL
    const els = this.d.els.rack, sEls = this.d.els.settings;

    // rack-sheet Vue 组件
    mountRackSheet(els.mount, {
      defaultFolder: DEFAULT_FOLDER,
      getBrushes: () => { void this.d.dialReactive.rackVersion; return this._rack ? brushesByTool(this._rack, this.getRackToolKey(this.ui.tool)) : []; },
      getRackEmpty: () => { void this.d.dialReactive.rackVersion; return !this._rack || !this._rack.brushes || this._rack.brushes.length === 0; },
      getFolder: () => this.ui.folder,
      getActiveId: () => this.d.state.toolStates[this.getRackToolKey(this.ui.tool)]?.activeBrushId ?? null,
      onSelectFolder: (f: string) => { this.ui.folder = f; },
      onSelectBrush: (id: string) => { this.selectBrushPresetForTool(this.ui.tool, id); this.d.closeExclusive(); },
      onEditBrush: (id: string) => { this.d.closeExclusive(); this.openBrushSettings(id); },
      onReset: () => { this.reset(false); this.d.setStatus(`已恢复默认笔架（${this._rack!.brushes.length} 个）`, true); },
    });

    // brush-settings 编辑器 Vue 组件
    this._settingsUI = mountBrushSettings(sEls.body, {
      blendModes: this.d.blendModes,
      onDelete: () => this.deleteEditingBrush(),
      onExport: () => { if (this._editingDraft) exportBrush(this._editingDraft); },
    });

    // 笔架同步编排
    this.d.rackStore.configure({
      canSync: () => this.d.isSignedIn() && this.d.isOnline(),
      snapshot: () => this._rack ? { version: this._rack.version, items: this._rack.brushes, trash: this._rack.trash || [], resetAt: this._rack.resetAt || 0 } : null,
      onBusyChange: () => this.refreshCloudState(),
      onResult: async (res) => {
        if (res.folder && this._editingId == null) {
          this._rack = { ...(this._rack), version: res.folder.version, brushes: res.folder.items, trash: res.folder.trash, resetAt: res.folder.resetAt };
          { const _n = mergeMissingDefaults(this._rack); if (_n) this._rack = _n; }
          await this.persist();
          this.applyToolState(this.d.editMode().current());
          this.d.dialReactive.rackVersion++;
        }
        if (res.status === "synced") this.d.setStatus("笔架已同步到云端");
        else if (res.status === "invalid") this.d.setStatus("笔架云端数据异常，已留待重试", true);
        else if (res.status === "dirty") { console.warn("[brush-rack sync]", res.error); this.d.setStatus("笔架同步失败，已留待重试", true); }
      },
    });

    // 注册 exclusive panel（多 tool → 同 panel id 去重，第一个赢）
    const registered = new Set();
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
      if (!this._rack) return;
      const n = await exportRackFolder(this._rack, this.ui.tool, this.ui.folder);
      this.d.setStatus(n ? `已导出文件夹「${this.ui.folder}」（${n} 笔）` : "本文件夹是空的", !n);
    });
    if (els.cloudPushBtn) els.cloudPushBtn.addEventListener("click", async () => {
      if (!this.d.isSignedIn()) { this.d.setStatus("请先登录云端账号", true); return; }
      this.d.setStatus("正在同步笔架…");
      await this.syncCloud();
    });
    if (els.resetBtn) els.resetBtn.addEventListener("click", async () => {
      if (!(await this.d.confirm("重置笔架？", "会删除全部自定义笔刷 + 改过的默认笔，恢复出厂默认。不可撤销。"))) return;
      this.reset(true);
      this.d.setRackDirty(true);
      if (this.d.isSignedIn()) this.syncCloud();
      this.d.setStatus(`笔架已重置（${this._rack!.brushes.length} 个 brush）`, true);
    });
    if (els.dumpCodeBtn) els.dumpCodeBtn.addEventListener("click", async () => {
      if (!this._rack) return;
      await shareOrDownloadJSON(new Blob([buildRackCode(this._rack)], { type: "text/javascript" }), "default-brushes.js", "笔架代码");
      this.d.setStatus(`已导出 ${this._rack.brushes.length} 笔的代码文件`);
    });
  }

  _onNewBrush() {
    const activeId = this.d.state.toolStates[this.getRackToolKey(this.ui.tool)]?.activeBrushId;
    let source = activeId ? findBrush(this._rack!, activeId) : null;
    if (!source) {
      const inFolder = (brushesByTool(this._rack!, this.ui.tool) as Brush[]).filter((b) => (b.folder || DEFAULT_FOLDER) === this.ui.folder);
      source = inFolder[0] || this._rack!.brushes[0] || null;
    }
    let newB: Brush;
    if (source) {
      newB = JSON.parse(JSON.stringify(source));
      newB.id = newBrushId();
      newB.name = this._deriveBrushName(source.name);
      newB.folder = this.ui.folder;
      newB.tool = this.ui.tool;
    } else {
      newB = {
        id: newBrushId(), name: this._nextBrushName(), tool: this.ui.tool, folder: this.ui.folder,
        shape: { kind: "round", aspect: 1, rotation: 0, hardness: 1.0, textureB64: null },
        size: { base: 12, max: 200 }, sizeCoeff: 0.6, opaCoeff: 0.6, flowCoeff: 0,
        pressureGamma: 1.0, pressureLPF: 50, defaultOpa: 1.0,
        compositeMode: "wash", blendMode: "source-over", spacing: 0.06, pixelMode: false,
        taper: { in: 0, out: 0 },
        smooth: { streamline: 0.15, stabilization: 0 },
      };
    }
    newB.uat = Date.now();
    this.d.closeExclusive();
    this.openBrushSettings(newB.id, newB);
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
        b.uat = Date.now();
        this._rack!.brushes.push(b);
        this.markChanged();
        this.d.setStatus(`已导入：${b.name}`);
      } catch (e) { this.d.setStatus("导入失败：" + String((e as { message?: unknown })?.message || e), true); }
      document.body.removeChild(inp);
    });
    document.body.appendChild(inp);
    inp.click();
  }
}
