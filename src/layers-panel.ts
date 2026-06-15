// 职责（单一）：图层面板 UI（开关 / 拖动 / 位置记忆 / 列表渲染 / 折叠区）+ 每层操作
// （增删层、上下移、向下合并、清空像素、重命名、参考层 / 剪裁 / 可见性 / 透明度 / 模式）。
//
// v(Vue) 重写：原命令式 renderLayersPanel() 的 innerHTML 重建是反模式 —— 整块改成数据驱动的
// <LayersPanel> Vue 组件（递归就绪的 <LayerRow> 子组件，未来加 children 数组即可嵌套 = 不重写）。
//
// 反应式模型：doc.layers 是 doc 方法直接 mutate 的普通数组（**非**反应式）。所以沿用版本信号 ——
// 但信号已外迁到 signals.ts 的 **docVersion**（跨切面共享）：任何 doc/图层结构变更 bumpDoc() 即可，
// 发射方不再 reference 本面板。组件的 computed 读 docVersion.value 后快照 doc.layers + activeIndex +
// referenceLayerId → 自动重算。app.js 仍可调导出的 renderLayersPanel()（垫片转 bumpDoc）零改动。
//
// **leaf-by-value 硬规则（v231 教训）**：非反应式活对象绝不直接当 props 过 Vue 边界。rows 重算时
// 必须把每层 leaf 值（name/visible/opacity/mode/clippingMask）拷成**新对象**传下去——否则
// props 引用不变 → Vue 判 props 相等跳过子组件更新，且子组件 computed 只追踪到 props.layer 引用、
// 追踪不到裸对象字段 → 永久冻结在首次求值。版本信号只负责触发快照重算，穿透靠引用变化。
// mutation 一律经 live()（findLayer by id）回写 doc 活对象，快照只读。
//
// 面板外的 chrome（计数标签 / 加按钮禁用 / 删按钮禁用 / 滚到活动层）不在 mount 容器内，
// 由 watch(docVersion) 副作用同步。
//
// 仍留 app.js 的协作件经 ctx 绑入：doc / board / history / setStatus（核心单例）
// + _afterDocChange（lasso / history handler 也调）+ layerSpecFrom（lasso 也调）。

import { createApp, defineComponent, reactive, computed, watch, nextTick } from "../vendor/vue/vue.esm-browser.prod.js";
import { countLeaves, findNodeById } from "./doc.js";
import { docVersion, bumpDoc } from "./signals.ts";
import { els } from "./els.ts";
import { safeLS, safeLSSet } from "./safe-ls.ts";
import { raiseWindow } from "./surfaces.ts";
import { compressPixelSnap } from "./pixel-edit.js";

let doc: any, board: any, history: any, setStatus: any;
// 留在 app.js、经 ctx 绑入的协作件（被非图层代码也调用）
let _afterDocChange: any, layerSpecFrom: any;

// 图层模式 → 单字符 badge (Procreate 风格)。"pass-through" 仅组可用（穿透）。
const LAYER_MODE_INITIAL: Record<string, string> = {
  "pass-through": "穿",
  "source-over": "N", "multiply": "M", "screen": "S", "overlay": "O",
  "darken": "Da", "lighten": "Li", "color-dodge": "CD", "color-burn": "CB",
  "hard-light": "HL", "soft-light": "SL", "difference": "Df", "exclusion": "Ex",
};
export const LAYER_MODE_LABEL: Record<string, string> = {
  "source-over": "正常", "multiply": "正片叠底", "screen": "滤色", "overlay": "叠加",
  "darken": "变暗", "lighten": "变亮", "color-dodge": "颜色减淡", "color-burn": "颜色加深",
  "hard-light": "强光", "soft-light": "柔光", "difference": "差值", "exclusion": "排除",
};
// 组的模式下拉：穿透（默认/非隔离）置顶，其余 = 正常(隔离) + 各混合模式。对齐 PS 组下拉。
export const GROUP_MODE_LABEL: Record<string, string> = {
  "pass-through": "穿透", ...LAYER_MODE_LABEL,
};
function modeInitial(m: string) { return LAYER_MODE_INITIAL[m] || "?"; }

// 眼睛 icon SVG（v123 16→22）
const EYE_OPEN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.94 18.94 0 0 1 4.06-5.06"/><path d="M1 1l22 22"/></svg>';
// 组折叠图标 SVG（去三角，点文件夹切折叠）：展开 = 打开的文件夹；折叠 = 合上的文件夹。
const FOLDER_OPEN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H7l-3 7a1 1 0 0 1-1-1V7z"/><path d="M4 17l2.5-6.5h15L19 17a1 1 0 0 1-1 .9H5a1 1 0 0 1-1-.9z"/></svg>';
const FOLDER_CLOSED = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';

