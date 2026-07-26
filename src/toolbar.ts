// 职责（单一）：工具选择 + EditMode→UI 派生 + 套索/选区工具栏。
// 即「选当前工具、把按钮高亮/可点从 EditMode 派生、lasso 子工具/集合运算/变换/选区动作工具栏」。
// drawing app 只经 editMode（持久工具 + transient）这一个轴跟工具耦合：
//   setTool → editMode.setTool → emit wp:modechange → _syncEditModeUI 重新派生整套 UI。
// ctx 绑：editMode/state/doc/board/input/history/workpiece/ops/dialReactive/rack/setStatus/leftDial,
//        + app-local（仍在 app.js，经 ctx 绑）：_suppressTransientPanels/_restoreTransientPanels/
//          _commitTransform/_cancelTransform/selectionToNewLayer/afterDocChange。
// importable：Selection（选区取反/全选）、fillResampleSelect（变换采样 dropdown SSoT）。
// undo：selection-entry 走 ops.selection（事务型 swap）、fill/clear 走 ops.pixels（事务型 swap）。

import { els } from "./els.ts";
import { PANELS, openExclusive, closeExclusive } from "./panel-state.ts";
import { Selection } from "./selection.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { editorState } from "./workbench-state.ts";   // pickMode → editorState.colorPicker.layerMode SSoT（binding 写反应式）
import { fillResampleSelect } from "./resample.ts";
import { t } from "./i18n/index.ts";
import { fillPreviewActive, commitFillNow } from "./fill-mode.ts";
import { anchorPopupToBtn } from "./anchored-popup.ts";
import { configFromModeState, planesForMode, defaultVpsForMode } from "./perspective-frame.ts";
import type { PerspMode } from "./perspective-frame.ts";
import type { AppContext } from "./app-context.ts";
import type { LayerSnap } from "./doc.ts";

// 静态存在的工具栏元素查表 helper（initToolbar 在 DOM 就绪后调）。
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// requireEditableLeaf / transform 收到的 doc 活层（只描述本文件用到的）。
interface LayerLike { id: number; snapshot(): LayerSnap; }
// 选区编辑 modal 态（仅 modal 开着时非 null）。Selection 取自 selection.js 的 class（值导入兼作类型）。
interface SelEditState { before: Selection; op: "expand" | "shrink"; rafId: number; }
// editMode.enterTransient 的 apply/abort 回调（edit-mode.js 未类型化，默认 null 把推断窄成 null|undefined → 在调用处断言真签名）。
interface TransientOpts { apply?: () => void; abort?: () => void; }

let editMode: AppContext["editMode"], state: AppContext["state"], doc: AppContext["doc"], board: AppContext["board"];
let input: AppContext["input"], history: AppContext["history"], dialReactive: AppContext["dialReactive"];
let workpiece: AppContext["workpiece"], ops: AppContext["ops"];
let rack: AppContext["rack"], setStatus: AppContext["setStatus"], leftDial: AppContext["leftDial"];
let _suppressTransientPanels: AppContext["_suppressTransientPanels"];
let _commitTransform: AppContext["_commitTransform"], _cancelTransform: AppContext["_cancelTransform"];
let selectionToNewLayer: AppContext["selectionToNewLayer"];

// selection-entry → SwapSelectionOp（事务型：setSelection 已把 after 应用到 doc，run 只交 before）。
const pushSel = (entry: { before: Selection | null } | null | undefined) => {
  if (entry) history.run(workpiece, ops.selection, { _initialBefore: { v: entry.before ?? null } });
};

// 套索工具栏 DOM（initToolbar 里查表）。静态元素 → 非空；btn 组 → 数组；下拉 → select。
let lassoToolbarStack: HTMLElement, lassoToolbarRow1: HTMLElement, lassoToolbarRow2: HTMLElement;
let lassoSubToolBar: HTMLElement, lassoTransformCtrl: HTMLElement;
let lassoTransformModeBtns: HTMLElement[];
let lassoThresholdInput: HTMLInputElement, lassoThresholdVal: HTMLElement;
let lassoConstrainBtn: HTMLElement;
let lassoSelEditBtn: HTMLElement, lassoSelEditMenu: HTMLElement;   // v0.5.12 ⋯ 菜单（低频选区操作收纳）
let lassoSetOpSlot: HTMLElement, lassoSetOpSlotUse: SVGUseElement, lassoSetOpMenu: HTMLElement, lassoSetOpMenuBtns: HTMLElement[];   // 布尔组槽（v0.5.17 回下拉）
let lassoSubSlot: HTMLElement, lassoSubSlotUse: SVGUseElement, lassoSubMenu: HTMLElement, lassoSubMenuBtns: HTMLElement[];   // 子工具组槽（v0.5.14）
let lassoMagicCtx: HTMLElement, lassoExpandToggle: HTMLElement, lassoMagicExpandPx: HTMLInputElement;   // 魔棒配置内联
let lassoTransformBtn: HTMLElement, lassoFillModeBtn: HTMLElement, lassoFillCommitBtn: HTMLElement, lassoDeselectBtn: HTMLElement;
let pickerToolbar: HTMLElement | null, pickModeSel: HTMLSelectElement | null;   // 吸色 context toolbar（取样模式：合并 / 当前图层）

// 「跟 session 走」的 RAM 记忆（user 拍板：不进 editorState/文件）。
//   v0.5.16 改判：填色/选区**共用一份**模式记忆（进油漆桶保持刚才的子工具，UX 更直觉）；
//   fill 禁「新建」只在灌引擎时就地 coerce 成并，不改记忆本体。
const _selMem = { sub: "freehand" as string, setOp: "new" as string };
const SETOP_ICON: Record<string, string> = { new: "#selection-new", union: "#selection-union", subtract: "#selection-difference", intersect: "#selection-union" };
const SUBTOOL_ICON: Record<string, string> = { freehand: "#select-freehand", rect: "#select-rectangle", ellipse: "#select-ellipse", magic: "#magic-wand" };
// 形状笔（ADR-0005/0006）：组槽 + 约束钮（图标按子工具换义）+ grid 配置 + 透视平面槽
let shapeToolbarStack: HTMLElement, shapeSubSlot: HTMLElement, shapeSubSlotUse: SVGUseElement,
    shapeSubMenu: HTMLElement, shapeSubMenuBtns: HTMLElement[], shapeConstrainBtn: HTMLElement, shapeConstrainUse: SVGUseElement,
    shapeGridCtx: HTMLElement, shapeGridNuVal: HTMLElement, shapeGridNvVal: HTMLElement, shapeGridBorderBtn: HTMLElement,
    shapePerspModeSlotUse: SVGUseElement, shapePerspModeMenuBtns: HTMLElement[],
    shapePlaneCtl: HTMLElement, shapePlaneBtns: HTMLElement[],
    shapePerspExtraCtl: HTMLElement, shapePerspShowBtn: HTMLElement, shapePerspShowUse: SVGUseElement;
