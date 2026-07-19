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
import { countLeaves, findNodeById } from "./doc.ts";
import { t } from "./i18n/index.ts";
import type { Layer, LayerGroup } from "./doc.ts";
import { docVersion, bumpDoc } from "./signals.ts";
import { els } from "./els.ts";
import { editorState } from "./editor-state.ts";
import { raiseWindow } from "./surfaces.ts";
import { compressPixelSnap } from "./pixel-edit.ts";
import { runTreeOp } from "./tree-ops.ts";   // 树结构变更的提交信封（见该模块头注释）
import type { AppContext } from "./app-context.ts";
import { iconHtml } from "./ui/icon.ts";

// doc 图层活对象（树节点 = 叶 Layer | 组 LayerGroup）。引擎类型化后直接对齐其 Node 联合，
// 不再维护发散本地形状（doc.ts 的 Node 未 export → 此处用导出的两个 class 重建联合）。
// null 守卫兜「层在回调前被删」。
type LayerNode = Layer | LayerGroup;
// compressPixelSnap 收的像素快照形状（pixel-edit.ts 的 PixelSnap 未 export → 借函数签名取之）。
type PixelSnap = NonNullable<Parameters<typeof compressPixelSnap>[0]>;
// layer-undo.layerSpecFrom / L.snapshot() 产出的可变 spec（异步压缩回填 .blob）。
// 引擎方法收 PixelSnap：本地 spec 须与其像素字段对齐（imageData 是 ImageData|null，非 unknown）。
interface LayerSpec extends PixelSnap { blob?: Blob | null; [k: string]: unknown; }

// 传过 Vue 边界的 leaf-by-value 快照（每次 bump 拷新对象，见文件头硬规则）。
interface LayerLeafSnap {
  id: number; name: string; visible: boolean; opacity: number; mode: string;
  clippingMask: boolean; lockAlpha: boolean; isGroup: boolean;
}
interface MoveTarget { id: number; name: string; }
// 一行的数据（rows computed 的元素）。
interface LayerRowData {
  depth: number; isGroup: boolean; active: boolean; canUp: boolean; canDown: boolean;
  canDel: boolean; canMoveOut: boolean; moveTargets: MoveTarget[]; layer: LayerLeafSnap;
  collapsed: boolean; isRef: boolean; canDuplicate: boolean; canMergeDown: boolean;
  hasPx: boolean; childLeafCount?: number;
}
// <LayerRow> setup 里读到的 props（其余 props 只在 template 用）。
interface LayerRowProps { layer: LayerLeafSnap; depth: number; isGroup: boolean; }

let doc: AppContext["doc"], board: AppContext["board"], history: AppContext["history"], setStatus: AppContext["setStatus"];
let pixelHistory: AppContext["pixelHistory"];
// 留在 app.js、经 ctx 绑入的协作件（被非图层代码也调用）
let _afterDocChange: AppContext["afterDocChange"], layerSpecFrom: AppContext["layerSpecFrom"];

// 图层模式 → 单字符 badge (Procreate 风格)。语言中性缩写（P=pass-through）。
const LAYER_MODE_INITIAL: Record<string, string> = {
  "pass-through": "P",
  "source-over": "N", "multiply": "M", "screen": "S", "overlay": "O",
  "darken": "Da", "lighten": "Li", "color-dodge": "CD", "color-burn": "CB",
  "hard-light": "HL", "soft-light": "SL", "difference": "Df", "exclusion": "Ex",
};
// 混合模式名 = i18n 单一源（模块 eval 时按当前语言建一次；reload 制，lang 固定）。
export const LAYER_MODE_LABEL: Record<string, string> = {
  "source-over": t("mode.normal"), "multiply": t("mode.multiply"), "screen": t("mode.screen"), "overlay": t("mode.overlay"),
  "darken": t("mode.darken"), "lighten": t("mode.lighten"), "color-dodge": t("mode.colorDodge"), "color-burn": t("mode.colorBurn"),
  "hard-light": t("mode.hardLight"), "soft-light": t("mode.softLight"), "difference": t("mode.difference"), "exclusion": t("mode.exclusion"),
};
// 组的模式下拉：穿透（默认/非隔离）置顶，其余 = 正常(隔离) + 各混合模式。对齐 PS 组下拉。
export const GROUP_MODE_LABEL: Record<string, string> = {
  "pass-through": t("mode.passThrough"), ...LAYER_MODE_LABEL,
};
function modeInitial(m: string) { return LAYER_MODE_INITIAL[m] || "?"; }