// ---- 面板-UI-本地反应式状态（折叠 / 内联重命名 / ⋯菜单）----
// 注：doc/图层结构变更的版本信号已外迁到 signals.ts 的 docVersion（跨切面共享）。
const layersUi = reactive<{
  expandedId: any;
  menuId: any;            // 打开 ⋯ 菜单的层 id（null = 无）
  renameId: any;          // 正在内联重命名的层 id（null = 无）
  collapsedIds: Set<any>; // 折叠的组 id 集合（折叠 = 不渲染 children，不影响合成）
}>({ expandedId: null, menuId: null, renameId: null, collapsedIds: new Set() });

// ---- 图层面板开关 ----
export function toggleLayersPanel(force?: boolean) {
  const hidden = els.layersPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.layersPanel.classList.toggle("hidden", !show);
  els.layersBtn.setAttribute("aria-pressed", show ? "true" : "false");
  if (show) { raiseWindow(els.layersPanel); renderLayersPanel(); }
}

// 兼容垫片：app.js 仍调它（导出名保留）—— 现在只 bumpDoc() → docVersion 信号驱动 Vue 重算。
export function renderLayersPanel() {
  bumpDoc();
}

// ---- 每层操作（逐字保留旧行为；经 ctx 绑入的 doc/history/board/setStatus）----
function _addEmptyLayer() {
  if (countLeaves(doc.layers) >= doc.maxLayers) {
    setStatus(`图层数已达上限 ${doc.maxLayers}`);
    return;
  }
  const prevActiveId = doc.activeLayer?.id ?? null;   // 持久化：undo 创建时回到创建前的活动层
  const L = doc.addLayer();
  if (!L) return;
  const loc = doc.locateNode(L.id);                   // {parentId, index}：组内新建也精确复位
  const layerSpec = layerSpecFrom(L);
  history.push({ type: "addLayer", index: loc.index, parentId: loc.parentId, layerSpec, prevActiveId });
  _afterDocChange();
}
function _deleteLayer(L: any) {
  if (!L) return;
  // 组删除：连带 children，撤销底座 = snapshotTree（保叶活引用）。
  if (L.isGroup) {
    const before = doc.snapshotTree();
    if (!doc.removeLayer(L.id)) { setStatus("至少保留一层"); return; }
    const after = doc.snapshotTree();
    history.push({ type: "treeStructure", before, after,
      undoStatus: `已恢复组「${L.name}」`, redoStatus: `已删除组「${L.name}」` });
    _afterDocChange();
    return;
  }
  const loc = doc.locateNode(L.id);                   // 先记位置（removeLayer 后就找不到了）
  const layerSpec = layerSpecFrom(L);
  if (!doc.removeLayer(L.id)) { setStatus("至少保留一层"); return; }
  history.push({ type: "removeLayer", index: loc.index, parentId: loc.parentId, layerSpec });
  compressPixelSnap(layerSpec, (blob: any) => { layerSpec.blob = blob; });
  _afterDocChange();
}
// ---- 图层组 op caller（都走 snapshotTree 结构撤销；纯结构变、零像素拷贝）----
// 新建**空**图层组（创建入口 = 「+」菜单；编组当前层已砍，靠空组 + 移入「某组」达成）。
function _addEmptyGroup() {
  const before = doc.snapshotTree();
  const g = doc.addGroup();
  history.push({ type: "treeStructure", before, after: doc.snapshotTree(),
    undoStatus: `已删除组「${g.name}」`, redoStatus: `已新建组「${g.name}」` });
  _afterDocChange();
  setStatus(`已新建图层组：${g.name}`);
}
function _ungroupLayer(L: any) {
  if (!L || !L.isGroup) return;
  const before = doc.snapshotTree();
  if (!doc.ungroup(L.id).ok) return;
  history.push({ type: "treeStructure", before, after: doc.snapshotTree(),
    undoStatus: "已重新编组", redoStatus: "已解组" });
  _afterDocChange();
  setStatus(`已解组：${L.name}`);
}
function _moveIntoGroup(L: any, groupId: any) {
  if (!L || groupId == null) return;
  const before = doc.snapshotTree();
  if (!doc.moveIntoGroup(L.id, groupId)) return;
  history.push({ type: "treeStructure", before, after: doc.snapshotTree(),
    undoStatus: "已移出组", redoStatus: "已移入组" });
  _afterDocChange();
  setStatus(`已移入组：${L.name}`);
}
function _moveOutOfGroup(L: any) {
  if (!L) return;
  const before = doc.snapshotTree();
  if (!doc.moveOutOfGroup(L.id)) return;
  history.push({ type: "treeStructure", before, after: doc.snapshotTree(),
    undoStatus: "已移回组", redoStatus: "已移出组" });
  _afterDocChange();
  setStatus(`已移出组：${L.name}`);
}
// v132：清空当前图层像素，保留图层 + 名字 + opacity / mode，bbox 归零
function _clearLayerPixels(L: any) {
  if (!L) return;
  if (L.bboxW <= 0 || L.bboxH <= 0) { setStatus("图层已经是空的"); return; }
  const before = L.snapshot();
  L.restoreFromSnapshot({ bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null, bitmap: null });
  const after = L.snapshot();
  history.push({ type: "stroke", layerId: L.id, before, after, beforeBlob: null, afterBlob: null });
  compressPixelSnap(before, (blob: any) => { before.blob = blob; });
  compressPixelSnap(after,  (blob: any) => { after.blob  = blob; });
  _afterDocChange();
  board.invalidateAll();
  setStatus(`已清空：${L.name}`);
}
// v124b 向下合并（mode-aware）：薄 caller，合并数学归 doc.mergeDownLayer，这里只翻译原因→中文 +
// 包成 mergeDown undo entry + 异步压缩快照 + 刷新。
const _MERGE_DOWN_STATUS: Record<string, string> = {
  bottom: "已经是最底层，没法向下合",
  "clipping-under": "下方是剪裁层，不能合到它上面（先取消下方的剪裁）",
};
function _mergeDownLayer(L: any) {
  if (!L) return;
  const r = doc.mergeDownLayer(L);
  if (!r.ok) {
    if (r.reason === "empty-active") { _deleteLayer(L); return; }   // active 空 → 当删 active
    setStatus(_MERGE_DOWN_STATUS[r.reason] || "无法向下合并");
    return;
  }
  history.push({
    type: "mergeDown",
    underId: r.underId,
    underBefore: r.underBefore, underAfter: r.underAfter,
    underBeforeOpacity: r.underBeforeOpacity, underBeforeMode: r.underBeforeMode,
    underBeforeClipping: r.underBeforeClipping, resultClipping: r.resultClipping,
    activeSpec: r.activeSpec, activeLoc: r.activeLoc,
  });
  compressPixelSnap(r.underBefore, (blob: any) => { r.underBefore.blob = blob; });
  compressPixelSnap(r.underAfter, (blob: any) => { r.underAfter.blob = blob; });
  if (r.activeSpec.imageData) compressPixelSnap(r.activeSpec, (blob: any) => { r.activeSpec.blob = blob; });
  _afterDocChange();
}
function _moveLayerDelta(L: any, delta: number) {
  if (!L) return;
  if (!doc.moveLayer(L.id, delta)) return;   // 同级 ±delta；撤销靠反向 delta（树安全）
  history.push({ type: "moveLayer", layerId: L.id, delta });
  _afterDocChange();
}
// v267 复制图层：模型 op 归 doc.duplicateLayer；这里包成 addLayer undo entry（undo 删新层、
//   redo 经 insertLayerAt 连像素恢复）+ 异步压缩快照。spec 显式带 clip/lockAlpha（doc.layerSpec
//   不含这两项，否则 redo 会丢）。
function _duplicateLayer(L: any) {
  if (!L) return;
  if (countLeaves(doc.layers) >= doc.maxLayers) { setStatus(`图层数已达上限 ${doc.maxLayers}`); return; }
  const prevActiveId = doc.activeLayer?.id ?? null;
  const r = doc.duplicateLayer(L.id);
  if (!r.ok) return;
  const layerSpec = { ...layerSpecFrom(r.newLayer), clippingMask: r.newLayer.clippingMask, lockAlpha: r.newLayer.lockAlpha };
  history.push({ type: "addLayer", index: r.loc.index, parentId: r.loc.parentId, layerSpec, prevActiveId });
  compressPixelSnap(layerSpec, (blob: any) => { layerSpec.blob = blob; });
  _afterDocChange();
  setStatus(`已复制：${L.name}`);
}

