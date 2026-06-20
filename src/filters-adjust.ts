// 职责：滤镜 / adjust 面板 + filter-brush 模式（单一职责）。
//   - adjust popup 开关（setAdjustOpen，导出给 doc-ops/ctx）
//   - v131 Filter 面板：region filter 的 preview / apply / cancel（_openFilterPanel 入口）
//   - filter 菜单渲染（_renderFilterMenu，订阅 onFilterRegistered）
//   - v132 filter-brush 模式进入/退出 + toolbar（variant / 边界 下拉）
//
// 拆分期约定：import { ctx }，在 initFiltersAdjust() 把用到的 core 单例绑进私有 let，函数体逐字搬迁。
// state.filterBrush 是 active filter-brush 的 SSoT（在 state 上，经绑定的 state 读写）。
import { els } from "./els.ts";
import { safeLS, safeLSSet } from "./safe-ls.ts";
import { PANELS, openExclusive, closeExclusive } from "./panel-state.ts";
import { getFilter, listFilters, onFilterRegistered } from "./filters.ts";
import { anchorPopupBelowToolbars, positionPopup } from "./anchored-popup.ts";

import { setTool } from "./toolbar.ts";   // 命令 = toolbar 的接口（显式 import）
import { requireEditableLeaf } from "./editable-leaf.ts";
import type { AppContext } from "./app-context.ts";

// Filter 对象（filters.js 未类型化 → 描述本面板用到的接口）。
interface FilterLike {
  id: string; title: string; modes: string[]; category?: string;
  defaults(): Record<string, unknown>;
  buildBody(body: HTMLElement, state: unknown, onChange: () => void): void;
  bake(src: Uint8ClampedArray, out: Uint8ClampedArray, params: unknown, mask: Uint8ClampedArray | null, w: number, h: number): void;
  brushVariants?: { id: string; title: string; params: Record<string, unknown> }[];
  boundaryModes?: { id: string; title: string }[];
}
// adjust panel 操作的 doc 活层（doc.js 未类型化 → 只描述用到的）。
interface AdjustLayer { id: number; name: string; bboxX: number; bboxY: number; bboxW: number; bboxH: number; canvas: CanvasImageSource; ctx: CanvasRenderingContext2D; snapshot(): unknown; }
// editMode.enterTransient 的 apply/abort（edit-mode.js 未类型化默认 null → 调用处断言真签名）。
interface TransientOpts { apply?: () => void; abort?: () => void; }
// filter region preview 态（surrogate canvas + 提取的源/掩码数据）。
interface AdjustState {
  Filter: FilterLike; active: AdjustLayer; params: Record<string, unknown>;
  beforeSnap: unknown; sur: HTMLCanvasElement; surCtx: CanvasRenderingContext2D;
  srcImg: ImageData; maskData: Uint8ClampedArray | null; _rafId: number;
  picker: FilterLike[] | null;
}

let state: AppContext["state"], editMode: AppContext["editMode"], doc: AppContext["doc"], board: AppContext["board"], history: AppContext["history"];
let setStatus: AppContext["setStatus"], store: AppContext["store"], updateSaveStatus: AppContext["updateSaveStatus"];
let _bringPanelTop: AppContext["_bringPanelTop"];
let _suppressTransientPanels: AppContext["_suppressTransientPanels"], _restoreTransientPanels: AppContext["_restoreTransientPanels"];

// ---- topbar：adjustments popup（液化 / 后续调色 etc）----
// 单按钮 → 弹一列 menu-item（同 menuPanel 模式）。学 Procreate adjustments icon。
export function setAdjustOpen(open: boolean) {
  els.adjustPopup.classList.toggle("hidden", !open);
  els.topAdjustBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // 锚到按钮下方右对齐，让到所有可见顶栏条（lasso / crop / filterBrush）以下并夹进视口。
    // v219：换共享 anchorPopupBelowToolbars，取代 v217 只查 lassoToolbarStack 的 bespoke 逻辑
    // （在液化等 filterBrush 模式下顶栏条是 filterBrushToolbar，旧逻辑漏掉 → 遮挡）。
    // 先 remove hidden（上面 toggle 已做）才能量 offsetHeight 做底部夹。
    anchorPopupBelowToolbars(els.adjustPopup, els.topAdjustBtn);
  }
}