const PERSP_MODE_ICON: Record<string, string> = { off: "#persp-viewport", p1: "#persp-1p", p2: "#persp-2p", p3: "#persp-3p" };
const SHAPE_SUB_ICON: Record<string, string> = { line: "#line", rect: "#rectangle", circle: "#circle", grid: "#grid" };
const SHAPE_CONSTRAIN_ICON: Record<string, string> = { line: "#snap-angle", rect: "#constrain-square", circle: "#constrain-circle" };

// 形状笔上下文工具栏派生（对齐 updateLassoToolbar 的「统一同步点」纪律）
export function updateShapeToolbar() {
  if (!shapeToolbarStack) return;
  const active = editMode.current() === "shapeBrush";
  shapeToolbarStack.classList.toggle("hidden", !active);
  if (!active) { shapeSubMenu?.classList.add("hidden"); return; }
  const sub = input.shapeBrush.getSubTool();
  const gPersp = editorState.persp;
  const perspMode = (["p1", "p2", "p3"].includes(gPersp.mode) ? gPersp.mode : "off") as PerspMode;
  shapeSubSlotUse.setAttribute("href", SHAPE_SUB_ICON[sub] || "#line");
  for (const b of shapeSubMenuBtns) {
    b.setAttribute("aria-pressed", b.dataset.shapeSub === sub ? "true" : "false");
  }
  // 约束钮：grid 无约束语义 → 隐藏；line 在透视下语义换成「吸向消失点」→ 换图标（user）
  shapeConstrainBtn.classList.toggle("hidden", sub === "grid");
  const constrainIcon = sub === "line" && perspMode !== "off" ? "#snap-vp" : (SHAPE_CONSTRAIN_ICON[sub] || "#snap-angle");
  shapeConstrainUse.setAttribute("href", constrainIcon);
  shapeConstrainBtn.setAttribute("aria-pressed", input.shapeBrush.getConstrain() ? "true" : "false");
  // grid 配置区（sub=grid 时显）
  shapeGridCtx.classList.toggle("hidden", sub !== "grid");
  if (sub === "grid") {
    shapeGridNuVal.textContent = String(editorState.shapeBrush.gridNu);
    shapeGridNvVal.textContent = String(editorState.shapeBrush.gridNv);
    shapeGridBorderBtn.setAttribute("aria-pressed", editorState.shapeBrush.gridBorder ? "true" : "false");
  }
  // 透视模式组槽（UI v2.1）：槽显当前模式；透视开着 → 平面槽（line 智能吸附不吃平面 → 藏）+
  //   VP 编辑钮 + 绘图 gizmo 显隐钮出现
  const g = gPersp;
  const mode = perspMode;
  shapePerspModeSlotUse.setAttribute("href", PERSP_MODE_ICON[mode]);
  for (const b of shapePerspModeMenuBtns) {
    b.setAttribute("aria-pressed", b.dataset.perspMode === mode ? "true" : "false");
  }
  shapePlaneCtl.classList.toggle("hidden", mode === "off" || sub === "line");
  shapePerspExtraCtl.classList.toggle("hidden", mode === "off");
  if (mode !== "off") {
    const planes = planesForMode(mode) as string[];
    const plane = planes.includes(g.plane) ? g.plane : "ground";
    for (const b of shapePlaneBtns) {
      const p = b.dataset.shapePlane!;
      b.classList.toggle("hidden", !planes.includes(p));
      b.setAttribute("aria-pressed", plane === p ? "true" : "false");
    }
    shapePerspShowBtn.setAttribute("aria-pressed", g.showGizmo ? "true" : "false");
    shapePerspShowUse.setAttribute("href", g.showGizmo ? "#visibility-show" : "#visibility-hide");
  }
}
function closeSubMenu() { lassoSubMenu?.classList.add("hidden"); }
function closeSetOpMenu() { lassoSetOpMenu?.classList.add("hidden"); }