// ---- 每层属性变更（可见性 / 透明度 / 模式 / 剪裁 / 参考层），逐字保留旧 history 路径 ----
// 这些函数收的是 doc 活对象（live()），不是 row 快照；null 守卫兜「层在回调前被删」的竞态。
function _toggleVisible(L: any) {
  if (!L) return;
  const oldVal = L.visible;
  L.visible = !oldVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "visible", oldVal, newVal: L.visible });
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
function _setMode(L: any, newVal: string) {
  if (!L) return;
  const oldVal = L.mode;
  L.mode = newVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "mode", oldVal, newVal });
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
function _toggleClipping(L: any) {
  if (!L) return;
  const oldVal = L.clippingMask;
  L.clippingMask = !oldVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "clippingMask", oldVal, newVal: L.clippingMask });
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
// v242 锁定不透明度（alpha lock）：纯绘制约束，不改像素/合成 → 不必 invalidate 渲染，render panel 即可。
function _toggleLockAlpha(L: any) {
  if (!L) return;
  const oldVal = L.lockAlpha;
  L.lockAlpha = !oldVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "lockAlpha", oldVal, newVal: L.lockAlpha });
  renderLayersPanel();
}
function _toggleReference(L: any) {
  if (!L) return;
  const isRefNow = doc.referenceLayerId === L.id;
  const oldVal = doc.referenceLayerId;
  const newVal = isRefNow ? null : L.id;
  doc.referenceLayerId = newVal;
  history.push({ type: "setReferenceLayer", oldVal, newVal });
  renderLayersPanel();
}
function _commitRename(L: any, raw: string) {
  if (!L) return;
  const oldName = L.name;
  const v = (raw ?? "").trim();
  const newName = v || oldName;
  if (newName !== oldName) {
    L.name = newName;
    history.push({ type: "renameLayer", layerId: L.id, oldName, newName });
  }
  renderLayersPanel();
}