// 眼睛 icon SVG（v123 16→22）
const EYE_OPEN = iconHtml("visibility-show", { size: 22 });
const EYE_OFF = iconHtml("visibility-hide", { size: 22 });
// 组折叠图标 SVG（去三角，点文件夹切折叠）：展开 = 打开的文件夹；折叠 = 合上的文件夹。
const FOLDER_OPEN = iconHtml("folder-open", { size: 20 });
const FOLDER_CLOSED = iconHtml("folder", { size: 20 });

// ---- 面板-UI-本地反应式状态（折叠 / 内联重命名 / ⋯菜单）----
// 注：doc/图层结构变更的版本信号已外迁到 signals.ts 的 docVersion（跨切面共享）。
const layersUi = reactive<{
  expandedId: number | null;
  menuId: number | null;            // 打开 ⋯ 菜单的层 id（null = 无）
  renameId: number | null;          // 正在内联重命名的层 id（null = 无）
  collapsedIds: Set<number>; // 折叠的组 id 集合（折叠 = 不渲染 children，不影响合成）
}>({ expandedId: null, menuId: null, renameId: null, collapsedIds: new Set() });

// ---- 图层面板开关 ----
export function toggleLayersPanel(force?: boolean) {
  const hidden = els.layersPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.layersPanel.classList.toggle("hidden", !show);
  els.layersBtn.setAttribute("aria-pressed", show ? "true" : "false");
  // 开关状态随文档走：写进 editorState（setter 自动标记 workspace dirty）。
  editorState.layersPanel.enabled = show;
  if (show) { raiseWindow(els.layersPanel); renderLayersPanel(); }
}

// doc 的 editorState 加载/重置后，把面板开关 + 位置**只读地**应用到 DOM（绝不回写 editorState → 不误标 dirty）。
// 直接走裸 DOM 开关，不经 toggleLayersPanel（那条路径会写 editorState）。session-state 在 editorState 就绪后派发 wp:applyEditorState。
function applyLayersPanelFromEditorState() {
  const pos = editorState.layersPanel.position;   // {left,top} | null（null = 自动摆放，不动位置）
  if (pos) {
    els.layersPanel.style.left = pos.left + "px";
    els.layersPanel.style.right = "auto";
    els.layersPanel.style.top = pos.top + "px";
  }
  const enabled = editorState.layersPanel.enabled;
  els.layersPanel.classList.toggle("hidden", !enabled);
  els.layersBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
  if (enabled) { raiseWindow(els.layersPanel); renderLayersPanel(); }
}

// 兼容垫片：app.js 仍调它（导出名保留）—— 现在只 bumpDoc() → docVersion 信号驱动 Vue 重算。
export function renderLayersPanel() {
  bumpDoc();
}