// ===== 套索/选区工具栏（v65 重做）=====
// 三个 section 按状态切换：subToolBar（lasso 激活）/ selectionActions（有选区且非 floating）/ transformCtrl（floating）
export function updateLassoToolbar() {
  // 吸色 context toolbar：吸色工具激活时显示。两 stack 同位 fixed → 必须互斥（picker 在场则 lasso stack 让位，
  //   即便有选区也不露 deselect-only；Ctrl+D 仍可去选）。本函数 = 上下文工具栏统一同步点。
  const pickerActive = editMode.current() === "picker";
  if (pickerToolbar) {
    pickerToolbar.classList.toggle("hidden", !pickerActive);
    if (pickerActive && pickModeSel && pickModeSel.value !== state.pickMode) pickModeSel.value = state.pickMode;
  }
  const floating = input.lasso.hasFloating();
  const hasSelection = !!doc.selection;
  const m = editMode.current();
  const lassoActive = m === "lasso";
  const fillActive = m === "fill";
  const selToolActive = lassoActive || fillActive;   // v0.5.12：选区/填充共用同一 Row1（UI 独立≠第二套代码）
  const sub = input.lasso.getSubTool();
  // 形状笔/VP 编辑与 lasso stack 同位 fixed → 互斥（同 picker 先例）；shape 中去选走 Ctrl+D
  const shapeActive = m === "shapeBrush" || m === "perspEdit";
  const showAny = (floating || hasSelection || selToolActive) && !pickerActive && !shapeActive;
  lassoToolbarStack.classList.toggle("hidden", !showAny);
  if (!showAny) { closeSelEditUI(); closeSubMenu(); closeSetOpMenu(); return; }

  // 其他工具模式下有选区：选区只是个蒙板，工具栏只给一个"取消选区"（否则去选还得切回 lasso）。
  const otherToolSel = hasSelection && !floating && !selToolActive;
  // Row 1（唯一常驻行，v0.5.12 单排化）：选区/填充给全套；其他工具+有选区只露 deselect。floating 时不给。
  const showRow1 = (selToolActive && !floating) || otherToolSel;
  lassoToolbarRow1.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("lasso-deselect-only", otherToolSel);

  // Row 2：只剩浮层变换控制（selectionActions 段 v0.5.12 退役）。
  lassoToolbarRow2.classList.toggle("hidden", !floating);
  lassoTransformCtrl.classList.toggle("hidden", !floating);

  // 组槽图标 = 当前子工具/布尔模式（v0.5.14：4 子工具钮收成单槽，含 flood；下拉里高亮当前项）
  lassoSubSlotUse.setAttribute("href", SUBTOOL_ICON[sub] || "#select-freehand");
  for (const b of lassoSubMenuBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSub === sub ? "true" : "false");
  }
  // 布尔组槽：槽图标 = 当前模式；菜单里高亮当前项、「新建」在 fill 隐藏（填充=累积工作流）。
  const setOp = input.lasso.getSetOpMode();
  lassoSetOpSlotUse.setAttribute("href", SETOP_ICON[setOp] || "#selection-new");
  for (const b of lassoSetOpMenuBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSetop === setOp ? "true" : "false");
    if (b.dataset.lassoSetop === "new") b.classList.toggle("hidden", fillActive);
  }
  // 魔棒配置内联：magic 子工具时显示；px 输入仅扩张开着时显。
  const magicOn = sub === "magic";
  lassoMagicCtx.classList.toggle("hidden", !magicOn);
  if (magicOn) {
    lassoExpandToggle.setAttribute("aria-pressed", editorState.magicWand.expand ? "true" : "false");
    lassoMagicExpandPx.classList.toggle("hidden", !editorState.magicWand.expand);
  }
  // ⋯ 菜单钮：选区/填充工具常显（menu 内按 needs-sel / lasso-only 逐项禁用·隐藏——见 openSelEditUI）。
  //   modal 开着时(_selEdit)恒亮（预览 shrink 到空不能把 modal 撕掉）。
  const showSelEdit = !!_selEdit || (showRow1 && !otherToolSel);
  lassoSelEditBtn.classList.toggle("hidden", !showSelEdit);
  if (!showSelEdit) closeSelEditUI();
  // ⋯ 菜单逐项：needs-sel 无选区禁用；lasso-only（清除/复制/移层）fill 里隐藏
  for (const el of lassoSelEditMenu.querySelectorAll<HTMLButtonElement>(".lasso-menu-needs-sel")) el.disabled = !hasSelection;
  for (const el of lassoSelEditMenu.querySelectorAll<HTMLElement>(".lasso-menu-lasso-only")) el.classList.toggle("hidden", fillActive);
  // 1:1 约束按钮：仅 rect / ellipse 子工具下显示
  const showConstrain = sub === "rect" || sub === "ellipse";
  lassoConstrainBtn.classList.toggle("hidden", !showConstrain);
  if (showConstrain) {
    lassoConstrainBtn.setAttribute("aria-pressed", input.lasso.getConstrainSquare() ? "true" : "false");
  }
  // 行尾动作组：变换=选区工具专属；油漆桶=套索的深模式 toggle（fill 中亮）；✓=填充工具+有选区；
  //   去选=有选区才显（v0.5.14 user）。
  lassoDeselectBtn.classList.toggle("hidden", !hasSelection);
  lassoTransformBtn.classList.toggle("hidden", !lassoActive);
  lassoFillModeBtn.setAttribute("aria-pressed", fillActive ? "true" : "false");
  lassoFillCommitBtn.classList.toggle("hidden", !(fillActive && fillPreviewActive()));
  if (floating) {
    const mode = input.lasso.getMode();
    for (const b of lassoTransformModeBtns) {
      b.setAttribute("aria-pressed", b.dataset.lassoMode === mode ? "true" : "false");
    }
    const sm = input.lasso.getSampleMode();
    const sel = document.getElementById("lassoSampleSel") as HTMLSelectElement | null;
    if (sel && sel.value !== sm) sel.value = sm;
  }
}

// ---- 工具 ----
export function setTool(tool: string) {
  // v96：airbrush 工具不存在了。老 doc 持久化里可能存了 "airbrush" → 透明回退到 brush
  if (tool === "airbrush") tool = "brush";
  // v120：shapes 撤了。老 doc 持久化里可能存了 "shapes" → 透明回退 brush
  if (tool === "shapes") tool = "brush";
  // v309：smudge 工具（一直只是 disabled 占位、从未实装）整体 purge，待将来重写。
  //   老 doc 持久化里可能存了 "smudge" → 透明回退 brush（同 airbrush/shapes）
  if (tool === "smudge") tool = "brush";
  // v0.5.11 曾把 "bucket" 回退 brush；v0.5.12 油漆桶以 "fill" 第一类工具回归。老 doc 的 "bucket" → fill。
  if (tool === "bucket") tool = "fill";
  // 切工具 = 决定性动作 → editMode.setTool 内部按 onToolSwitch 把停驻 transient apply/cancel（不在这单独调）
  // v132: 切到非 filterBrush 工具时自动退出 filter brush 模式（藏 toolbar / 清 state）
  if (state.filterBrush && tool !== "filterBrush") {
    state.filterBrush = null;
    const tb = document.getElementById("filterBrushToolbar");
    if (tb) tb.classList.add("hidden");
  }
  editMode.setTool(tool);   // emit wp:modechange → _syncEditModeUI 派生按钮高亮 / lasso 工具栏
  document.body.dataset.tool = tool;   // 持久工具的 CSS hook（transient 期间保持不变）
  // 切工具 → 应用该工具的 per-tool state（size/flow/activeBrushId）+ preset 冻结字段
  //   shapeBrush alias 到 brush（getRackToolKey）：共享笔架 + 共享当前笔/dial（user：「笔和绘制用的笔刷共享笔架」）
  if (tool === "brush" || tool === "eraser" || tool === "filterBrush" || tool === "shapeBrush") {
    rack.applyToolState(tool);
  }
  // 「跟 session 走」共享记忆（v0.5.16：填色/选区一份）——进工具恢复子工具+布尔；fill 禁新建→就地并。
  if (tool === "lasso" || tool === "fill") {
    input.lasso.setSubTool(_selMem.sub as Parameters<typeof input.lasso.setSubTool>[0]);
    const op = (tool === "fill" && _selMem.setOp === "new") ? "union" : _selMem.setOp;
    input.lasso.setSetOpMode(op as Parameters<typeof input.lasso.setSetOpMode>[0]);
    updateLassoToolbar();
  }
}