// 透明度 slider coalescing：**首个 input** 记 oldVal（覆盖指针拖动 + 键盘步进，后者没有 pointerdown），
// input 期间只改 layer.opacity + render + bumpDoc（百分比标签实时跟随，不动 history），
// change / pointerup / pointercancel 提交一次 —— 提交即清 oldVal，多事件到达只生效第一个。
// 一次拖动 = 一个 undo entry；键盘每步 = 一个 entry。
function _opacityLive(L: any, pct: number) {
  if (!L) return;
  L.opacity = pct / 100;
  bumpDoc();
  board.invalidateAll();
  board.requestRender();
}

// ---- 行子组件（叶 + 组）----
// 顶层 rows 已展平成 **扁平 + depth** 列表（组行 + 其 children 各占一行，按 depth 缩进），
// 本组件只渲染「一行」——组行多一个折叠三角 + 组专属 ⋯ 菜单（解组），叶行同旧。
const LayerRow = defineComponent({
  name: "LayerRow",
  props: {
    layer: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    isGroup: { type: Boolean, default: false },
    collapsed: { type: Boolean, default: false },
    childLeafCount: { type: Number, default: 0 },
    active: { type: Boolean, default: false },
    isRef: { type: Boolean, default: false },
    expanded: { type: Boolean, default: false },
    menuOpen: { type: Boolean, default: false },
    renaming: { type: Boolean, default: false },
    canUp: { type: Boolean, default: false },
    canDown: { type: Boolean, default: false },
    canDel: { type: Boolean, default: false },
    canDuplicate: { type: Boolean, default: false },
    canMergeDown: { type: Boolean, default: false },
    hasPx: { type: Boolean, default: false },
    canMoveOut: { type: Boolean, default: false },
    moveTargets: { type: Array, default: () => [] },   // 可移入的已有组 [{id,name}]
  },
  setup(props: any) {
    // snap = rows 重算时拷出的 leaf 快照（只读显示值，引用每次 bump 必变 → 反应式穿透）；
    // live = doc 里的活对象（mutation 必须走它；可能为 null —— 层已被删）。
    const snap = () => props.layer;
    const live = () => doc.findLayer(props.layer.id);
    const modeBadge = computed(() => modeInitial(snap().mode));
    const opacityPct = computed(() => Math.round(snap().opacity * 100));
    const badgeTitle = computed(() => `不透明度 ${Math.round(snap().opacity * 100)}% · 模式 ${LAYER_MODE_LABEL[snap().mode] || snap().mode}`);

    // 行 click = setActive（v154：切层时收起非选中层的折叠区）
    function onRowClick() {
      if (layersUi.expandedId !== snap().id) layersUi.expandedId = null;
      layersUi.menuId = null;
      doc.setActiveById(snap().id);
      renderLayersPanel();
    }
    // 名字 click：active 时再点 = 进入内联重命名；否则交给 row click 设 active
    function onNameClick(e: Event) {
      if (snap().id === doc.activeLayer?.id) {
        e.stopPropagation();
        layersUi.renameId = snap().id;
        nextTick(() => {
          const inp = document.querySelector(`.layer-row[data-layer-id="${snap().id}"] .layer-name-input`) as HTMLInputElement;
          if (inp) { inp.focus(); inp.select(); }
        });
      }
    }
    function onRenameCommit(e: any) {
      if (layersUi.renameId !== snap().id) return;
      layersUi.renameId = null;
      _commitRename(live(), e.target.value);
    }
    function onRenameKey(e: KeyboardEvent) {
      if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
      else if (e.key === "Escape") {
        e.preventDefault();
        layersUi.renameId = null;     // 取消：不提交，直接收起
        renderLayersPanel();
      }
    }

    function toggleBadge(e: Event) {
      e.stopPropagation();
      layersUi.expandedId = layersUi.expandedId === snap().id ? null : snap().id;
    }
    function toggleMenu(e: Event) {
      e.stopPropagation();
      layersUi.menuId = layersUi.menuId === snap().id ? null : snap().id;
    }
    function vis(e: Event) { e.stopPropagation(); _toggleVisible(live()); }

    // 透明度 slider（coalescing：首个 input 记 old —— 键盘步进没有 pointerdown 也照样进 history）
    let opaOld: any = null;
    function opaInput(e: Event) {
      const lv = live();
      if (!lv) return;
      if (opaOld === null) opaOld = lv.opacity;
      _opacityLive(lv, parseFloat((e.target as HTMLInputElement).value));
    }
    function opaCommit() {
      if (opaOld === null) return;
      const lv = live();
      if (lv && opaOld !== lv.opacity) {
        history.push({ type: "setLayerProp", layerId: lv.id, prop: "opacity", oldVal: opaOld, newVal: lv.opacity });
      }
      opaOld = null;
    }
    function modeChange(e: Event) { _setMode(live(), (e.target as HTMLSelectElement).value); }

    // 组折叠三角（仅组行）。折叠态在 layersUi.collapsedIds（不影响合成，纯 UI）。
    function toggleCollapse(e: Event) {
      e.stopPropagation();
      const id = snap().id;
      if (layersUi.collapsedIds.has(id)) layersUi.collapsedIds.delete(id);
      else layersUi.collapsedIds.add(id);
    }

    // ⋯ 菜单动作
    function act(a: string) {
      layersUi.menuId = null;
      if (a === "rename") {
        layersUi.renameId = snap().id;
        nextTick(() => {
          const inp = document.querySelector(`.layer-row[data-layer-id="${snap().id}"] .layer-name-input`) as HTMLInputElement;
          if (inp) { inp.focus(); inp.select(); }
        });
      }
      else if (a === "duplicate") _duplicateLayer(live());   // v267：上移/下移已移到底栏指令栏
      else if (a === "mergeDown") _mergeDownLayer(live());
      else if (a === "clear")     _clearLayerPixels(live());
      else if (a === "del")       _deleteLayer(live());
      // 图层组动作（编组已移到「+」菜单 = 新建空组；这里只留 reparent）
      else if (a === "ungroup")   _ungroupLayer(live());
      else if (a === "moveOut")   _moveOutOfGroup(live());
    }
    // 移入指定的已有组（high：把外面的层加入已知组，不限于上方相邻）
    function moveInto(groupId: any) { layersUi.menuId = null; _moveIntoGroup(live(), groupId); }

    // 层重排 = ⋯ 菜单的「上移/下移」（_moveLayerDelta）。早先定：不做行拖拽（iPad 触屏 drag-drop 不可靠）。
    function toggleClip(e: Event) { e.stopPropagation(); _toggleClipping(live()); }
    function toggleRef(e: Event) { e.stopPropagation(); _toggleReference(live()); }
    function toggleLock(e: Event) { e.stopPropagation(); _toggleLockAlpha(live()); }

    // 不缩进（Q2：左竖条方案）：组内层（depth>0）靠左竖色条标归属，只留极小的每级位移（rail 宽）。
    const railPad = computed(() => 6 + props.depth * 9);    // px：rail 自身宽，非传统缩进
    const modeOptions = computed(() => (props.isGroup ? GROUP_MODE_LABEL : LAYER_MODE_LABEL));

    return {
      modeBadge, opacityPct, badgeTitle, layersUi, railPad, modeOptions,
      EYE_OPEN, EYE_OFF, FOLDER_OPEN, FOLDER_CLOSED, LAYER_MODE_LABEL,
      onRowClick, onNameClick, onRenameCommit, onRenameKey,
      toggleBadge, toggleMenu, vis, toggleCollapse,
      opaInput, opaCommit, modeChange, act, moveInto,
      toggleClip, toggleRef, toggleLock,
    };
  },
  template: `
    <div
      class="layer-row"
      :class="{ active, clipping: layer.clippingMask, reference: isRef, 'layer-group-row': isGroup, 'layer-nested': depth > 0 }"
      :style="{ marginLeft: railPad + 'px' }"
      :data-layer-id="String(layer.id)"
      @click="onRowClick"
    >
      <!-- 组：文件夹图标点击折叠（去三角）；叶不显图标。不缩进，组内层靠 .layer-nested 的左竖条标归属。 -->
      <button v-if="isGroup" type="button" class="layer-folder" :title="collapsed ? '展开组' : '折叠组'"
        @click="toggleCollapse" v-html="collapsed ? FOLDER_CLOSED : FOLDER_OPEN"></button>

      <button type="button" class="layer-vis" :class="{ 'hidden-icon': !layer.visible }"
        :title="layer.visible ? '可见' : '已隐藏'"
        @click="vis"
        v-html="layer.visible ? EYE_OPEN : EYE_OFF"></button>

      <input v-if="renaming" type="text" class="layer-name-input" :value="layer.name"
        @click.stop @blur="onRenameCommit" @keydown="onRenameKey" />
      <span v-else class="layer-name" @click="onNameClick">{{ layer.name }}<span v-if="isGroup && collapsed" class="layer-group-count"> ({{ childLeafCount }})</span></span>

      <span v-if="layer.clippingMask" class="layer-clip-chip" title="已剪裁到下方第一颗非剪裁层">↘</span>
      <span v-if="!isGroup && layer.lockAlpha" class="layer-lock-chip" title="锁定不透明度：笔只改已有像素的颜色">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </span>
      <span v-if="isRef" class="layer-ref-chip" title="参考层：魔棒 / 油漆桶读这一层">参</span>

      <button type="button" class="layer-tools-btn" title="图层菜单" @click="toggleMenu">⋯</button>

      <button type="button" class="layer-mode-badge" :class="{ active: expanded }"
        :title="badgeTitle" @click="toggleBadge">{{ modeBadge }}</button>

      <div v-if="menuOpen" class="menu-panel layer-tools-popup" @click.stop>
        <button class="menu-item" type="button" @click="act('rename')"><span class="menu-item-label">重命名…</span></button>

        <!-- 叶专属：复制 -->
        <button v-if="!isGroup" class="menu-item" type="button" :disabled="!canDuplicate" @click="act('duplicate')"><span class="menu-item-label">复制图层</span></button>

        <!-- 图层组 reparent：解组（仅组）/ 移入「某组」（所有可选已有组，high）/ 移出组。编组 = 「+」里新建空组 -->
        <hr class="menu-sep" v-if="isGroup || moveTargets.length || canMoveOut" />
        <button v-if="isGroup" class="menu-item" type="button" @click="act('ungroup')"><span class="menu-item-label">解组</span></button>
        <button v-for="g in moveTargets" :key="'mi'+g.id" class="menu-item" type="button" @click="moveInto(g.id)"><span class="menu-item-label">移入「{{ g.name }}」</span></button>
        <button v-if="canMoveOut" class="menu-item" type="button" @click="act('moveOut')"><span class="menu-item-label">移出组</span></button>

        <hr class="menu-sep" />
        <!-- v267 (user)：层属性 toggle 收进 ⋯ 菜单（点了不关菜单，可连续切） -->
        <button v-if="!isGroup" class="menu-item layer-menu-toggle" type="button" @click="toggleLock"><span class="layer-menu-check">{{ layer.lockAlpha ? '☑' : '☐' }}</span><span class="menu-item-label">锁定不透明度</span></button>
        <button class="menu-item layer-menu-toggle" type="button" @click="toggleClip"><span class="layer-menu-check">{{ layer.clippingMask ? '☑' : '☐' }}</span><span class="menu-item-label">剪裁{{ isGroup ? '组' : '' }}</span></button>
        <button v-if="!isGroup" class="menu-item layer-menu-toggle" type="button" @click="toggleRef"><span class="layer-menu-check">{{ isRef ? '☑' : '☐' }}</span><span class="menu-item-label">参考层</span></button>

        <hr class="menu-sep" />
        <button v-if="!isGroup" class="menu-item" type="button" :disabled="!canMergeDown" @click="act('mergeDown')"><span class="menu-item-label">向下合并</span></button>
        <button v-if="!isGroup" class="menu-item" type="button" :disabled="!hasPx" @click="act('clear')"><span class="menu-item-label">清空内容</span></button>
        <button class="menu-item menu-danger" type="button" :disabled="!canDel" @click="act('del')"><span class="menu-item-label">{{ isGroup ? '删除组' : '删除' }}</span></button>
      </div>
    </div>

    <div v-if="expanded" class="layer-row-expand" :style="{ marginLeft: railPad + 'px' }" @click.stop>
      <label class="layer-slider-row">
        <span>透</span>
        <input type="range" min="0" max="100" :value="opacityPct"
          @input="opaInput" @change="opaCommit" @pointerup="opaCommit" @pointercancel="opaCommit" @click.stop />
        <span class="layer-slider-val">{{ opacityPct }}</span>
      </label>
      <label class="layer-slider-row">
        <span>模式</span>
        <select style="grid-column: span 2;" :value="layer.mode" @change="modeChange" @click.stop>
          <option v-for="(lbl, val) in modeOptions" :key="val" :value="val">{{ lbl }}</option>
        </select>
      </label>
      <!-- v267 (user)：剪裁 / 锁α / 参考 toggle 已收进 ⋯ 菜单，折叠区只留 透明度 + 模式 -->
    </div>
  `,
});