// ---- 每层操作（逐字保留旧行为；经 ctx 绑入的 doc/history/board/setStatus）----
function _addEmptyLayer() {
  if (countLeaves(doc.layers) >= doc.maxLayers) {
    setStatus(t("lp.st.maxLayers", { n: doc.maxLayers }));
    return;
  }
  const prevActiveId = doc.activeLayer?.id ?? null;   // 持久化：undo 创建时回到创建前的活动层
  const L = doc.addLayer();
  if (!L) return;
  const loc = doc.locateNode(L.id)!;                   // {parentId, index}：组内新建也精确复位
  const layerSpec = layerSpecFrom(L) as unknown as LayerSpec;   // LayerSpecShape→LayerSpec（同对象，后者带 index sig，经 unknown 转）
  history.push({ type: "addLayer", index: loc.index, parentId: loc.parentId, layerSpec, prevActiveId });
  _afterDocChange();
}
function _deleteLayer(L: LayerNode | null) {
  if (!L) return;
  // 组删除：连带 children，撤销底座 = snapshotTree（保叶活引用）。
  // 允许删非空组（含删到 0 叶）—— 删空了就补一张空层保 ≥1 叶（不卡在「非空组删不掉」）。
  if (L.isGroup) {
    runTreeOp(
      { undo: t("lp.st.restoredGroup", { name: L.name }), redo: t("lp.st.deletedGroup", { name: L.name }) },
      () => {
        doc.removeLayer(L.id, true);
        if (countLeaves(doc.layers) === 0) doc.addLayer();   // 清空 → 补空层
      },
    );
    return;
  }
  const loc = doc.locateNode(L.id)!;                   // 先记位置（removeLayer 后就找不到了）
  const layerSpec = layerSpecFrom(L) as unknown as LayerSpec;   // LayerSpecShape→LayerSpec（同对象，后者带 index sig，经 unknown 转）
  if (!doc.removeLayer(L.id)) { setStatus(t("lp.st.keepOne")); return; }
  history.push({ type: "removeLayer", index: loc.index, parentId: loc.parentId, layerSpec });
  compressPixelSnap(layerSpec, (blob: Blob | null) => { layerSpec.blob = blob; });
  _afterDocChange();
}
// ---- 图层组 op caller（都走 snapshotTree 结构撤销；纯结构变、零像素拷贝）----
// 新建**空**图层组（创建入口 = 「+」菜单；编组当前层已砍，靠空组 + 移入「某组」达成）。
function _addEmptyGroup() {
  let g: ReturnType<typeof doc.addGroup>;
  // labels 传函数 → 在 applyFn 之后求值（组名要等 addGroup() 返回才知道）。
  runTreeOp(
    () => ({ undo: t("lp.st.deletedGroup", { name: g.name }), redo: t("lp.st.newGroup", { name: g.name }),
             status: t("lp.st.newGroupColon", { name: g.name }) }),
    () => { g = doc.addGroup(); },
  );
}
function _ungroupLayer(L: LayerNode | null) {
  if (!L || !L.isGroup) return;
  runTreeOp(
    { undo: t("lp.st.regrouped"), redo: t("lp.st.ungrouped"), status: t("lp.st.ungroupedName", { name: L.name }) },
    () => doc.ungroup(L.id).ok,
  );
}
function _moveIntoGroup(L: LayerNode | null, groupId: number) {
  if (!L || groupId == null) return;
  runTreeOp(
    { undo: t("lp.st.movedOut"), redo: t("lp.st.movedIn"), status: t("lp.st.movedInColon", { name: L.name }) },
    () => doc.moveIntoGroup(L.id, groupId),
  );
}
function _moveOutOfGroup(L: LayerNode | null) {
  if (!L) return;
  runTreeOp(
    { undo: t("lp.st.movedBack"), redo: t("lp.st.movedOut"), status: t("lp.st.movedOutColon", { name: L.name }) },
    () => doc.moveOutOfGroup(L.id),
  );
}
// v132：清空当前图层像素，保留图层 + 名字 + opacity / mode，bbox 归零
function _clearLayerPixels(L: LayerNode | null) {
  if (!L) return;
  // 清空像素是叶专属 op（template gates on !isGroup）；组无 bbox/snapshot → 就地 as Layer 视之。
  if ((L as Layer).bboxW <= 0 || (L as Layer).bboxH <= 0) { setStatus(t("lp.st.alreadyEmpty")); return; }
  // 走 PixelEdit 事务（**唯一** stroke entry 构造点）。曾经这里手搓 entry，且把压缩结果写进
  //   `before.blob` 而 handler 读的是 `e.beforeBlob` → 压缩一落地 imageData 被置 null、两头皆空 →
  //   撤销恢复出「旧 bbox + 零像素」，静默丢画且是竞态（压缩前撤销反而正常）。见 v439。
  const tx = pixelHistory.begin(L as Layer, "stroke");
  (L as Layer).clearAll();
  if (!tx.commit()) return;
  _afterDocChange();
  board.invalidateAll();
  setStatus(t("lp.st.cleared", { name: L.name }));
}
// v124b 向下合并（mode-aware）：薄 caller，合并数学归 doc.mergeDownLayer，这里只翻译原因→中文 +
// 包成 mergeDown undo entry + 异步压缩快照 + 刷新。
const _MERGE_DOWN_STATUS: Record<string, string> = {
  bottom: t("lp.st.mergeBottom"),
  "clipping-under": t("lp.st.mergeClipUnder"),
};
function _mergeDownLayer(L: LayerNode | null) {
  if (!L) return;
  const r = doc.mergeDownLayer(L as Layer);   // 向下合并是叶专属 op（template gates on !isGroup）
  if (!r.ok) {
    if (r.reason === "empty-active") { _deleteLayer(L); return; }   // active 空 → 当删 active
    setStatus(_MERGE_DOWN_STATUS[r.reason ?? ""] || t("lp.st.mergeFail"));
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
  // underBefore/After = Layer.snapshot() 像素 snap（无 blob 字段，异步压缩回填）；闭包内 r.ok
  // 收窄不保留 → 沿 LayerSpec 视之（PixelSnap + 可选 blob，运行期同一对象引用）。
  compressPixelSnap(r.underBefore as LayerSpec, (blob: Blob | null) => { (r.underBefore as LayerSpec).blob = blob; });
  compressPixelSnap(r.underAfter as LayerSpec, (blob: Blob | null) => { (r.underAfter as LayerSpec).blob = blob; });
  const aspec = r.activeSpec as unknown as LayerSpec;   // mergeDown 结果 spec（doc.js 未类型化，blob 初始 null）
  if (aspec.imageData) compressPixelSnap(aspec, (blob: Blob | null) => { aspec.blob = blob; });
  _afterDocChange();
}
function _moveLayerDelta(L: LayerNode | null, delta: number) {
  if (!L) return;
  if (!doc.moveLayer(L.id, delta)) return;   // 同级 ±delta；撤销靠反向 delta（树安全）
  history.push({ type: "moveLayer", layerId: L.id, delta });
  _afterDocChange();
}
// v267 复制图层：模型 op 归 doc.duplicateLayer；这里包成 addLayer undo entry（undo 删新层、
//   redo 经 insertLayerAt 连像素恢复）+ 异步压缩快照。spec 显式带 clip/lockAlpha（doc.layerSpec
//   不含这两项，否则 redo 会丢）。
function _duplicateLayer(L: LayerNode | null) {
  if (!L) return;
  if (countLeaves(doc.layers) >= doc.maxLayers) { setStatus(t("lp.st.maxLayers", { n: doc.maxLayers })); return; }
  const prevActiveId = doc.activeLayer?.id ?? null;
  const r = doc.duplicateLayer(L.id);
  if (!r.ok) return;
  const newLayer = r.newLayer!;
  const layerSpec = { ...(layerSpecFrom(newLayer) as unknown as LayerSpec), clippingMask: newLayer.clippingMask, lockAlpha: newLayer.lockAlpha };
  history.push({ type: "addLayer", index: r.loc!.index, parentId: r.loc!.parentId, layerSpec, prevActiveId });
  compressPixelSnap(layerSpec, (blob: Blob | null) => { layerSpec.blob = blob; });
  _afterDocChange();
  setStatus(t("lp.st.duplicated", { name: L.name }));
}

// ---- 每层属性变更（可见性 / 透明度 / 模式 / 剪裁 / 参考层），逐字保留旧 history 路径 ----
// 这些函数收的是 doc 活对象（live()），不是 row 快照；null 守卫兜「层在回调前被删」的竞态。
function _toggleVisible(L: LayerNode | null) {
  if (!L) return;
  const oldVal = L.visible;
  L.visible = !oldVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "visible", oldVal, newVal: L.visible });
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
function _setMode(L: LayerNode | null, newVal: string) {
  if (!L) return;
  const oldVal = L.mode;
  L.mode = newVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "mode", oldVal, newVal });
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
function _toggleClipping(L: LayerNode | null) {
  if (!L) return;
  const oldVal = L.clippingMask;
  L.clippingMask = !oldVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "clippingMask", oldVal, newVal: L.clippingMask });
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}
// v242 锁定不透明度（alpha lock）：纯绘制约束，不改像素/合成 → 不必 invalidate 渲染，render panel 即可。
function _toggleLockAlpha(L: LayerNode | null) {
  if (!L) return;
  // 锁 α 是叶专属 toggle（template gates on !isGroup）；组无 lockAlpha → 就地 as Layer 视之。
  const oldVal = (L as Layer).lockAlpha;
  (L as Layer).lockAlpha = !oldVal;
  history.push({ type: "setLayerProp", layerId: L.id, prop: "lockAlpha", oldVal, newVal: (L as Layer).lockAlpha });
  renderLayersPanel();
}
function _toggleReference(L: LayerNode | null) {
  if (!L) return;
  const isRefNow = doc.referenceLayerId === L.id;
  const oldVal = doc.referenceLayerId;
  const newVal = isRefNow ? null : L.id;
  doc.referenceLayerId = newVal;
  history.push({ type: "setReferenceLayer", oldVal, newVal });
  renderLayersPanel();
}
function _commitRename(L: LayerNode | null, raw: string) {
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
function _opacityLive(L: LayerNode | null, pct: number) {
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
  setup(props: LayerRowProps) {
    // snap = rows 重算时拷出的 leaf 快照（只读显示值，引用每次 bump 必变 → 反应式穿透）；
    // live = doc 里的活对象（mutation 必须走它；可能为 null —— 层已被删）。
    const snap = () => props.layer;
    const live = () => doc.findLayer(props.layer.id);
    const modeBadge = computed(() => modeInitial(snap().mode));
    const opacityPct = computed(() => Math.round(snap().opacity * 100));
    const badgeTitle = computed(() => t("lp.badge", { o: Math.round(snap().opacity * 100), m: LAYER_MODE_LABEL[snap().mode] || snap().mode }));

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
    function onRenameCommit(e: Event) {
      if (layersUi.renameId !== snap().id) return;
      layersUi.renameId = null;
      _commitRename(live(), (e.target as HTMLInputElement).value);
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
    let opaOld: number | null = null;
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
    // 移入选中的已有组（high：把外面的层加入已知组，不限上方相邻；dropdown 不挤占菜单）
    function onMoveSelect(e: Event) {
      const v = (e.target as HTMLSelectElement).value;
      if (!v) return;
      layersUi.menuId = null;
      _moveIntoGroup(live(), parseInt(v, 10));
    }

    // 层重排 = ⋯ 菜单的「上移/下移」（_moveLayerDelta）。早先定：不做行拖拽（iPad 触屏 drag-drop 不可靠）。
    function toggleClip(e: Event) { e.stopPropagation(); _toggleClipping(live()); }
    function toggleRef(e: Event) { e.stopPropagation(); _toggleReference(live()); }
    function toggleLock(e: Event) { e.stopPropagation(); _toggleLockAlpha(live()); }

    // 不缩进（Q2：左竖条方案）：组内层（depth>0）靠左竖色条标归属，只留极小的每级位移（rail 宽）。
    const railPad = computed(() => 6 + props.depth * 9);    // px：rail 自身宽，非传统缩进
    const modeOptions = computed(() => (props.isGroup ? GROUP_MODE_LABEL : LAYER_MODE_LABEL));

    // i18n 模板标签清单：t() 在 setup 调（§5a 纪律，key 受 tsc 检查），模板只引 L.*。
    const L = {
      visible: t("lp.visible"), hidden: t("lp.hidden"), expandGroup: t("lp.expandGroup"), collapseGroup: t("lp.collapseGroup"),
      clippedTip: t("lp.clippedTip"), lockAlphaTip: t("lp.lockAlphaTip"), refTip: t("lp.refTip"), refChip: t("lp.refChip"),
      layerMenu: t("lp.layerMenu"), rename: t("lp.rename"), duplicate: t("lp.duplicate"), ungroup: t("lp.ungroup"),
      moveIntoGroup: t("lp.moveIntoGroup"), choose: t("lp.choose"), moveOut: t("lp.moveOut"),
      lockAlpha: t("lp.lockAlpha"), clip: t("lp.clip"), clipGroup: t("lp.clipGroup"), refLayer: t("lp.refLayer"),
      mergeDown: t("lp.mergeDown"), clearContent: t("lp.clearContent"), delGroup: t("lp.delGroup"), del: t("lp.del"),
      opa: t("lp.opa"), mode: t("lp.mode"),
      on: t("common.on"), off: t("common.off"),
    };
    return {
      modeBadge, opacityPct, badgeTitle, layersUi, railPad, modeOptions, L,
      EYE_OPEN, EYE_OFF, FOLDER_OPEN, FOLDER_CLOSED, LAYER_MODE_LABEL,
      onRowClick, onNameClick, onRenameCommit, onRenameKey,
      toggleBadge, toggleMenu, vis, toggleCollapse,
      opaInput, opaCommit, modeChange, act, onMoveSelect,
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
      <!-- 眼睛**始终第一**（组/叶都是）→ 眼睛列对齐，组不再有误导性缩进。 -->
      <button type="button" class="layer-vis" :class="{ 'hidden-icon': !layer.visible }"
        :title="layer.visible ? L.visible : L.hidden"
        @click="vis"
        v-html="layer.visible ? EYE_OPEN : EYE_OFF"></button>

      <!-- 组：文件夹图标点击折叠（去三角），排在眼睛之后。叶不显。不缩进，组内层靠 .layer-nested 左竖条标归属。 -->
      <button v-if="isGroup" type="button" class="layer-folder" :title="collapsed ? L.expandGroup : L.collapseGroup"
        @click="toggleCollapse" v-html="collapsed ? FOLDER_CLOSED : FOLDER_OPEN"></button>

      <input v-if="renaming" type="text" class="layer-name-input" :value="layer.name"
        @click.stop @blur="onRenameCommit" @keydown="onRenameKey" />
      <span v-else class="layer-name" @click="onNameClick">{{ layer.name }}<span v-if="isGroup && collapsed" class="layer-group-count"> ({{ childLeafCount }})</span></span>

      <span v-if="layer.clippingMask" class="layer-clip-chip" :title="L.clippedTip"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#clipping-mask"/></svg></span>
      <span v-if="!isGroup && layer.lockAlpha" class="layer-lock-chip" :title="L.lockAlphaTip">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><use href="#lock"/></svg>
      </span>
      <span v-if="isRef" class="layer-ref-chip" :title="L.refTip">{{ L.refChip }}</span>

      <button type="button" class="layer-tools-btn" :title="L.layerMenu" @click="toggleMenu"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#more"/></svg></button>

      <button type="button" class="layer-mode-badge" :class="{ active: expanded }"
        :title="badgeTitle" @click="toggleBadge">{{ modeBadge }}</button>

      <div v-if="menuOpen" class="menu-panel layer-tools-popup" @click.stop>
        <button class="menu-item menu-item-with-icon" type="button" @click="act('rename')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#rename"/></svg><span class="menu-item-label">{{ L.rename }}</span></button>

        <!-- 叶专属：复制 -->
        <button v-if="!isGroup" class="menu-item menu-item-with-icon" type="button" :disabled="!canDuplicate" @click="act('duplicate')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#copy"/></svg><span class="menu-item-label">{{ L.duplicate }}</span></button>

        <!-- 图层组 reparent：解组（仅组）/ 移入某组（dropdown，不挤占菜单空间）/ 移出组。编组 = 「+」里新建空组 -->
        <hr class="menu-sep" v-if="isGroup || moveTargets.length || canMoveOut" />
        <button v-if="isGroup" class="menu-item menu-item-with-icon" type="button" @click="act('ungroup')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#explode-folder"/></svg><span class="menu-item-label">{{ L.ungroup }}</span></button>
        <label v-if="moveTargets.length" class="menu-item layer-move-into menu-item-with-icon" @click.stop><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#move-to-folder"/></svg><span class="menu-item-label">{{ L.moveIntoGroup }}</span>
          <select class="layer-move-select" @change="onMoveSelect" @click.stop>
            <option value="" selected>{{ L.choose }}</option>
            <option v-for="g in moveTargets" :key="'mi'+g.id" :value="String(g.id)">{{ g.name }}</option>
          </select>
        </label>
        <button v-if="canMoveOut" class="menu-item menu-item-with-icon" type="button" @click="act('moveOut')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#move-out-folder"/></svg><span class="menu-item-label">{{ L.moveOut }}</span></button>

        <hr class="menu-sep" />
        <!-- v267 (user)：层属性 toggle 收进 ⋯ 菜单（点了不关菜单，可连续切） -->
        <button v-if="!isGroup" class="menu-item layer-menu-toggle" type="button" role="menuitemcheckbox" :aria-pressed="layer.lockAlpha ? 'true' : 'false'" @click="toggleLock"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#lock-alpha"/></svg><span class="menu-item-label">{{ L.lockAlpha }}</span><span class="menu-item-state">{{ layer.lockAlpha ? L.on : L.off }}</span></button>
        <button class="menu-item layer-menu-toggle" type="button" role="menuitemcheckbox" :aria-pressed="layer.clippingMask ? 'true' : 'false'" @click="toggleClip"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#clipping-mask"/></svg><span class="menu-item-label">{{ isGroup ? L.clipGroup : L.clip }}</span><span class="menu-item-state">{{ layer.clippingMask ? L.on : L.off }}</span></button>
        <button v-if="!isGroup" class="menu-item layer-menu-toggle" type="button" role="menuitemcheckbox" :aria-pressed="isRef ? 'true' : 'false'" @click="toggleRef"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#reference-layer"/></svg><span class="menu-item-label">{{ L.refLayer }}</span><span class="menu-item-state">{{ isRef ? L.on : L.off }}</span></button>

        <hr class="menu-sep" />
        <button v-if="!isGroup" class="menu-item menu-item-with-icon" type="button" :disabled="!canMergeDown" @click="act('mergeDown')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#merge-down"/></svg><span class="menu-item-label">{{ L.mergeDown }}</span></button>
        <button v-if="!isGroup" class="menu-item menu-item-with-icon" type="button" :disabled="!hasPx" @click="act('clear')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#clear-document"/></svg><span class="menu-item-label">{{ L.clearContent }}</span></button>
        <button class="menu-item menu-danger menu-item-with-icon" type="button" :disabled="!canDel" @click="act('del')"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#trash-can"/></svg><span class="menu-item-label">{{ isGroup ? L.delGroup : L.del }}</span></button>
      </div>
    </div>

    <div v-if="expanded" class="layer-row-expand" :style="{ marginLeft: railPad + 'px' }" @click.stop>
      <label class="layer-slider-row">
        <span>{{ L.opa }}</span>
        <input type="range" min="0" max="100" :value="opacityPct"
          @input="opaInput" @change="opaCommit" @pointerup="opaCommit" @pointercancel="opaCommit" @click.stop />
        <span class="layer-slider-val">{{ opacityPct }}</span>
      </label>
      <label class="layer-slider-row">
        <span>{{ L.mode }}</span>
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
      const out: LayerRowData[] = [];
      const activeId = doc.activeId;
      const totalLeaves = countLeaves(doc.layers);
      // 全部组（id+name+node ref）：给「移入组」列表用。算一次，每行再按「非自身/非后代/非当前父」过滤。
      const allGroups: LayerNode[] = [];
      const collect = (nodes: LayerNode[]) => { for (const n of nodes) if (n.isGroup) { allGroups.push(n); collect(n.children!); } };
      collect(doc.layers);
      const walk = (nodes: LayerNode[], depth: number, parentNode: LayerNode | null) => {
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
            // 叶：留底（≥1 叶）才可删；组：永远可删（删空补空层）。
            canDel: n.isGroup || totalLeaves > 1,
            canMoveOut: depth > 0,                                       // 在组内 → 可移出
            moveTargets,                                                 // 可移入的已有组（high：把外面的层加入已知组）
            layer: { id: n.id, name: n.name, visible: n.visible, opacity: n.opacity, mode: n.mode, clippingMask: n.clippingMask, lockAlpha: (n as Layer).lockAlpha, isGroup: !!n.isGroup },
          };
          if (n.isGroup) {
            const collapsed = layersUi.collapsedIds.has(n.id);
            out.push({ ...base, collapsed, isRef: false, canDuplicate: false, canMergeDown: false, hasPx: false, childLeafCount: countLeaves(n.children) });
            if (!collapsed) walk(n.children!, depth + 1, n);
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

let _vueApp: { mount(el: Element): unknown } | null = null;

// 把图层列表的 max-height 钉到「列表顶 → 视口底」可用空间，列表内部 overflow 滚动。
//   修：层多 / 面板被拖到屏幕下半 时，最底 item 掉出视口够不着。CSS 的 50vh 是固定上限、不跟位置走。
function _clampListHeight() {
  const list = els.layersList;
  if (!list || els.layersPanel.classList.contains("hidden")) return;
  const top = list.getBoundingClientRect().top;
  const avail = window.innerHeight - top - 12;   // 留 12px 余量
  list.style.maxHeight = Math.max(96, avail) + "px";
}

// 面板外 chrome 同步（计数标签 / 加按钮禁用 / 删按钮禁用 / 滚到活动层）—— 这些 DOM 不在 mount
// 容器内，由 docVersion watch 驱动（取代旧 renderLayersPanel 末尾的命令式赋值）。
function _syncChrome() {
  const max = doc.maxLayers;
  const leaves = countLeaves(doc.layers);
  els.layersCountLabel.textContent = `${leaves} / ${max}`;
  els.layerAddBtn.disabled = leaves >= max;
  const delBtn = document.getElementById("layerDeleteBtn") as HTMLButtonElement;
  // 组永远可删（删空补空层）；叶要留底（≥1 叶）。
  // 只剩最后一张叶层时删不掉 —— 与其摆个灰按钮，不如就地变成「清空内容」（v430，user 提）。
  // 模式写进 dataset，click handler 照它分派；别在两处各判一次条件。
  const asClear = !doc.activeLayer?.isGroup && leaves <= 1;
  if (delBtn) {
    const lay = doc.activeLayer;
    const hasPx = !!lay && !lay.isGroup && lay.bboxW > 0 && lay.bboxH > 0;
    delBtn.dataset.mode = asClear ? "clear" : "del";
    delBtn.disabled = asClear ? !hasPx : false;   // 已经是空的就没什么可清
    delBtn.title = t(asClear ? "lp.clearContent" : "lp.foot.del");
    delBtn.setAttribute("aria-label", delBtn.title);
    delBtn.querySelector("use")?.setAttribute("href", asClear ? "#clear-document" : "#trash-can");
  }
  // v267 上移/下移按钮按活动节点的**同级**边界禁用（树化：top/bottom 按同级算）
  const upBtn = document.getElementById("layerMoveUpBtn") as HTMLButtonElement;
  const downBtn = document.getElementById("layerMoveDownBtn") as HTMLButtonElement;
  if (upBtn) upBtn.disabled = !doc.canMoveLayer(doc.activeId!, 1);
  if (downBtn) downBtn.disabled = !doc.canMoveLayer(doc.activeId!, -1);
  nextTick(() => {
    _clampListHeight();   // 列表高度跟位置/层数走，保证最底 item 可滚到
    els.layersList.querySelector(".layer-row.active")?.scrollIntoView({ block: "nearest" });
  });
}

let _layersDrag: { id: number; sx: number; sy: number; ol: number; ot: number } | null = null;

export function initLayersPanel(ctx: AppContext) {
  ({ doc, board, history, setStatus, pixelHistory, afterDocChange: _afterDocChange, layerSpecFrom } = ctx);

  // 挂 Vue 应用到图层列表容器（旧 renderLayersPanel 渲染进的 #layersList）。
  _vueApp = createApp(LayersPanel);
  _vueApp.mount(els.layersList);
  // chrome 副作用：docVersion 变即同步面板外 DOM（+ 初始同步一次）
  watch(() => docVersion.value, _syncChrome);
  _syncChrome();
  // 视口变（旋转 / 键盘弹出 / resize）也要重钉列表高度
  window.addEventListener("resize", _clampListHeight);

  // 点击别处收起打开的 ⋯ 菜单（取代旧 popup 的 outside-pointerdown）
  document.addEventListener("pointerdown", (e: Event) => {
    if (layersUi.menuId == null) return;
    const tgt = e.target as HTMLElement | null;
    if (!tgt?.closest(".layer-tools-popup") && !tgt?.closest(".layer-tools-btn")) {
      layersUi.menuId = null;
    }
  }, true);

  window.addEventListener("wp:toggleLayers", () => toggleLayersPanel());

  els.layersBtn.addEventListener("click", () => toggleLayersPanel());
  els.layersPanelClose.addEventListener("click", () => toggleLayersPanel(false));

  // 拖动 layers 面板（沿用 color panel 模式）
  els.layersPanelHead.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest(".float-panel-close")) return;
    const r = els.layersPanel.getBoundingClientRect();
    _layersDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.layersPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.layersPanelHead.addEventListener("pointermove", (e: PointerEvent) => {
    if (!_layersDrag || e.pointerId !== _layersDrag.id) return;
    const w = els.layersPanel.offsetWidth;
    const h = els.layersPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, _layersDrag.ol + (e.clientX - _layersDrag.sx)));
    const top  = Math.max(0, Math.min(window.innerHeight - h, _layersDrag.ot + (e.clientY - _layersDrag.sy)));
    els.layersPanel.style.left = left + "px";
    els.layersPanel.style.right = "auto";
    els.layersPanel.style.top = top + "px";
    _clampListHeight();   // 拖动改了面板顶 → 重钉列表高度，底部 item 始终够得着
    editorState.layersPanel.position = { left, top };   // 位置随文档走（setter 自动标记 dirty）
  });
  els.layersPanelHead.addEventListener("pointerup", (e: PointerEvent) => {
    if (_layersDrag && e.pointerId === _layersDrag.id) {
      try { els.layersPanelHead.releasePointerCapture(e.pointerId); } catch {}
      _layersDrag = null;
    }
  });
  // 面板开关 + 位置随文档走：doc 的 editorState 加载/重置后由 session-state 派发 wp:applyEditorState，据此应用到 DOM。
  window.addEventListener("wp:applyEditorState", () => applyLayersPanelFromEditorState());
  applyLayersPanelFromEditorState();   // 初次也按当前 editorState 摆好

  // v267 指令栏：+（弹菜单：新图层 / 导入图片）· 上移 · 下移 · 删除。命令全走深模块 caller，UI 只调。
  const addPopup = document.getElementById("layerAddPopup");
  const closeAddPopup = () => addPopup?.classList.add("hidden");
  els.layerAddBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    addPopup?.classList.toggle("hidden");
  });
  document.getElementById("layerAddNewBtn")?.addEventListener("click", () => { closeAddPopup(); _addEmptyLayer(); });
  document.getElementById("layerAddGroupBtn")?.addEventListener("click", () => { closeAddPopup(); _addEmptyGroup(); });
  // 导入图片到新层：实际逻辑由 import-image.ts 给 layerImportPhotoBtn 接线，这里只负责收起菜单。
  document.getElementById("layerImportPhotoBtn")?.addEventListener("click", closeAddPopup);
  // 点别处收起 "+" 菜单
  document.addEventListener("pointerdown", (e: Event) => {
    if (addPopup?.classList.contains("hidden")) return;
    const tgt = e.target as HTMLElement | null;
    if (!tgt?.closest("#layerAddPopup") && !tgt?.closest("#layerAddBtn")) closeAddPopup();
  }, true);

  document.getElementById("layerMoveUpBtn")?.addEventListener("click", () => {
    if (doc.activeLayer) _moveLayerDelta(doc.activeLayer, 1);
  });
  document.getElementById("layerMoveDownBtn")?.addEventListener("click", () => {
    if (doc.activeLayer) _moveLayerDelta(doc.activeLayer, -1);
  });
  document.getElementById("layerDeleteBtn")?.addEventListener("click", (e) => {
    if (!doc.activeLayer) return;
    // 模式由 _syncChrome 写在 dataset 上（最后一张叶层 → 清空内容，否则删除）。
    if ((e.currentTarget as HTMLElement).dataset.mode === "clear") _clearLayerPixels(doc.activeLayer);
    else _deleteLayer(doc.activeLayer);
  });
}