// #6 stage 4：UI 从 EditMode 派生（监听 wp:modechange）。setTool / enterTransient / exit 都会触发。
// transient 期间（current()=transform/crop/adjust）**不高亮任何工具按钮** —— 这正是当初想实现、
// 逼出"双轴不行"的那个 payoff（双轴的 tool() 仍指向底层工具会误亮）。
export function _syncEditModeUI() {
  const m = editMode.current();
  dialReactive.tool = m;   // 反应式 dial 镜像当前工具（含 transient）→ currentBrush computed 重算
  const transient = editMode.isTransient();
  // 工具按钮高亮：transient 时一个都不亮；持久工具高亮对应按钮
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", (!transient && (b.dataset.tool === m || (b.dataset.tool === "lasso" && m === "fill"))) ? "true" : "false");   // fill=套索的深模式 → 套索钮保持亮
  // 液化 / filterBrush 没独立 data-tool 按钮，用 adjust 按钮高亮（transient 期间也不亮）
  els.topAdjustBtn?.setAttribute("aria-pressed", (m === "filterBrush") ? "true" : "false");
  // 注：body.dataset.tool 保持"持久工具"（在 setTool 里设），不在这改成 transient 名——避免扰乱
  // 依赖 body[data-tool] 的 CSS（且 data-mode 被图库占用）。transient 的 UI 抑制走面板 suppress + 按钮高亮。
  // slider 禁用：size/opacity 仅 canDraw 模式可调 → 反应式镜像，<LeftDial> 绑 :disabled。color 仅 allowsColor 可点。
  dialReactive.canDraw = editMode.canDraw();
  if (els.activeSwatch) (els.activeSwatch as HTMLButtonElement).disabled = !editMode.allowsColor();
  updateLassoToolbar();             // 选区/变换工具栏跟着重新派生
  updateShapeToolbar();             // 形状笔工具栏跟着重新派生（与 lasso stack 互斥）
}

// ===== v242 选区编辑 op：扩张 / 收缩（走 adjust transient + 实时预览）=====
// 齿轮 → 菜单(扩张/收缩) → modal：数字输入，蚂蚁线随输入实时变；应用/取消。
//   预览 = 直接改 doc.selection（不 push history）；应用 = push 一条 selectionChange(before→after)；
//   取消 / ctrl-z / 切工具 = 还原 before。硬边（Selection.morphed），不羽化——羽化是以后的事。
// 设计照搬 filters-adjust 的 transient 生命周期（enterTransient("adjust") + 统一 exit 同步点）。
let _selEdit: SelEditState | null = null;   // { before, op:'expand'|'shrink', rafId } —— 仅 modal 开着时非 null

function _selEditEls() {
  return {
    menu: document.getElementById("lassoSelEditMenu"),
    popup: document.getElementById("lassoSelOpPopup"),
    title: document.getElementById("lassoSelOpTitle"),
    amount: document.getElementById("lassoSelOpAmount") as HTMLInputElement | null,
  };
}
// 读数字输入：非负整数，0..100（形态学 O(area×r)，且白边修正用不到更大）
function _selEditAmount(): number {
  const { amount } = _selEditEls();
  let v = parseInt((amount?.value || "0").replace(/[^0-9]/g, ""), 10);
  if (!isFinite(v) || v < 0) v = 0;
  if (v > 100) v = 100;
  return v;
}
function _runSelEditPreview() {
  const s = _selEdit;
  if (!s) return;
  const amt = _selEditAmount();
  const signed = s.op === "expand" ? amt : -amt;
  const prev = doc.selection as Selection | null;
  const next = s.before.morphed(signed, doc.width, doc.height);
  doc.selection = next as (typeof doc)["selection"];
  // v0.4.6：上一个预览产物无人接手 → 就地 dispose（before 本体和新预览除外）。morphed(0) 返回 before 本体。
  if (prev && prev !== s.before && prev !== next && !prev.disposed) prev.dispose();
  input.lasso.onChange?.();   // requestRender（重画蚂蚁线）+ wp:lassochange（派生工具栏，已对 _selEdit 免疫）
}
function _onSelEditInput() {
  if (!_selEdit) return;
  if (_selEdit.rafId) return;     // rAF coalesce：连打数字不堵队列（同 _onFilterChange）
  _selEdit.rafId = requestAnimationFrame(() => {
    if (!_selEdit) return;
    _selEdit.rafId = 0;
    _runSelEditPreview();
  });
}
function _syncSelEditOpUI(op: "expand" | "shrink") {
  document.getElementById("lassoSelOpExpandBtn")?.setAttribute("aria-pressed", op === "expand" ? "true" : "false");
  document.getElementById("lassoSelOpShrinkBtn")?.setAttribute("aria-pressed", op === "shrink" ? "true" : "false");
  const title = document.getElementById("lassoSelOpTitle");
  if (title) title.textContent = op === "expand" ? t("se.expandSelection") : t("se.shrinkSelection");
}
function _setSelEditOp(op: "expand" | "shrink") {
  if (!_selEdit || _selEdit.op === op) return;
  _selEdit.op = op;
  _syncSelEditOpUI(op);
  _runSelEditPreview();
}
function _openSelEdit(op: "expand" | "shrink") {
  if (!doc.selection) return;
  const { menu, popup, title, amount } = _selEditEls();
  menu?.classList.add("hidden");
  if (_selEdit) _finishSelEdit(false);    // 已开着另一个 → 先取消旧的（还原）再开新的
  _selEdit = { before: doc.selection as Selection, op, rafId: 0 };
  void title;   // 标题/方向 pressed 统一走 _syncSelEditOpUI
  _syncSelEditOpUI(op);
  if (amount) amount.value = "1";         // 默认 1px（最常用的轻微扩缩）
  popup?.classList.remove("hidden");
  _runSelEditPreview();                    // 初次预览
  // adjust transient：apply=采纳预览，abort=还原。切工具/ctrl-z 都经此（onToolSwitch=apply）。
  (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("adjust", { apply: () => _finishSelEdit(true), abort: () => _finishSelEdit(false) });
  // v267b (user)：不自动 focus/select 输入框——大多数时候无脑 1px 直接「应用」即可，
  //   自动选中会在 iPad 弹出键盘挡视野。要改数值用户自己点输入框。
}
// 收尾同步点（所有关闭路径都过这里）：清 raf、出终值、藏 popup、退 transient、刷 UI。
function _finishSelEdit(applied: boolean) {
  const s = _selEdit;
  if (!s) return;
  if (s.rafId) { cancelAnimationFrame(s.rafId); s.rafId = 0; }
  const { popup } = _selEditEls();
  _selEdit = null;                          // 先清，防 exitTransient → updateLassoToolbar 重入
  if (applied) {
    const before = s.before, after = doc.selection;
    if (after !== before) pushSel({ before });   // before 所有权交给 ops.selection；after 留在 doc
    setStatus(s.op === "expand" ? t("se.selectionExpanded") : t("se.selectionShrunk"));
  } else {
    const preview = doc.selection as Selection | null;
    doc.selection = s.before as (typeof doc)["selection"];               // 还原
    if (preview && preview !== s.before && !preview.disposed) preview.dispose();   // v0.4.6：弃预览产物
  }
  popup?.classList.add("hidden");
  input.lasso.onChange?.();
  updateLassoToolbar();
  editMode.exitTransient();                 // 同步点：清 EditMode transient（同 _closeFilterPanel 尾）
}
// 收起齿轮菜单（updateLassoToolbar 在选区没了/切走时调；此时 _selEdit 必为 null，不碰 modal）
function closeSelEditUI() {
  _selEditEls().menu?.classList.add("hidden");
}
function initSelEditUI() {
  const { menu, amount } = _selEditEls();
  lassoSelEditBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (_selEdit) return;                   // modal 开着时不响应
    const wasHidden = menu?.classList.contains("hidden");
    menu?.classList.toggle("hidden");
    if (wasHidden && menu) anchorPopupToBtn(menu, lassoSelEditBtn, { align: "left", offsetY: 6 });   // v0.5.14 贴钮
  });
  document.getElementById("lassoSelResizeBtn")?.addEventListener("click", () => _openSelEdit("expand"));   // v0.5.15 合一钮，默认扩张
  // modal 内方向切换（v0.5.15 user：扩张/收缩同一入口）：切方向 = 换 op 就地重预览（预览恒从 before 派生）。
  document.getElementById("lassoSelOpExpandBtn")?.addEventListener("click", () => _setSelEditOp("expand"));
  document.getElementById("lassoSelOpShrinkBtn")?.addEventListener("click", () => _setSelEditOp("shrink"));
  amount?.addEventListener("input", _onSelEditInput);
  amount?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); _finishSelEdit(true); }
  });
  document.getElementById("lassoSelOpApply")?.addEventListener("click", () => _finishSelEdit(true));
  document.getElementById("lassoSelOpCancel")?.addEventListener("click", () => _finishSelEdit(false));
  // 点菜单外侧 → 关菜单（modal 自有 apply/cancel，不在此关）
  document.addEventListener("pointerdown", (e: Event) => {
    if (!menu || menu.classList.contains("hidden")) return;
    if (menu.contains(e.target as Node) || lassoSelEditBtn.contains(e.target as Node)) return;
    menu.classList.add("hidden");
  });
}