// ===== v110/114 crop / resample / adjust =====
// 通用：op 前先 commit floating + 把当前 doc + viewport snapshot 当 before
// v131 Filter 面板（重构自原 BCSH 颜色调整）
// 所有 filter 走 src/filters.js 的 Filter 接口（含 id/title/menuId/modes/bleedRadius/defaults/buildBody/bake）
// _adjustState = { Filter, active, params, beforeSnap, sur, surCtx, srcImg, maskData, _rafId }
// 入口 _openFilterPanel(filterId)；Reset / Cancel / Apply 共用
// preview 用 rAF coalesce：slider drag 不堵队列（user：「液化笔刷事件 last commit，slider drag 也是，gaussian blur fps 低 OK，别 queue 卡半天」）
let _adjustState: AdjustState | null = null;     // 见上注释
// === 老 BCSH 实现已迁 src/filters.js HsbFilter，这里只剩 panel infra ===

// 准备 surrogate canvas + 提取 src/mask 数据
function _initFilterSurrogate(L: AdjustLayer) {
  const sur = document.createElement("canvas");
  sur.width = L.bboxW; sur.height = L.bboxH;
  const surCtx = sur.getContext("2d")!;
  surCtx.drawImage(L.canvas, 0, 0);
  const srcImg = surCtx.getImageData(0, 0, L.bboxW, L.bboxH);
  let maskData = null;
  if (doc.selection) {
    const m = document.createElement("canvas");
    m.width = L.bboxW; m.height = L.bboxH;
    const mctx = m.getContext("2d")!;
    mctx.drawImage(doc.selection.maskCanvas,
      doc.selection.bboxX - L.bboxX, doc.selection.bboxY - L.bboxY);
    maskData = mctx.getImageData(0, 0, L.bboxW, L.bboxH).data;
  }
  return { sur, surCtx, srcImg, maskData };
}