// ---- 顶层组件：数据驱动列表（读 docVersion 后快照 doc.layers，倒序：UI 顶 = 栈顶）----
const LayersPanel = defineComponent({
  name: "LayersPanel",
  components: { LayerRow },
  setup() {
    // 倒序行视图（含每行能力位），gated on version 信号。
    // layer 传 **leaf 快照**而非活引用（leaf-by-value 硬规则，见文件头）：每次 bump 拷新对象，
    // props 引用必变 → 子组件必更新、子组件 computed 必失效。活引用会被 Vue 的 props
    // 相等性检查 + computed 依赖缓存双重截断 → UI 永久冻结在首次求值（v230 及之前的实况）。
    // 递归建**扁平 + depth** 行视图（UI 顶 = 栈顶 → 每级倒序）。组行 + 其 children（未折叠时）。
    // 每行 leaf-by-value 快照（含 isGroup）；能力位按**同级**边界算。
    const rows = computed(() => {
      void docVersion.value;   // 依赖跨切面信号：bumpDoc() 即重算
      const out: any[] = [];
      const activeId = doc.activeId;
      const totalLeaves = countLeaves(doc.layers);
      // 全部组（id+name+node ref）：给「移入组」列表用。算一次，每行再按「非自身/非后代/非当前父」过滤。
      const allGroups: any[] = [];
      const collect = (nodes: any[]) => { for (const n of nodes) if (n.isGroup) { allGroups.push(n); collect(n.children); } };
      collect(doc.layers);
      const walk = (nodes: any[], depth: number, parentNode: any) => {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          // 该节点可移入的目标组：排除自身、自身后代（防环）、当前所在组（已在里面）。
          const moveTargets = allGroups
            .filter((g) => g.id !== n.id && g !== parentNode && !(n.isGroup && findNodeById(n.children, g.id)))
            .map((g) => ({ id: g.id, name: g.name }));
          const base = {
            depth,
            isGroup: !!n.isGroup,
            active: n.id === activeId,
            canUp: i < nodes.length - 1,
            canDown: i > 0,
            canDel: totalLeaves > 1,
            canMoveOut: depth > 0,                                       // 在组内 → 可移出
            moveTargets,                                                 // 可移入的已有组（high：把外面的层加入已知组）
            layer: { id: n.id, name: n.name, visible: n.visible, opacity: n.opacity, mode: n.mode, clippingMask: n.clippingMask, lockAlpha: n.lockAlpha, isGroup: !!n.isGroup },
          };
          if (n.isGroup) {
            const collapsed = layersUi.collapsedIds.has(n.id);
            out.push({ ...base, collapsed, isRef: false, canDuplicate: false, canMergeDown: false, hasPx: false, childLeafCount: countLeaves(n.children) });
            if (!collapsed) walk(n.children, depth + 1, n);
          } else {
            out.push({
              ...base, collapsed: false,
              isRef: doc.referenceLayerId === n.id,
              canDuplicate: totalLeaves < doc.maxLayers,
              // v258：剪裁层可向下合并（裁到基底）。禁止：下方是剪裁层而本层不是；下方是组（不能合进组）。
              canMergeDown: i > 0 && !nodes[i - 1].isGroup && !(nodes[i - 1].clippingMask && !n.clippingMask),
              hasPx: n.bboxW > 0 && n.bboxH > 0,
            });
          }
        }
      };
      walk(doc.layers, 0, null);
      return out;
    });
    return { rows, layersUi };
  },
  template: `
    <template v-for="r in rows" :key="r.layer.id">
      <LayerRow
        :layer="r.layer"
        :depth="r.depth"
        :is-group="r.isGroup"
        :collapsed="r.collapsed"
        :child-leaf-count="r.childLeafCount"
        :active="r.active"
        :is-ref="r.isRef"
        :expanded="layersUi.expandedId === r.layer.id"
        :menu-open="layersUi.menuId === r.layer.id"
        :renaming="layersUi.renameId === r.layer.id"
        :can-up="r.canUp" :can-down="r.canDown" :can-del="r.canDel"
        :can-duplicate="r.canDuplicate" :can-merge-down="r.canMergeDown" :has-px="r.hasPx"
        :can-move-out="r.canMoveOut" :move-targets="r.moveTargets"
      />
    </template>
  `,
});