// Rack 工具 → 对应的 exclusive panel id
export const RACK_PANEL_BY_TOOL: Record<string, string> = {
  brush: PANELS.RACK_BRUSH,
  eraser: PANELS.RACK_ERASER,
  filterBrush: PANELS.RACK_FILTER_BRUSH,    // v132
  shapeBrush: PANELS.RACK_BRUSH,            // ADR-0005：共享 brush 笔架
};
let _lastNonLassoTool = "brush";

export function initToolbar(ctx: AppContext) {
  ({
    editMode, state, doc, board, input, history, workpiece, ops, dialReactive, rack, setStatus, leftDial,
    _suppressTransientPanels, _commitTransform, _cancelTransform,
    selectionToNewLayer,
  } = ctx);

  // ---- 套索/选区工具栏 DOM ----
  // 两行 toolbar stack（v93）：row1 = 选区方式，row2 = 操作 / 变换
  lassoToolbarStack = byId("lassoToolbarStack");
  lassoToolbarRow1 = byId("lassoToolbarRow1");
  lassoToolbarRow2 = byId("lassoToolbarRow2");
  lassoSubToolBar = byId("lassoSubToolBar");
  lassoTransformCtrl = byId("lassoTransformCtrl");
  lassoTransformModeBtns = [...lassoTransformCtrl.querySelectorAll<HTMLElement>("[data-lasso-mode]")];
  lassoThresholdInput = byId<HTMLInputElement>("lassoThreshold");
  lassoThresholdVal = byId("lassoThresholdVal");
  lassoConstrainBtn = byId("lassoConstrainBtn");
  lassoSelEditBtn = byId("lassoSelEditBtn");
  lassoSelEditMenu = byId("lassoSelEditMenu");
  lassoTransformBtn = byId("lassoTransformBtn");
  lassoDeselectBtn = byId("lassoDeselectBtn");
  lassoFillCommitBtn = byId("lassoFillCommitBtn");
  lassoFillCommitBtn.addEventListener("click", () => { commitFillNow(); updateLassoToolbar(); });
  // 油漆桶 = 套索的深模式 toggle（row1 变换旁，user v0.5.14）：进=fill 工具（恢复 fill 的记忆子工具），
  //   出=回套索（切出=commit 由 fill-mode 的 modechange 钩子管，这里零填色知识）。
  lassoFillModeBtn = byId("lassoFillModeBtn");
  lassoFillModeBtn.addEventListener("click", () => {
    setTool(editMode.current() === "fill" ? "lasso" : "fill");
  });
  window.addEventListener("wp:applyEditorState", updateLassoToolbar);   // 换文档：阈值/扩张态回灌后重派生

  // v0.5.14 组槽通用：点槽 → 锚定槽下方弹紧凑图标排（user：下拉要贴槽、图标不要文字）。
  const wireSlotMenu = (slot: HTMLElement, menu: HTMLElement, onPick: (b: HTMLElement) => void) => {
    slot.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      const wasHidden = menu.classList.contains("hidden");
      menu.classList.toggle("hidden");
      if (wasHidden) anchorPopupToBtn(menu, slot, { align: "left", offsetY: 6 });
    });
    for (const b of [...menu.querySelectorAll<HTMLElement>("button")]) {
      b.addEventListener("click", () => { onPick(b); menu.classList.add("hidden"); updateLassoToolbar(); });
    }
    document.addEventListener("pointerdown", (e: Event) => {
      if (menu.classList.contains("hidden")) return;
      if (menu.contains(e.target as Node) || slot.contains(e.target as Node)) return;
      menu.classList.add("hidden");
    });
  };
  // 子工具组槽（freehand/rect/ellipse/flood 收一组；套索/油漆桶各记各的默认——user 拍板两份记忆）
  lassoSubSlot = byId("lassoSubSlot");
  lassoSubSlotUse = byId("lassoSubSlotUse") as unknown as SVGUseElement;
  lassoSubMenu = byId("lassoSubMenu");
  lassoSubMenuBtns = [...lassoSubMenu.querySelectorAll<HTMLElement>("[data-lasso-sub]")];
  wireSlotMenu(lassoSubSlot, lassoSubMenu, (b) => {
    const subName = b.dataset.lassoSub as Parameters<typeof input.lasso.setSubTool>[0];
    input.lasso.setSubTool(subName);
    _selMem.sub = subName;   // v0.5.16 共享记忆
  });
  // 布尔组槽（v0.5.17 user：改回下拉，横排纯图标）
  lassoSetOpSlot = byId("lassoSetOpSlot");
  lassoSetOpSlotUse = byId("lassoSetOpSlotUse") as unknown as SVGUseElement;
  lassoSetOpMenu = byId("lassoSetOpMenu");
  lassoSetOpMenuBtns = [...lassoSetOpMenu.querySelectorAll<HTMLElement>("[data-lasso-setop]")];
  wireSlotMenu(lassoSetOpSlot, lassoSetOpMenu, (b) => {
    const op = b.dataset.lassoSetop as Parameters<typeof input.lasso.setSetOpMode>[0];
    input.lasso.setSetOpMode(op);
    _selMem.setOp = op;   // 共享记忆（fill 里「新建」项已隐）
  });
  // ---- 形状笔上下文工具栏（ADR-0005）：组槽 + 约束。状态 per-doc（editorState.shapeBrush），UI 改 → 写
  //   editorState + 灌引擎；换文档 wp:applyEditorState 回灌（对齐魔棒阈值样板）。
  //   画一半切子工具/约束 = cancel 不进 undo（user 拍板，同两指手势接管语义）。
  shapeToolbarStack = byId("shapeToolbarStack");
  shapeSubSlot = byId("shapeSubSlot");
  shapeSubSlotUse = byId("shapeSubSlotUse") as unknown as SVGUseElement;
  shapeSubMenu = byId("shapeSubMenu");
  shapeSubMenuBtns = [...shapeSubMenu.querySelectorAll<HTMLElement>("[data-shape-sub]")];
  shapeConstrainBtn = byId("shapeConstrainBtn");
  shapeConstrainUse = byId("shapeConstrainUse") as unknown as SVGUseElement;
  wireSlotMenu(shapeSubSlot, shapeSubMenu, (b) => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    const sub = b.dataset.shapeSub as Parameters<typeof input.shapeBrush.setSubTool>[0];
    input.shapeBrush.setSubTool(sub);
    editorState.shapeBrush.sub = sub;
    updateShapeToolbar();
  });
  shapeConstrainBtn.addEventListener("click", () => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    const v = !input.shapeBrush.getConstrain();
    input.shapeBrush.setConstrain(v);
    editorState.shapeBrush.constrain = v;
    updateShapeToolbar();
  });
  // grid 配置（ADR-0006）：steppers（零键盘）+ 外框 toggle；per-doc（editorState），改 → 写 + 灌引擎
  shapeGridCtx = byId("shapeGridCtx");
  shapeGridNuVal = byId("shapeGridNuVal");
  shapeGridNvVal = byId("shapeGridNvVal");
  shapeGridBorderBtn = byId("shapeGridBorderBtn");
  const pushGridToEngine = () => {
    input.shapeBrush.setGridConfig({
      nu: editorState.shapeBrush.gridNu, nv: editorState.shapeBrush.gridNv,
      border: editorState.shapeBrush.gridBorder,
    });
  };
  const stepGrid = (axis: "gridNu" | "gridNv", d: number) => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    editorState.shapeBrush[axis] = Math.max(1, Math.min(24, editorState.shapeBrush[axis] + d));
    pushGridToEngine();
    updateShapeToolbar();
  };
  byId("shapeGridNuMinus").addEventListener("click", () => stepGrid("gridNu", -1));
  byId("shapeGridNuPlus").addEventListener("click", () => stepGrid("gridNu", +1));
  byId("shapeGridNvMinus").addEventListener("click", () => stepGrid("gridNv", -1));
  byId("shapeGridNvPlus").addEventListener("click", () => stepGrid("gridNv", +1));
  shapeGridBorderBtn.addEventListener("click", () => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    editorState.shapeBrush.gridBorder = !editorState.shapeBrush.gridBorder;
    pushGridToEngine();
    updateShapeToolbar();
  });
  // 透视模式组槽 + 平面组槽（ADR-0006 UI v2.1，flyout）：mode 决定 VP 数量（切模式时缺的 VP
  //   按默认位补齐，已有的保留用户调过的位置；参考点默认开）；引擎在起笔时经 configFromModeState 拉取。
  const shapePerspModeSlot = byId("shapePerspModeSlot");
  shapePerspModeSlotUse = byId("shapePerspModeSlotUse") as unknown as SVGUseElement;
  const shapePerspModeMenu = byId("shapePerspModeMenu");
  shapePerspModeMenuBtns = [...shapePerspModeMenu.querySelectorAll<HTMLElement>("[data-persp-mode]")];
  shapePlaneCtl = byId("shapePlaneCtl");
  shapePlaneBtns = [...shapePlaneCtl.querySelectorAll<HTMLElement>("[data-shape-plane]")];
  shapePerspExtraCtl = byId("shapePerspExtraCtl");
  shapePerspShowBtn = byId("shapePerspShowBtn");
  shapePerspShowUse = byId("shapePerspShowUse") as unknown as SVGUseElement;
  wireSlotMenu(shapePerspModeSlot, shapePerspModeMenu, (b) => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    const mode = b.dataset.perspMode as PerspMode;
    const g = editorState.persp;
    g.mode = mode;
    if (mode !== "off") {
      // per-mode 槽位（一/二/三点分开存）：本模式缺的 VP 按默认位补齐，调过的保留
      const def = defaultVpsForMode(mode, doc.width, doc.height);
      if (mode === "p1") {
        if (!g.p1.vp1 && def.vp1) g.p1.vp1 = def.vp1;
      } else if (mode === "p2") {
        if (!g.p2.vp1 && def.vp1) g.p2.vp1 = def.vp1;
        if (!g.p2.vp2 && def.vp2) g.p2.vp2 = def.vp2;
      } else {
        if (!g.p3.vp1 && def.vp1) g.p3.vp1 = def.vp1;
        if (!g.p3.vp2 && def.vp2) g.p3.vp2 = def.vp2;
        if (!g.p3.vp3 && def.vp3) g.p3.vp3 = def.vp3;
      }
      const planes = planesForMode(mode) as string[];
      if (!planes.includes(g.plane)) g.plane = "ground";
    }
    updateShapeToolbar();
    board.requestRender();   // 绘图 gizmo 跟着显隐
  });
  for (const b of shapePlaneBtns) {
    b.addEventListener("click", () => {
      if (input.isStrokeActive()) input.abortActiveStroke();
      editorState.persp.plane = b.dataset.shapePlane!;
      updateShapeToolbar();
    });
  }
  shapePerspShowBtn.addEventListener("click", () => {
    editorState.persp.showGizmo = !editorState.persp.showGizmo;
    updateShapeToolbar();
    board.requestRender();
  });
  input.shapeBrush.setPerspProvider(() => configFromModeState(editorState.persp));
  const syncShapeFromEditorState = () => {
    input.shapeBrush.setSubTool(editorState.shapeBrush.sub as Parameters<typeof input.shapeBrush.setSubTool>[0]);
    input.shapeBrush.setConstrain(editorState.shapeBrush.constrain);
    pushGridToEngine();
    updateShapeToolbar();
  };
  window.addEventListener("wp:applyEditorState", syncShapeFromEditorState);
  syncShapeFromEditorState();
  // v242：扩展滑块从魔术棒拆走（改成选区编辑 op，见 initSelEditUI）。魔术棒只剩阈值。
  // v0.5.11：阈值 per-doc 持久化（editorState.magicWand.threshold，原 editorState.bucket 退役后归魔棒）。
  //   UI 改 → 写 editorState + 灌引擎；换文档 → syncMagicThresholdUI 回灌（wp:applyEditorState）。
  const syncMagicThresholdUI = () => {
    const v = editorState.magicWand.threshold;
    lassoThresholdInput.value = String(v);
    lassoThresholdVal.textContent = String(v);
    input.lasso.setMagicThreshold(v);
  };
  lassoThresholdInput.addEventListener("input", () => {
    const v = Math.max(0, Math.min(100, parseInt(lassoThresholdInput.value, 10) || 0));
    editorState.magicWand.threshold = v;
    input.lasso.setMagicThreshold(v);
    lassoThresholdVal.textContent = String(v);
  });
  // #31 魔棒 flood 后自动扩张（v0.5.12 内联化：aria-pressed toggle 钮 + px 输入，⚙/popup 退役）。
  //   引擎只认一个数：effective px = toggle 开 ? px : 0。UI 改 → 写 editorState + 灌引擎；换文档回灌。
  lassoMagicCtx = byId("lassoMagicCtx");
  lassoExpandToggle = byId("lassoExpandToggle");
  lassoMagicExpandPx = byId<HTMLInputElement>("lassoMagicExpandPx");
  const pushMagicExpandToEngine = () => {
    input.lasso.setMagicAutoExpand(editorState.magicWand.expand ? editorState.magicWand.expandPx : 0);
  };
  const syncMagicExpandUI = () => {
    lassoMagicExpandPx.value = String(editorState.magicWand.expandPx);
    pushMagicExpandToEngine();
    updateLassoToolbar();   // toggle pressed 态/px 显隐在 updateLassoToolbar 派生
  };
  lassoExpandToggle.addEventListener("click", () => {
    editorState.magicWand.expand = !editorState.magicWand.expand;
    pushMagicExpandToEngine();
    updateLassoToolbar();
  });
  lassoMagicExpandPx.addEventListener("change", () => {
    const v = Math.max(0, Math.min(100, parseInt(lassoMagicExpandPx.value, 10) || 0));
    lassoMagicExpandPx.value = String(v);
    editorState.magicWand.expandPx = v;
    pushMagicExpandToEngine();
  });
  // 文本框会吞快捷键（合法），Enter=确认并释放焦点——画布点按 preventDefault 夺不回焦点，必须给出口
  lassoMagicExpandPx.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") lassoMagicExpandPx.blur(); });
  window.addEventListener("wp:applyEditorState", syncMagicExpandUI);
  window.addEventListener("wp:applyEditorState", syncMagicThresholdUI);
  syncMagicThresholdUI();
  syncMagicExpandUI();
  // 1:1 约束 toggle（rect / ellipse 用）
  lassoConstrainBtn.addEventListener("click", () => {
    input.lasso.setConstrainSquare(!input.lasso.getConstrainSquare());
    updateLassoToolbar();
  });
  initSelEditUI();   // v242 选区编辑（扩张/收缩）齿轮 + 菜单 + 实时预览 modal

  // 选区动作：变换。v217/218：没选区时让 lasso 用整层做隐式全选（fallbackFullLayer）。
  // selection 状态全归 lasso 管，toolbar 不直接动 doc.selection。
  byId("lassoTransformBtn").addEventListener("click", () => {
    if (editMode.current() !== "lasso") return;   // v0.5.12：fill 无变换（按钮隐藏；T 键点的是隐藏钮，一并挡）
    if (!doc.activeLayer) return;
    // #17 隐藏层护栏：自身或祖先组隐藏 → 变换的是看不见的像素，commit 后无反馈，软拒。
    if (doc.activeNodeHidden()) { setStatus(t("se.hiddenNoTransform"), true); return; }
    const ok = input.lasso.liftSelectionForTransform(doc.activeLayer, { fallbackFullLayer: true });
    if (ok) {
      (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("transform", { apply: _commitTransform, abort: _cancelTransform });
      updateLassoToolbar();
      _suppressTransientPanels("transform");
    } else if (doc.selection) {
      // v232 (user)：选区里没有可变换的像素（全透明 / 与图层无交集 / 小于 2×2）→ 不进变换，
      // 顺手清掉这个没用的选区，别让它卡在那。
      pushSel(input.lasso.setSelection(null));
      board.invalidateAll();
      updateLassoToolbar();
      setStatus(t("se.noPixelsToTransform"));
    } else {
      setStatus(t("se.layerEmptyNoTransform"));
    }
  });

  // #12：浮层变换 水平翻转 / 旋转90°（只在 floating 时该行可见；引擎自带 isActive 护栏）
  byId("lassoFlipHBtn").addEventListener("click", () => {
    input.lasso.flipFloatHorizontal();
    board.invalidateAll();
  });
  byId("lassoRotate90Btn").addEventListener("click", () => {
    input.lasso.rotateFloat90();
    board.invalidateAll();
  });

  byId("lassoDeselectBtn").addEventListener("click", () => {
    pushSel(input.lasso.setSelection(null));
    board.invalidateAll();
    updateLassoToolbar();
  });
  // （v0.5.12：一次性「选区填色」按钮退役——与 fill 工具重复、图标打架（user）。CPU fillOnLayer 仍是
  //   smoke fillParity 的 golden 参考实现，selection.ts 保留。）
  // 清除：选区内 dst-out
  byId("lassoClearBtn").addEventListener("click", () => {
    const layer = requireEditableLeaf(doc, setStatus) as LayerLike | null;
    if (!layer || !doc.selection) return;
    const before = layer.snapshot();   // 归属转给 ops.pixels
    (doc.selection as Selection).clearOnLayer(layer as unknown as Parameters<Selection["clearOnLayer"]>[0]);
    history.run(workpiece, ops.pixels, { layerId: layer.id, _initialBefore: before });
    board.invalidateAll();
    setStatus(t("se.clearedSelection"));
  });
  // v112: 全选（user：「lasso 加全选」）
  byId("lassoSelectAllBtn").addEventListener("click", () => {
    const sel = Selection.full(doc.width, doc.height);
    pushSel(input.lasso.setSelection(sel));
    board.invalidateAll();
    updateLassoToolbar();
  });

  // 反选：在 docW×docH 上 mask 取反
  byId("lassoInvertBtn").addEventListener("click", () => {
    const inv = doc.selection ? (doc.selection as Selection).invert(doc.width, doc.height) : Selection.full(doc.width, doc.height);
    pushSel(input.lasso.setSelection(inv));
    board.invalidateAll();
    updateLassoToolbar();
  });

  // transform 模式 picker + 应用 / 取消
  for (const b of lassoTransformModeBtns) {
    b.addEventListener("click", () => {
      input.lasso.setMode(b.dataset.lassoMode as Parameters<typeof input.lasso.setMode>[0]);
      updateLassoToolbar();
    });
  }
  // commit/cancel 按钮 = 薄壳，走 EditMode → 运行 transform transient 的 apply/abort 闭包（_commit/_cancelTransform）
  byId("lassoCommitBtn").addEventListener("click", () => {
    editMode.applyPendingTransient();
  });
  byId("lassoCancelBtn").addEventListener("click", () => {
    editMode.abortTransient();
  });
  // Stamp：写入图层但保留 float（连击多次叠加盖印）
  byId("lassoStampBtn").addEventListener("click", () => {
    if (!input.lasso.hasFloating()) return;
    if (input.lasso.stamp()) {
      board.invalidateAll();   // S8e：执行器按 contentVersion 自愈，旧 forceGLResyncUnderFloat hint 已拆
      setStatus(t("se.stamped"));
    }
  });
  // v120: 插值模式 dropdown（旧 3 个按钮 → 1 个 select）
  const lassoSampleSel = document.getElementById("lassoSampleSel") as HTMLSelectElement | null;
  // 变换采样 + 调整尺寸 两个 dropdown 都从 resample.js 的 RESAMPLE_MODES SSoT 填（以后加方法/AI 一处生效）
  fillResampleSelect(lassoSampleSel, "transform", "bicubic");
  fillResampleSelect(els.resampleMode, "scale", "bicubic");
  if (lassoSampleSel) {
    lassoSampleSel.addEventListener("change", () => {
      input.lasso.setSampleMode(lassoSampleSel.value);
      board.invalidateAll();
      updateLassoToolbar();
    });
  }
  // 吸色取样模式 dropdown（composite 合并 / layer 当前图层 raw）。
  //   持久化 = editorState.colorPicker.layerMode（per-doc desk，进 .webpaint/editor-state.json）——**不是 LS**，
  //   v406 起设备级 webpaint.pickMode 已删。input._doPick 经 getPickMode 读（走 bindEditorReactive 的桥）。
  pickerToolbar = document.getElementById("pickerToolbar");
  pickModeSel = document.getElementById("pickModeSel") as HTMLSelectElement | null;
  if (pickModeSel) {
    const psel = pickModeSel;
    psel.value = editorState.colorPicker.layerMode;   // binding → state.pickMode（引擎 input._doPick 经 getPickMode 读）
    psel.addEventListener("change", () => { editorState.colorPicker.layerMode = psel.value; });
    // desk 载入：文档的 pickMode 回灌 → 刷新下拉显示（editorState 已由 Unserialize 更新，只同步 UI，不回写）
    window.addEventListener("wp:applyEditorState", () => { psel.value = editorState.colorPicker.layerMode; });
  }
  // 选区 → 新层 / 复制层
  byId("lassoDuplicateBtn").addEventListener("click", () => {
    selectionToNewLayer({ move: false });
  });
  byId("lassoMoveToLayerBtn").addEventListener("click", () => {
    selectionToNewLayer({ move: true });
  });
  window.addEventListener("wp:lassochange", updateLassoToolbar);
  // 任何 history push/undo/redo 都可能改 doc.selection → 刷新 toolbar 显隐
  window.addEventListener("wp:histchange", updateLassoToolbar);

  // ---- EditMode → UI 派生 ----
  window.addEventListener("wp:modechange", _syncEditModeUI);
  _syncEditModeUI();   // 初始同步（boot setTool 同工具会 early-return 不 emit，这里兜一次）

  // ---- 工具按钮 ----
  for (const b of els.toolBtns) {
    b.addEventListener("click", () => {
      const tool = b.dataset.tool!;   // .tool[data-tool] 选择器保证存在
      // tap-active-again：已激活的 rack 工具再点 → 开/关该工具的笔架 sheet
      // 详 conversation v79→v80：「tap = 切换 / 已激活 tap = 开 rack」
      if (editMode.current() === tool && RACK_PANEL_BY_TOOL[tool]) {
        openExclusive(RACK_PANEL_BY_TOOL[tool]);
        return;
      }
      // v124 (user) 第二次按 lasso = Esc 语义：清选区 + 回上一个非 lasso 工具
      if (editMode.current() === "lasso" && tool === "lasso") {
        if (doc.selection) {
          pushSel(input.lasso.setSelection(null));
          board.invalidateAll();
        }
        setTool(_lastNonLassoTool || "brush");
        closeExclusive();
        return;
      }
      const cur = editMode.current();
      if (cur !== "lasso" && cur !== "fill") _lastNonLassoTool = cur;   // fill 属选区家族，不算「上一个非选区工具」
      setTool(tool);
      // 切到新 tool 时关掉之前开的 rack（防止 stale）
      closeExclusive();
    });
  }
  window.addEventListener("wp:settool", (e: Event) => setTool((e as CustomEvent).detail));

  // v120 删：Shapes 子工具栏（当时判「以后 shapes 改 brush preset 的 toggle 字段」）。
  //   2026-07-25 该判决被推翻：形状笔以独立工具回归（ADR-0005，engine=shape-brush.ts，UI=shapeToolbarStack）。
  // pencil 模式下双击 → 笔↔橡皮。但 floating 选区存在时屏蔽（避免误触切工具 = 自动 apply 变换）
  window.addEventListener("wp:doubletap", () => {
    if (input.lasso.hasFloating()) {
      setStatus(t("se.lassoFloatingBusy"));
      return;
    }
    const next = editMode.current() === "eraser" ? "brush" : "eraser";
    setTool(next);
    setStatus(next === "eraser" ? t("se.doubleTapEraser") : t("se.doubleTapBrush"));
  });
  setTool(editMode.current());
}