// v132 opts.picker = [Filter, ...]：在 panel body 顶部插一个 dropdown 切其他 filter
//   切换 = cancel 当前 → reopen 新 filter（同一 picker）。用于"艺术滤镜"组
function _openFilterPanel(filterId: string, opts: { picker?: FilterLike[] } = {}) {
  const Filter = getFilter(filterId) as FilterLike | undefined;
  if (!Filter) { setStatus(`未知 filter：${filterId}`, true); return; }
  const L = requireEditableLeaf(doc, setStatus) as AdjustLayer | null;   // 组/隐藏 → 标准状态行 + 退出（取代旧的只查 !L）
  if (!L) return;
  if (L.bboxW <= 0 || L.bboxH <= 0) { setStatus("活动图层是空的", true); return; }
  // v232 (user：「液化状态下调出色彩平衡，液化没自动关掉」)：filterBrush（液化/锐化模糊）是持久
  // 模式，enterTransient 只捕获 _returnTool、不收它的 toolbar → UI 留着但笔禁用，像坏了。
  // 开任何滤镜面板前先整个退出 filterBrush 模式（收 toolbar / 清 state / 回前一工具）。
  if (state.filterBrush) _exitFilterBrushMode();
  if (_adjustState) _closeFilterPanel(false);
  const { sur, surCtx, srcImg, maskData } = _initFilterSurrogate(L);
  _adjustState = {
    Filter, active: L, params: Filter.defaults(),
    beforeSnap: L.snapshot(), sur, surCtx, srcImg, maskData,
    _rafId: 0,
    picker: opts.picker || null,
  };
  if (els.adjustPanelTitle) els.adjustPanelTitle.textContent = opts.picker ? "艺术滤镜" : Filter.title;
  els.adjustParamsBody.innerHTML = "";
  // picker 模式：插 dropdown
  if (opts.picker) {
    const wrap = document.createElement("label");
    wrap.className = "brush-slider-row";
    wrap.innerHTML = `<span class="brush-slider-label">选滤镜</span>`;
    const sel = document.createElement("select");
    sel.style.flex = "1";
    sel.style.font = "inherit";
    sel.style.padding = "2px 4px";
    for (const F of opts.picker) {
      const opt = document.createElement("option");
      opt.value = F.id;
      opt.textContent = F.title;
      if (F.id === filterId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const newId = sel.value;
      if (newId === filterId) return;
      _closeFilterPanel(false);
      _openFilterPanel(newId, { picker: opts.picker });
    });
    wrap.appendChild(sel);
    wrap.appendChild(document.createElement("span"));
    els.adjustParamsBody.appendChild(wrap);
  }
  Filter.buildBody(els.adjustParamsBody, _adjustState, _onFilterChange);
  els.adjustPanel.classList.remove("hidden");
  const w = els.adjustPanel.offsetWidth || 320;
  // v270：滤镜面板（液化等）走统一 positionPopup——钉视口右边 16px、让到顶栏条以下、读 safe-area、
  //   夹视口。取代原来手搓的 left=innerWidth-w-16 / top=max(104,…)（漏 safe-area、和 toolbar 挤）。
  void w;   // 宽度由 CSS 定，右钉不再需要算 left
  positionPopup(els.adjustPanel, { align: "right", edgeMargin: 16, belowToolbars: true, offsetY: 8 });
  _bringPanelTop(els.adjustPanel);
  board.setActiveLayerSurrogate?.(L.id, sur);
  _runFilterPreview();      // 初次渲染（identity）
  _suppressTransientPanels("adjust-color");
  // adjust transient：apply=烤进(true)，abort=丢弃(false)。_closeFilterPanel 是 sync 点（见其尾 exitTransient）。
  (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("adjust", { apply: () => _closeFilterPanel(true), abort: () => _closeFilterPanel(false) });
}

// preview coalesce：rAF 保证最多 1 帧 1 次 bake，slider drag 不堵队列
// (user：「液化笔刷事件 last commit，slider drag 也是，fps 低 OK，别 queue 卡半天」)
function _onFilterChange() {
  if (!_adjustState) return;
  if (_adjustState._rafId) return;
  _adjustState._rafId = requestAnimationFrame(() => {
    if (!_adjustState) return;
    _adjustState._rafId = 0;
    _runFilterPreview();
  });
}
function _runFilterPreview() {
  const s = _adjustState;
  if (!s) return;
  const outImg = s.surCtx.createImageData(s.srcImg.width, s.srcImg.height);
  s.Filter.bake(s.srcImg.data, outImg.data, s.params, s.maskData, s.srcImg.width, s.srcImg.height);
  s.surCtx.putImageData(outImg, 0, 0);
  board.invalidateAll();
}

function _closeFilterPanel(applied: boolean) {
  if (!_adjustState) return;
  const L = _adjustState.active;
  if (_adjustState._rafId) { cancelAnimationFrame(_adjustState._rafId); _adjustState._rafId = 0; }
  board.setActiveLayerSurrogate?.(null, null);
  if (applied) {
    // 烤进 layer（surrogate 已是最终结果，直接拷回）
    L.ctx.clearRect(0, 0, L.bboxW, L.bboxH);
    L.ctx.drawImage(_adjustState.sur, 0, 0);
    const after = L.snapshot();
    history.push({ type: "stroke", layerId: L.id, before: _adjustState.beforeSnap, after, beforeBlob: null, afterBlob: null });   // history.push 同步派 wp:histchange → 编辑门已标
    setStatus(`${_adjustState.Filter.title} 已应用：${L.name}`);
  }
  _adjustState = null;
  els.adjustPanel.classList.add("hidden");
  els.adjustParamsBody.innerHTML = "";
  _restoreTransientPanels();
  board.invalidateAll();
  editMode.exitTransient();   // sync 点：任何关闭路径（OK/cancel/重开/picker/decisive）都清 EditMode transient
}

// v132 菜单 3 组渲染（user：「3 组 hr 分组：调色 / 液化锐化模糊 / 艺术滤镜」）
//   - 调色 = adjustment category + 有 region 模式（HSV / ColorBalance / Curves）
//             左侧 prefix = 旧 adjust SVG（3 条滑块 + 圆点）
//   - 笔刷类 = 液化 + 所有有 brush 模式的 filter
//             左侧 prefix = 笔刷 SVG（跟工具栏一致）
//   - 艺术滤镜 = category="artist"，1 个 picker item（点开 panel 里有 dropdown 切）
//   - 组之间 hr 分隔，不写类别 label
const ADJUST_PREFIX_SVG = `<svg class="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
  <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/>
  <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>
  <circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/>
</svg>`;
const BRUSH_PREFIX_SVG = `<svg class="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M14 4l6 6-9 9H5v-6l9-9z"/><path d="M13 5l6 6"/>
</svg>`;
function _renderFilterMenu() {
  const container = document.getElementById("adjustFilterList");
  if (!container) return;
  container.innerHTML = "";
  const all = listFilters() as FilterLike[];
  const adjustmentRegion = all.filter((F) => (F.category || "adjustment") === "adjustment" && F.modes.includes("region"));
  const brushFilters     = all.filter((F) => F.modes.includes("brush"));
  const artistFilters    = all.filter((F) => F.category === "artist");
  const addHr = () => {
    const hr = document.createElement("hr"); hr.className = "menu-sep"; container.appendChild(hr);
  };
  const addItem = (label: string, prefixSvg: string, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.className = "menu-item menu-item-with-icon";
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.innerHTML = `${prefixSvg}<span class="menu-item-label">${label}</span>`;
    btn.addEventListener("click", onClick);
    container.appendChild(btn);
    return btn;
  };
  let groupOpened = false;
  // 1) 调色
  for (const F of adjustmentRegion) {
    addItem(F.title, ADJUST_PREFIX_SVG, () => {
      setAdjustOpen(false);
      _openFilterPanel(F.id);
    });
    groupOpened = true;
  }
  // 2) 笔刷类 filter（液化 / 锐化模糊 都是 plugin，自动列出来）
  if (groupOpened && brushFilters.length > 0) addHr();
  groupOpened = brushFilters.length > 0;
  for (const F of brushFilters) {
    addItem(F.title, BRUSH_PREFIX_SVG, () => {
      setAdjustOpen(false);
      _enterFilterBrushMode(F);
    });
  }
  // 3) 艺术滤镜（1 picker item）
  if (artistFilters.length > 0) {
    if (groupOpened) addHr();
    addItem("艺术滤镜", ADJUST_PREFIX_SVG, () => {
      setAdjustOpen(false);
      _openArtistPicker();
    });
  }
}
// 艺术滤镜：开 adjust panel，body 顶部加 dropdown 切具体 filter
function _openArtistPicker() {
  const artist = (listFilters() as FilterLike[]).filter((F) => F.category === "artist");
  if (artist.length === 0) { setStatus("没有艺术滤镜"); return; }
  _openFilterPanel(artist[0].id, { picker: artist });
}

// v132 进入 / 退出 filter brush 模式
//   进入：state.filterBrush = { Filter, params, variantId, variantLabel }；setTool("filterBrush")
//        + openExclusive 弹 filter brush rack（user：「我不是让你做两个新笔吗」）
//        + variantId 优先用 toolStates.filterBrush.variantId 持久化值
//        + toolbar 渲染子算法 dropdown（user：「不同算法是 toolbar dropdown」）
//   退出：清 state.filterBrush；关 rack；setTool 回前一个
let _filterBrushPreviousTool: string | null = null;
function _enterFilterBrushMode(Filter: FilterLike) {
  editMode.applyPendingTransient();
  _filterBrushPreviousTool = editMode.current() === "filterBrush" ? "brush" : editMode.current();
  // 取持久化的 variantId（user 上次选过的；新 doc 默认第一个）
  const variants = Filter.brushVariants || [{ id: "default", title: Filter.title, params: Filter.defaults() }];
  const savedVid = state.toolStates.filterBrush?.variantId;
  let variant = variants.find((v) => v.id === savedVid) || variants[0];
  // v147 声明了 boundaryModes 的 filter（液化）→ params 带上持久化的 bleed；其他 filter 不掺这个 key
  const params = Filter.boundaryModes
    ? { ...variant.params, bleed: safeLS("webpaint.liquify.bleed") || "edge" }
    : variant.params;
  state.filterBrush = { Filter, params, variantId: variant.id, variantLabel: variant.title };
  if (state.toolStates.filterBrush) state.toolStates.filterBrush.variantId = variant.id;
  setTool("filterBrush");
  _renderFilterBrushToolbar();
  // v132 (user：「点 filter brush 不要自动弹笔架」) 进入时不开 rack
  //   user 想换笔点 toolbar 的「笔架」button
  setStatus(`${Filter.title}（笔刷）`);
}
function _exitFilterBrushMode() {
  state.filterBrush = null;
  const tb = document.getElementById("filterBrushToolbar");
  if (tb) tb.classList.add("hidden");
  closeExclusive();   // 收 rack
  setTool(_filterBrushPreviousTool || "brush");
  _filterBrushPreviousTool = null;
  setStatus("已退出 filter brush");
}
// 渲染 toolbar：title + variant dropdown (if multi) + 退出
function _renderFilterBrushToolbar() {
  if (!state.filterBrush) return;
  const fb = state.filterBrush;                  // 捕获非空引用（闭包里 state.filterBrush 不被收窄）
  const Filter = fb.Filter as FilterLike;        // filterBrush.Filter 在 AppContext 里是 unknown（owner=filters.js）
  const variantId = fb.variantId;
  const tb = document.getElementById("filterBrushToolbar");
  const title = document.getElementById("filterBrushTitle");
  if (!tb || !title) return;
  tb.classList.remove("hidden");
  title.textContent = Filter.title;
  // dropdown：清掉旧的，按 brushVariants 重建
  document.getElementById("filterBrushVariantSel")?.remove();
  const variants = Filter.brushVariants || [];
  if (variants.length > 1) {
    const sel = document.createElement("select");
    sel.id = "filterBrushVariantSel";
    sel.className = "crop-toolbar-btn";
    sel.style.padding = "2px 6px";
    for (const v of variants) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.title;
      if (v.id === variantId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const v = variants.find((x) => x.id === sel.value);
      if (!v) return;
      // 切 variant 别丢 bleed（boundaryModes filter 才有这个 key）
      fb.params = Filter.boundaryModes
        ? { ...v.params, bleed: fb.params.bleed }
        : v.params;
      fb.variantId = v.id;
      fb.variantLabel = v.title;
      if (state.toolStates.filterBrush) state.toolStates.filterBrush.variantId = v.id;
      // UI 态不 mark dirty（user 2026-06-10）：variant 选择是工具态，保存时顺手捞；真应用滤镜走 histchange 门。
      setStatus(`已切 ${v.title}`);
    });
    // 插在 title 后
    title.insertAdjacentElement("afterend", sel);
  }
  // v147 边界取样下拉：仅当 filter 声明 boundaryModes（液化）且有选区时渲染。
  // feature 声明数据 + 通用渲染 → 删 filter 即删 UI，不再像旧 #liquifyPanel 那样静态腐烂。
  document.getElementById("filterBrushBleedSel")?.remove();
  if (Filter.boundaryModes && doc.selection) {
    const bsel = document.createElement("select");
    bsel.id = "filterBrushBleedSel";
    bsel.className = "crop-toolbar-btn";
    bsel.style.padding = "2px 6px";
    bsel.title = "选区边界：位移源落到选区外怎么办";
    const curBleed = fb.params.bleed || "edge";
    for (const b of Filter.boundaryModes) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title;
      if (b.id === curBleed) opt.selected = true;
      bsel.appendChild(opt);
    }
    bsel.addEventListener("change", () => {
      fb.params = { ...fb.params, bleed: bsel.value };
      safeLSSet("webpaint.liquify.bleed", bsel.value);
      const m = Filter.boundaryModes!.find((b) => b.id === bsel.value);
      setStatus(`边界：${m ? m.title : bsel.value}`);
    });
    // 插在 variant select 后（没有 variant 就插 title 后）
    (document.getElementById("filterBrushVariantSel") || title).insertAdjacentElement("afterend", bsel);
  }
}