let _vueApp: any = null;

// 面板外 chrome 同步（计数标签 / 加按钮禁用 / 删按钮禁用 / 滚到活动层）—— 这些 DOM 不在 mount
// 容器内，由 docVersion watch 驱动（取代旧 renderLayersPanel 末尾的命令式赋值）。
function _syncChrome() {
  const max = doc.maxLayers;
  const leaves = countLeaves(doc.layers);
  els.layersCountLabel.textContent = `${leaves} / ${max}`;
  els.layerAddBtn.disabled = leaves >= max;
  const delBtn = document.getElementById("layerDeleteBtn") as HTMLButtonElement;
  if (delBtn) delBtn.disabled = leaves <= 1;
  // v267 上移/下移按钮按活动节点的**同级**边界禁用（树化：top/bottom 按同级算）
  const upBtn = document.getElementById("layerMoveUpBtn") as HTMLButtonElement;
  const downBtn = document.getElementById("layerMoveDownBtn") as HTMLButtonElement;
  if (upBtn) upBtn.disabled = !doc.canMoveLayer(doc.activeId, 1);
  if (downBtn) downBtn.disabled = !doc.canMoveLayer(doc.activeId, -1);
  nextTick(() => {
    els.layersList.querySelector(".layer-row.active")?.scrollIntoView({ block: "nearest" });
  });
}