export function initFiltersAdjust(ctx: AppContext) {
  ({ state, editMode, doc, board, history, setStatus, store, updateSaveStatus,
     _bringPanelTop, _suppressTransientPanels, _restoreTransientPanels } = ctx);

  els.topAdjustBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    setAdjustOpen(els.adjustPopup.classList.contains("hidden"));
  });
  document.addEventListener("pointerdown", (e: Event) => {
    if (els.adjustPopup.classList.contains("hidden")) return;
    if (els.adjustPopup.contains(e.target as Node) || els.topAdjustBtn.contains(e.target as Node)) return;
    setAdjustOpen(false);
  });

  _renderFilterMenu();
  onFilterRegistered(_renderFilterMenu);

  document.getElementById("filterBrushExit")?.addEventListener("click", _exitFilterBrushMode);
  // v132 笔架 button：再开 rack（user：「ui 里有开笔架，不然关了开不了」）
  document.getElementById("filterBrushOpenRack")?.addEventListener("click", () => {
    openExclusive(PANELS.RACK_FILTER_BRUSH);
  });
  document.getElementById("adjustReset")?.addEventListener("click", () => {
    if (!_adjustState) return;
    _adjustState.params = _adjustState.Filter.defaults();
    els.adjustParamsBody.innerHTML = "";
    _adjustState.Filter.buildBody(els.adjustParamsBody, _adjustState, _onFilterChange);
    _onFilterChange();
  });
  document.getElementById("adjustCancel")?.addEventListener("click", () => _closeFilterPanel(false));
  document.getElementById("adjustPanelClose")?.addEventListener("click", () => _closeFilterPanel(false));
  document.getElementById("adjustApply")?.addEventListener("click", () => _closeFilterPanel(true));
}