let _layersDrag: any = null;

export function initLayersPanel(ctx) {
  ({ doc, board, history, setStatus, afterDocChange: _afterDocChange, layerSpecFrom } = ctx);

  // 挂 Vue 应用到图层列表容器（旧 renderLayersPanel 渲染进的 #layersList）。
  _vueApp = createApp(LayersPanel);
  _vueApp.mount(els.layersList);
  // chrome 副作用：docVersion 变即同步面板外 DOM（+ 初始同步一次）
  watch(() => docVersion.value, _syncChrome);
  _syncChrome();

  // 点击别处收起打开的 ⋯ 菜单（取代旧 popup 的 outside-pointerdown）
  document.addEventListener("pointerdown", (e: any) => {
    if (layersUi.menuId == null) return;
    if (!e.target.closest(".layer-tools-popup") && !e.target.closest(".layer-tools-btn")) {
      layersUi.menuId = null;
    }
  }, true);

  window.addEventListener("wp:toggleLayers", () => toggleLayersPanel());

  els.layersBtn.addEventListener("click", () => toggleLayersPanel());
  els.layersPanelClose.addEventListener("click", () => toggleLayersPanel(false));

  // 拖动 layers 面板（沿用 color panel 模式）
  els.layersPanelHead.addEventListener("pointerdown", (e: any) => {
    if (e.target.closest(".float-panel-close")) return;
    const r = els.layersPanel.getBoundingClientRect();
    _layersDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.layersPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.layersPanelHead.addEventListener("pointermove", (e: any) => {
    if (!_layersDrag || e.pointerId !== _layersDrag.id) return;
    const w = els.layersPanel.offsetWidth;
    const h = els.layersPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, _layersDrag.ol + (e.clientX - _layersDrag.sx)));
    const top  = Math.max(0, Math.min(window.innerHeight - h, _layersDrag.ot + (e.clientY - _layersDrag.sy)));
    els.layersPanel.style.left = left + "px";
    els.layersPanel.style.right = "auto";
    els.layersPanel.style.top = top + "px";
    safeLSSet("webpaint.layersPanel.pos", JSON.stringify({ left, top }));
  });
  els.layersPanelHead.addEventListener("pointerup", (e: any) => {
    if (_layersDrag && e.pointerId === _layersDrag.id) {
      try { els.layersPanelHead.releasePointerCapture(e.pointerId); } catch {}
      _layersDrag = null;
    }
  });
  // 还原上次位置
  const saved = safeLS("webpaint.layersPanel.pos");
  if (saved) {
    try {
      const o = JSON.parse(saved);
      els.layersPanel.style.left = o.left + "px";
      els.layersPanel.style.right = "auto";
      els.layersPanel.style.top = o.top + "px";
    } catch {}
  }

  // v267 指令栏：+（弹菜单：新图层 / 导入图片）· 上移 · 下移 · 删除。命令全走深模块 caller，UI 只调。
  const addPopup = document.getElementById("layerAddPopup");
  const closeAddPopup = () => addPopup?.classList.add("hidden");
  els.layerAddBtn.addEventListener("click", (e: any) => {
    e.stopPropagation();
    addPopup?.classList.toggle("hidden");
  });
  document.getElementById("layerAddNewBtn")?.addEventListener("click", () => { closeAddPopup(); _addEmptyLayer(); });
  document.getElementById("layerAddGroupBtn")?.addEventListener("click", () => { closeAddPopup(); _addEmptyGroup(); });
  // 导入图片到新层：实际逻辑由 import-image.ts 给 layerImportPhotoBtn 接线，这里只负责收起菜单。
  document.getElementById("layerImportPhotoBtn")?.addEventListener("click", closeAddPopup);
  // 点别处收起 "+" 菜单
  document.addEventListener("pointerdown", (e: any) => {
    if (addPopup?.classList.contains("hidden")) return;
    if (!e.target.closest("#layerAddPopup") && !e.target.closest("#layerAddBtn")) closeAddPopup();
  }, true);

  document.getElementById("layerMoveUpBtn")?.addEventListener("click", () => {
    if (doc.activeLayer) _moveLayerDelta(doc.activeLayer, 1);
  });
  document.getElementById("layerMoveDownBtn")?.addEventListener("click", () => {
    if (doc.activeLayer) _moveLayerDelta(doc.activeLayer, -1);
  });
  document.getElementById("layerDeleteBtn")?.addEventListener("click", () => {
    if (doc.activeLayer) _deleteLayer(doc.activeLayer);
  });
}
