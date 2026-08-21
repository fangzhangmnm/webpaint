// 职责（单一）：工具选择 + EditMode→UI 派生 + 套索/选区工具栏。
// 即「选当前工具、把按钮高亮/可点从 EditMode 派生、lasso 子工具/集合运算/变换/选区动作工具栏」。
// drawing app 只经 editMode（持久工具 + transient）这一个轴跟工具耦合：
//   setTool → editMode.setTool → emit wp:modechange → _syncEditModeUI 重新派生整套 UI。
// ctx 绑：editMode/state/doc/board/input/history/wp2/dialReactive/rack/setStatus/leftDial,
//        + app-local（仍在 app.js，经 ctx 绑）：_suppressTransientPanels/_restoreTransientPanels/
//          _commitTransform/_cancelTransform/selectionToNewLayer/afterDocChange。
// importable：Selection（选区取反/全选）、fillResampleSelect（变换采样 dropdown SSoT）。
// undo（v0.8.2 S2；T5 直写组件 verb）：selection-entry 走 SelectionComponent 记账、清除走令牌+LayerTiles。

import { els } from "./els.ts";
import { PANELS, openExclusive, closeExclusive, getCurrentExclusive } from "./panel-state.ts";
import { Selection } from "./backend/selection.ts";
import { MAGIC_ALGORITHMS } from "./lasso.ts";
import { makeRampSlider } from "./ui/ramp-slider.ts";
import type { RampSliderHandle } from "./ui/ramp-slider.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { desk } from "./workbench-state.ts";   // pickMode → desk.colorPicker.layerMode SSoT（binding 写反应式）
import { fillResampleSelect } from "./frontend/resample-modes.ts";
import { t, tLatin } from "./i18n/index.ts";
import { fillPreviewActive, commitFillNow, sendSelectionToFill } from "./fill-mode.ts";
import { anchorPopupToBtn } from "./anchored-popup.ts";
import { configFromModeState, planesForMode, defaultVpsForMode } from "./perspective-frame.ts";
import type { PerspMode } from "./perspective-frame.ts";
import type { AppContext } from "./app-context.ts";
import type { ViewLeafSnap as LayerSnap } from "./backend/workpiece/painting-view.ts";
import type { SelectionPreviewTx } from "./backend/workpiece/selection-component.ts";

// 静态存在的工具栏元素查表 helper（initToolbar 在 DOM 就绪后调）。
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// requireEditableLeaf / transform 收到的 doc 活层（只描述本文件用到的）。
interface LayerLike { id: number; snapshot(): LayerSnap; }
// 选区编辑 modal 态（仅 modal 开着时非 null）。Selection 取自 selection.js 的 class（值导入兼作类型）。
interface SelEditState { tx: SelectionPreviewTx; before: Selection; op: "expand" | "shrink"; rafId: number; }
// editMode.enterTransient 的 apply/abort 回调（edit-mode.js 未类型化，默认 null 把推断窄成 null|undefined → 在调用处断言真签名）。
interface TransientOpts { apply?: () => void; abort?: () => void; }

let editMode: AppContext["editMode"], state: AppContext["state"], doc: AppContext["doc"], board: AppContext["board"];
let input: AppContext["input"], history: AppContext["history"], dialReactive: AppContext["dialReactive"];
let wp2: AppContext["wp2"];
let rack: AppContext["rack"], setStatus: AppContext["setStatus"], leftDial: AppContext["leftDial"];
let _suppressTransientPanels: AppContext["_suppressTransientPanels"];
let _commitTransform: AppContext["_commitTransform"], _cancelTransform: AppContext["_cancelTransform"];
let selectionToNewLayer: AppContext["selectionToNewLayer"];

// selection-entry → SelectionComponent 记账（S2；setSelection 已把 after 应用到 doc，只交 before）。
const pushSel = (entry: { before: Selection | null } | null | undefined) => {
  if (entry) history.withPoint("selection", {}, () => wp2.selection.commitPreApplied(entry.before ?? null));
};

// 套索工具栏 DOM（initToolbar 里查表）。静态元素 → 非空；btn 组 → 数组；下拉 → select。
let lassoToolbarStack: HTMLElement, lassoToolbarRow1: HTMLElement, lassoToolbarRow2: HTMLElement;
let lassoSubToolBar: HTMLElement, lassoTransformCtrl: HTMLElement;
let lassoTransformModeBtns: HTMLElement[];
// v0.7.22 容差滑条 = ramp-slider 分段模式（原生 range 退役：线性映射低端太粗、iPad 无 shift 细调）
let lassoTolSlider: RampSliderHandle | null = null;
let lassoConstrainBtn: HTMLElement;
let lassoSelEditBtn: HTMLElement, lassoSelEditMenu: HTMLElement, fillSelEditMenu: HTMLElement;   // v0.6.30 选区/填色 ⋯ 分家（共享动作处理器）
let lassoSetOpSlot: HTMLElement, lassoSetOpSlotUse: SVGUseElement, lassoSetOpMenu: HTMLElement, lassoSetOpMenuBtns: HTMLElement[];   // 布尔组槽（v0.5.17 回下拉）
let lassoSubSlot: HTMLElement, lassoSubSlotUse: SVGUseElement, lassoSubMenu: HTMLElement, lassoSubMenuBtns: HTMLElement[];   // 子工具组槽（v0.5.14）
let lassoExpandToggle: HTMLElement, lassoMagicExpandVal: HTMLElement, lassoMagicExpandMenu: HTMLElement;   // 扩张钮（v0.6.26 图标+小三角，stepper 收弹出）
let lassoTransformBtn: HTMLElement, lassoFillCommitBtn: HTMLElement, lassoDeselectBtn: HTMLElement;
let pickerToolbar: HTMLElement | null, pickModeSel: HTMLSelectElement | null;   // 吸色 context toolbar（取样模式：合并 / 当前图层）

// v0.6.24 fill/lasso 分家（v0.5.16 的共享 RAM 记忆 _selMem 作废）：子工具/布尔/1:1 per-tool
//   持久化在 desk.lassoTool / fillTool（跟 ora 走）。当前选区工具的记录：
function _selToolRec() {
  return editMode.current() === "fill" ? desk.fillTool : desk.lassoTool;
}
// 把指定工具的记录灌进引擎（setTool 进入时 + 换文档 applyEditorState 时）
function _pushSelToolToEngine(tool: string) {
  const rec = tool === "fill" ? desk.fillTool : desk.lassoTool;
  input.lasso.setSubTool(rec.sub as Parameters<typeof input.lasso.setSubTool>[0]);
  input.lasso.setSetOpMode(rec.setOp as Parameters<typeof input.lasso.setSetOpMode>[0]);
  input.lasso.setConstrainSquare(rec.constrainSquare);
  // v0.7.17 算法 per-tool（user 拍板：油漆桶默认线稿闭合、选区默认像素精确 flood）
  input.lasso.setMagicAlgorithm(rec.algo as Parameters<typeof input.lasso.setMagicAlgorithm>[0]);
}
// （v0.6.31 回滚：顶栏组槽/长按/Alt/右键全撤——user 真机"长按还是难受"；四工具并列，
//   lasso 二击 Esc v124 的废除**保留**；"再点开笔架"v79 于 v0.6.55 恢复（user 2026-07-30）。）
// v0.6.27 小三角统一语义（user）：单击=控件主动作（激活/toggle；纯选择槽=开菜单）；
//   **长按 ≈450ms=开该控件的菜单**；菜单开着再点=关。共享 helper：返回 consume()——
//   长按已触发时吞掉随后的 click。
// v0.6.27（user：下笔时 slot 菜单也该自动关）：全部浮出小菜单的统一登记 + 一把关
const _transientMenus: HTMLElement[] = [];
export function closeTransientMenus() {
  for (const m of _transientMenus) m.classList.add("hidden");
}
const SETOP_ICON: Record<string, string> = { new: "#selection-new", union: "#selection-union", subtract: "#selection-difference", intersect: "#selection-union" };
const SUBTOOL_ICON: Record<string, string> = { freehand: "#select-freehand", rect: "#select-rectangle", ellipse: "#select-ellipse", polygon: "#select-polygon", magic: "#magic-wand", pen: "#pencil" };
// 形状笔（ADR-0005/0006）：组槽 + 约束钮（图标按子工具换义）+ grid 配置 + 透视平面槽
let shapeToolbarStack: HTMLElement, shapeSubBtns: HTMLElement[],
    shapeGridMenu: HTMLElement,
    shapeSubLineUse: SVGUseElement, shapeSubRectUse: SVGUseElement, shapeSubCircleUse: SVGUseElement,
    shapeVarMenus: Record<string, HTMLElement>,
    shapeGridNuVal: HTMLElement, shapeGridNvVal: HTMLElement, shapeGridBorderBtn: HTMLElement,
    shapePerspModeSlotUse: SVGUseElement, shapePerspModeMenuBtns: HTMLElement[],
    shapePlaneCtl: HTMLElement, shapePlaneBtns: HTMLElement[],
    shapePerspExtraCtl: HTMLElement, shapePerspShowBtn: HTMLElement, shapePerspShowUse: SVGUseElement;
const PERSP_MODE_ICON: Record<string, string> = { off: "#persp-viewport", p1: "#persp-1p", p2: "#persp-2p", p3: "#persp-3p", iso: "#persp-iso" };
// v0.6.25 变体化（user：不走 toggle 走小三角；推翻 2026-07-25 constrain-ratio 合并裁定——
//   变体是并列可选项要成对可辨图标；square/ellipse 走 stopgap 待入库）：钮面 = 当前变体图标
const CONSTRAIN_KEY: Record<string, "constrainLine" | "constrainRect" | "constrainCircle"> = { line: "constrainLine", rect: "constrainRect", circle: "constrainCircle" };

// 形状笔上下文工具栏派生（对齐 updateLassoToolbar 的「统一同步点」纪律）
export function updateShapeToolbar() {
  if (!shapeToolbarStack) return;
  const active = editMode.current() === "shapeBrush";
  shapeToolbarStack.classList.toggle("hidden", !active);
  if (!active) { shapeGridMenu?.classList.add("hidden"); return; }
  const sub = input.shapeBrush.getSubTool();
  const gPersp = desk.persp;
  const perspMode = (["p1", "p2", "p3", "iso"].includes(gPersp.mode) ? gPersp.mode : "off") as PerspMode;
  for (const b of shapeSubBtns) {
    b.setAttribute("aria-pressed", b.dataset.shapeSub === sub ? "true" : "false");
  }
  // v0.6.25 变体钮面：line=自由/15°snap（透视下 snap 换「吸向消失点」义）；rect=长方/正方；circle=椭圆/正圆
  const es = desk.shapeBrush;
  const lineSnapIcon = perspMode !== "off" ? "#snap-vanishing-point" : "#line-snap";   // v0.6.27：15° 字样图标退位（user），line-snap stopgap 待真图
  shapeSubLineUse.setAttribute("href", es.constrainLine ? lineSnapIcon : "#line");
  shapeSubRectUse.setAttribute("href", es.constrainRect ? "#square" : "#rectangle");
  shapeSubCircleUse.setAttribute("href", es.constrainCircle ? "#circle" : "#ellipse");
  (document.getElementById("shapeLineSnapUse") as unknown as SVGUseElement | null)?.setAttribute("href", lineSnapIcon);
  for (const [s2, menu] of Object.entries(shapeVarMenus)) {
    if (s2 !== "grid") {
      const on = !!es[CONSTRAIN_KEY[s2]];
      for (const mb of menu.querySelectorAll<HTMLElement>("[data-shape-var]")) {
        mb.setAttribute("aria-pressed", (mb.dataset.shapeVar === "constrain") === on ? "true" : "false");
      }
    }
    if (s2 !== sub) menu.classList.add("hidden");   // 切子工具收起别家的菜单
  }
  if (sub === "grid") {
    shapeGridNuVal.textContent = String(desk.shapeBrush.gridNu);
    shapeGridNvVal.textContent = String(desk.shapeBrush.gridNv);
    shapeGridBorderBtn.setAttribute("aria-pressed", desk.shapeBrush.gridBorder ? "true" : "false");
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
  // v0.7.40 fill 下 setOp 槽=单击 toggle：摘小三角（三角纪律 v0.6.31：有三角=有菜单，toggle 化
  //   必须摘否则 UI 撒谎）+ haspopup 切换 + title 说当前态（点一下会切到哪边一目了然）
  lassoSetOpSlot.querySelector(".lasso-slot-caret")?.classList.toggle("hidden", fillActive);
  lassoSetOpSlot.setAttribute("aria-haspopup", fillActive ? "false" : "true");
  lassoSetOpSlot.setAttribute("title", fillActive
    ? t(setOp === "subtract" ? "la.subtract" : "la.union") : t("la.setOpSlot"));
  if (fillActive) lassoSetOpMenu.classList.add("hidden");
  // ⋯ 菜单：v0.7.2 起只剩命令（算法配置搬进扳手弹出）；按选区有无禁用
  const magicOn = sub === "magic";
  for (const menu of [lassoSelEditMenu, fillSelEditMenu]) {
    for (const el of menu.querySelectorAll<HTMLButtonElement>(".lasso-menu-needs-sel")) el.disabled = !hasSelection;
  }
  // v0.7 魔棒算法选择（v0.7.8 组槽+弹出替代系统 select）：magic 子工具时显，label/pressed 镜像引擎态（RAM-only）
  const algoBtn = document.getElementById("lassoAlgoBtn");
  if (algoBtn) {
    const algo = input.lasso.getMagicAlgorithm();
    const lbl = document.getElementById("lassoAlgoBtnLabel");
    const cur = MAGIC_ALGORITHMS.find((a) => a.id === algo);
    if (lbl && cur) lbl.textContent = t(cur.labelKey as Parameters<typeof t>[0]);
    const algoMenu = document.getElementById("lassoAlgoMenu");
    if (algoMenu) {
      if (!magicOn) algoMenu.classList.add("hidden");
      for (const b of algoMenu.querySelectorAll<HTMLElement>("[data-lasso-algo]")) {
        b.setAttribute("aria-pressed", b.dataset.lassoAlgo === algo ? "true" : "false");
      }
    }
  }
  // v0.7.26 选区笔走笔架：pen 子工具时放行左栏 size/opacity dial（写的是 toolStates.selPen——
  //   lasso/fill 的 rack key 已映射；晚于 updateToolUI 的赋值 → 本行赢）
  const penOn = selToolActive && sub === "pen";
  dialReactive.canDraw = editMode.canDraw() || penOn;
  // v0.7.28 旁挂笔架钮（滤镜笔同款）：pen 子模式才显（显隐在 VIS 表）；切走时若选区笔笔架开着 → 收
  //   （user bug 报告：切其他子工具笔架没隐藏）
  if (!penOn && getCurrentExclusive() === PANELS.RACK_SEL_PEN) closeExclusive();
  // v0.7.2 算法配置扳手：magic 时显（VIS 表）；弹出行按当前算法显隐 + 值同步（关掉时收弹出）
  const cfgBtn = document.getElementById("lassoAlgoCfgBtn");
  const cfgMenu = document.getElementById("lassoAlgoCfgMenu");
  if (!magicOn) cfgMenu?.classList.add("hidden");
  if (cfgMenu) {
    const lineartOn = input.lasso.getMagicAlgorithm() === "lineart";
    // v0.7.21：algo-cfg-classic 行退役（容差外提 Row1）；色差度量行 classic/similar 显（lineart 按亮度二值化不吃）
    for (const el of cfgMenu.querySelectorAll<HTMLElement>(".algo-cfg-colormetric")) el.classList.toggle("hidden", lineartOn);
    for (const el of cfgMenu.querySelectorAll<HTMLElement>(".algo-cfg-lineart")) el.classList.toggle("hidden", !lineartOn);
    const metric = desk.magicWand.metric === "rgb" ? "rgb" : "oklab";
    document.getElementById("lassoMetricOklab")?.setAttribute("aria-pressed", metric === "oklab" ? "true" : "false");
    document.getElementById("lassoMetricRgb")?.setAttribute("aria-pressed", metric === "rgb" ? "true" : "false");
    const dv = document.getElementById("lassoDmaxVal");
    if (dv) dv.textContent = String(input.lasso.getLineartCloseDist());
    const iv = document.getElementById("lassoInkThresholdVal");
    if (iv) {
      const ink = input.lasso.getLineartInkThreshold();
      iv.textContent = ink < 0 ? t("la.inkAuto") : String(ink);
    }
    document.getElementById("lassoInkAuto")?.setAttribute(
      "aria-pressed", input.lasso.getLineartInkThreshold() < 0 ? "true" : "false");
    const av = document.getElementById("lassoAminVal");
    if (av) av.textContent = String(input.lasso.getLineartMinRegion());
    const sv = document.getElementById("lassoTipSensVal");
    if (sv) sv.textContent = String(input.lasso.getLineartTipSensitivity());
    const bv = document.getElementById("lassoBleedVal");
    if (bv) {
      const bl = input.lasso.getLineartBleed();
      bv.textContent = bl < 0 ? t("la.bleedAuto") : String(bl);
    }
    document.getElementById("lassoLineartDebugBtn")?.setAttribute(
      "aria-pressed", input.lasso.getLineartDebugView() ? "true" : "false");
  }
  // v0.7.21 容差滑条外提（user：不折进扳手，值一直可见）：classic/similar 时显，值按当前算法路由
  //   （classic→magicWand.threshold / similar→magicWand.similarThreshold；lineart 无容差概念 → 藏）
  const tolWrap = document.getElementById("lassoTolWrap");
  const algoNow = input.lasso.getMagicAlgorithm();
  const showTol = magicOn && algoNow !== "lineart";
  if (tolWrap && showTol && lassoTolSlider) {
    const v = algoNow === "similar" ? desk.magicWand.similarThreshold : desk.magicWand.threshold;
    if (lassoTolSlider.get() !== v) lassoTolSlider.set(v);
  }
  // v0.6.26：扩张钮（图标+小三角）magic 子工具时显；stepper 弹出跟随开关（关/切走时收）
  // v0.7.8：线稿算法时藏（auto-expand 是 classic flood 专属 param，引擎侧同步不吃）
  // v0.7.21：similar 也给扩张（全图同色 + 扩 1px = 盖 AA 白边再填）
  const expandApplies = magicOn && algoNow !== "lineart";
  lassoExpandToggle.setAttribute("aria-pressed", desk.magicWand.expand ? "true" : "false");
  if (!expandApplies || !desk.magicWand.expand) lassoMagicExpandMenu?.classList.add("hidden");
  // v0.7.24 容隙钮：classic 专属（lineart 自带论文闭合、similar 无连通概念）
  const gapApplies = magicOn && algoNow === "classic";
  const gapToggle = document.getElementById("lassoGapToggle");
  gapToggle?.setAttribute("aria-pressed", desk.magicWand.fillGap ? "true" : "false");
  if (!gapApplies || !desk.magicWand.fillGap) document.getElementById("lassoGapMenu")?.classList.add("hidden");
  // ⋯ 菜单钮：modal 开着时(_selEdit)恒亮（预览 shrink 到空不能把 modal 撕掉）。
  const showSelEdit = !!_selEdit || (showRow1 && !otherToolSel);
  if (!showSelEdit) closeSelEditUI();
  // v0.6.30 分家后 lasso-only/fill-only 类开关退役（漏显温床）；蚂蚁线 v0.7.40 起 per-tool 两钮各归各
  document.getElementById("lassoAntsBtn")?.setAttribute("aria-pressed", desk.fillTool.showAnts ? "true" : "false");
  document.getElementById("lassoSelAntsBtn")?.setAttribute("aria-pressed", desk.lassoTool.showAnts ? "true" : "false");
  // 1:1 约束按钮：仅 rect / ellipse 子工具下显示
  const showConstrain = sub === "rect" || sub === "ellipse";
  if (showConstrain) {
    lassoConstrainBtn.setAttribute("aria-pressed", input.lasso.getConstrainSquare() ? "true" : "false");
  }
  // ===== v0.7.39 声明式显隐表（user：contextual show/hide 已是反复模式——先收成一处可读表；
  //   registry 深模块留给 UI refactor 纪元，别在这批上大抽象）。条件住 JS（v0.6.30 教训：
  //   CSS 类开关汤 = 漏显温床，别复活）。副作用（aria-pressed/收菜单/滑条同步）仍在各自块。 =====
  const VIS: [HTMLElement | null, boolean][] = [
    [algoBtn, magicOn],                                                    // v0.7 魔棒算法组槽
    [document.getElementById("selPenRackBtn"), penOn],                     // v0.7.28 选区笔笔架旁挂
    [cfgBtn, magicOn],                                                     // v0.7.2 算法配置扳手
    [tolWrap, showTol],                                                    // v0.7.21 容差滑条外提
    [lassoExpandToggle, expandApplies],                                    // v0.6.26 扩张
    [gapToggle, gapApplies],                                               // v0.7.24 容隙
    [document.getElementById("lassoClearBtn"), lassoActive && hasSelection], // v0.6.19 清像素（lasso 专属）
    [lassoSelEditBtn, showSelEdit],                                        // ⋯ 菜单钮
    [lassoConstrainBtn, showConstrain],                                    // 1:1 约束
    // v0.7.39 同槽互斥双钮（user：全选只在无选区、反选只在有选区）；otherToolSel 时 selToolActive=false 双藏
    [document.getElementById("lassoRow1SelectAllBtn"), selToolActive && !floating && !hasSelection],
    [document.getElementById("lassoRow1InvertBtn"), selToolActive && !floating && hasSelection],
    [lassoDeselectBtn, hasSelection],                                      // v0.5.14 去选=有选区才显
    [lassoTransformBtn, lassoActive],                                      // 变换=选区工具专属
    [lassoFillCommitBtn, fillActive && fillPreviewActive()],               // ✓=填充+预览挂着
  ];
  for (const [el, on] of VIS) el?.classList.toggle("hidden", !on);
  if (floating) {
    const mode = input.lasso.getMode();
    for (const b of lassoTransformModeBtns) {
      b.setAttribute("aria-pressed", b.dataset.lassoMode === mode ? "true" : "false");
      // 自由度记账制（v0.6.34）：用过更高自由度后降不回去的模式置灰（不投影、不悄悄改 mesh）
      (b as HTMLButtonElement).disabled = !input.lasso.canSetMode(b.dataset.lassoMode as never);
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
  document.body.dataset.tool = tool;   // 持久工具的 CSS hook（transient 期间保持不变）。
  //   v0.6.26：必须先于 editMode.setTool——modechange 里的组槽同步读它，后写会慢一拍（真机：图标反了）
  editMode.setTool(tool);   // emit wp:modechange → _syncEditModeUI 派生按钮高亮 / lasso 工具栏
  // 切工具 → 应用该工具的 per-tool state（size/flow/activeBrushId）+ preset 冻结字段
  //   shapeBrush alias 到 brush（getRackToolKey）：共享笔架 + 共享当前笔/dial（user：「笔和绘制用的笔刷共享笔架」）
  if (tool === "brush" || tool === "eraser" || tool === "filterBrush" || tool === "shapeBrush"
      || tool === "lasso" || tool === "fill") {   // v0.7.26 选区笔：进 lasso/fill 灌 selPen dial
    rack.applyToolState(tool);
  }
  // v0.6.24：进选区/填色工具 → 灌该工具自己的持久化记录（fill 默认魔棒+并、selection 默认套索+新建；
  //   fill 的「新建」菜单项本就隐藏，无需 coerce）。
  if (tool === "lasso" || tool === "fill") {
    _pushSelToolToEngine(tool);
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
  // v0.6.31：四工具并列（fill 有自己的顶栏钮），高亮 = data-tool 直配
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", (!transient && b.dataset.tool === m) ? "true" : "false");
  // 液化 / filterBrush 没独立 data-tool 按钮，用 adjust 按钮高亮（transient 期间也不亮）
  els.topAdjustBtn?.setAttribute("aria-pressed", (m === "filterBrush") ? "true" : "false");
  // 注：body.dataset.tool 保持"持久工具"（在 setTool 里设），不在这改成 transient 名——避免扰乱
  // 依赖 body[data-tool] 的 CSS（且 data-mode 被图库占用）。transient 的 UI 抑制走面板 suppress + 按钮高亮。
  // slider 禁用：size/opacity 仅 canDraw 模式可调 → 反应式镜像，<LeftDial> 绑 :disabled。color 仅 allowsColor 可点。
  dialReactive.canDraw = editMode.canDraw();
  if (els.activeSwatch) (els.activeSwatch as HTMLButtonElement).disabled = !editMode.allowsColor();
  updateLassoToolbar();             // 选区/变换工具栏跟着重新派生
  updateShapeToolbar();             // 形状笔工具栏跟着重新派生（与 lasso stack 互斥）
  board.requestRender();            // overlay chrome（透视 gizmo/蚂蚁线）随工具显隐——不补这刀
                                    //   切工具后 gizmo 残留/不出现，直到下次 pan/落笔（"闪"，2026-07-28 修）
}

// ===== v242 选区编辑 op：扩张 / 收缩（走 adjust transient + 实时预览）=====
// 齿轮 → 菜单(扩张/收缩) → modal：数字输入，蚂蚁线随输入实时变；应用/取消。
//   预览 = 直接改 doc.selection（不 push history）；应用 = push 一条 selectionChange(before→after)；
//   取消 / ctrl-z / 切工具 = 还原 before。硬边（Selection.morphed），不羽化——羽化是以后的事。
// 设计照搬 filters-adjust 的 transient 生命周期（enterTransient("adjust") + 统一 exit 同步点）。
let _selEdit: SelEditState | null = null;   // { before, op:'expand'|'shrink', rafId } —— 仅 modal 开着时非 null

function _selEditEls() {
  return {
    // v0.6.30 分家：⋯ 开当前工具自己的菜单
    menu: document.getElementById(editMode.current() === "fill" ? "fillSelEditMenu" : "lassoSelEditMenu"),
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
  // v0.8.2（S2）：预览写走 SelectionPreviewTx（旧预览就地 dispose、origin 保管在 tx）。
  //   morphed(0) 返回 before 本体 → write(origin) 合法（= 预览回到原选区）。
  s.tx.write(s.before.morphed(signed, doc.width, doc.height) as Selection);
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
  const tx = wp2.selection.beginPreview();
  _selEdit = { tx, before: tx.origin() as Selection, op, rafId: 0 };
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
    const r = s.tx.commit();   // 变了才记账（before 所有权交组件 record）；无变化不占 undo 步
    if (r.changed) history.withPoint("selection", {}, () => wp2.selection.commitPreApplied(r.before));
    setStatus(s.op === "expand" ? t("se.selectionExpanded") : t("se.selectionShrunk"));
  } else {
    s.tx.abort();    // 无痕还原 origin，预览产物就地 dispose
  }
  popup?.classList.add("hidden");
  input.lasso.onChange?.();
  updateLassoToolbar();
  editMode.exitTransient();                 // 同步点：清 EditMode transient（同 _closeFilterPanel 尾）
}
// 收起齿轮菜单（updateLassoToolbar 在选区没了/切走时调；此时 _selEdit 必为 null，不碰 modal）
function closeSelEditUI() {
  document.getElementById("lassoSelEditMenu")?.classList.add("hidden");
  document.getElementById("fillSelEditMenu")?.classList.add("hidden");
}
function initSelEditUI() {
  const { amount } = _selEditEls();
  lassoSelEditBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (_selEdit) return;                   // modal 开着时不响应
    const menu = _selEditEls().menu;        // v0.6.30：开当前工具的菜单（另一份先收）
    const other = document.getElementById(editMode.current() === "fill" ? "lassoSelEditMenu" : "fillSelEditMenu");
    other?.classList.add("hidden");
    const wasHidden = menu?.classList.contains("hidden");
    menu?.classList.toggle("hidden");
    if (wasHidden && menu) anchorPopupToBtn(menu, lassoSelEditBtn, { align: "left", offsetY: 6 });   // v0.5.14 贴钮
  });
  // 蚂蚁线 toggle（v0.6.19，ADR-0004 修订；v0.7.40 per-tool 分家）：写 desk（per-doc）+ 重绘；
  //   不关菜单（toggle 类操作连按友好）。fill 菜单钮管 fillTool、selection 菜单钮管 lassoTool。
  document.getElementById("lassoAntsBtn")?.addEventListener("click", () => {
    desk.fillTool.showAnts = !desk.fillTool.showAnts;
    board.requestRender();
    updateLassoToolbar();
  });
  document.getElementById("lassoSelAntsBtn")?.addEventListener("click", () => {
    desk.lassoTool.showAnts = !desk.lassoTool.showAnts;
    board.requestRender();
    updateLassoToolbar();
  });
  // v0.7.2 算法配置扳手弹出（user：⋯只留命令，configuration 进扳手小三角）。
  //   slider/stepper 连按不关 = 手动 toggle + 外点关（lassoMagicExpandMenu 样板）。
  //   v0.7.17（user 授权）：线稿 knob 全部 desk.magicWand 持久化（跟文件走）——
  //   UI 改 → 写 desk + 灌引擎；换文档 wp:applyEditorState 回灌（阈值同款样板）。
  //   调试视图仍 RAM-only（诊断开关不是作品属性）。
  const lassoAlgoCfgBtn = document.getElementById("lassoAlgoCfgBtn");
  const lassoAlgoCfgMenu = document.getElementById("lassoAlgoCfgMenu");
  if (lassoAlgoCfgBtn && lassoAlgoCfgMenu) {
    _transientMenus.push(lassoAlgoCfgMenu);
    lassoAlgoCfgBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      const wasHidden = lassoAlgoCfgMenu.classList.contains("hidden");
      lassoAlgoCfgMenu.classList.toggle("hidden");
      if (wasHidden) anchorPopupToBtn(lassoAlgoCfgMenu, lassoAlgoCfgBtn, { align: "left", offsetY: 6 });
      updateLassoToolbar();   // 行显隐/值同步
    });
    document.addEventListener("pointerdown", (e: Event) => {
      if (lassoAlgoCfgMenu.classList.contains("hidden")) return;
      if (lassoAlgoCfgMenu.contains(e.target as Node) || lassoAlgoCfgBtn.contains(e.target as Node)) return;
      lassoAlgoCfgMenu.classList.add("hidden");
    });
    const bleedLabel = (v: number) => (v < 0 ? t("la.bleedAuto") : String(v));
    // 闭合距离 stepper（±16；8..256 clamp 在引擎侧，写回 clamp 后的真值）
    const dmaxVal = document.getElementById("lassoDmaxVal");
    const stepDmax = (d: number) => {
      input.lasso.setLineartCloseDist(input.lasso.getLineartCloseDist() + d);
      desk.magicWand.lineartCloseDist = input.lasso.getLineartCloseDist();
      if (dmaxVal) dmaxVal.textContent = String(input.lasso.getLineartCloseDist());
    };
    document.getElementById("lassoDmaxMinus")?.addEventListener("click", () => stepDmax(-16));
    document.getElementById("lassoDmaxPlus")?.addEventListener("click", () => stepDmax(+16));
    // 墨线判定（v0.10.11 动态档默认）：动态钮 = alpha/Otsu 自动分派；拖 slider = 落手动档（浅色线稿往上调）
    const inkInp = document.getElementById("lassoInkThreshold") as HTMLInputElement | null;
    const inkVal = document.getElementById("lassoInkThresholdVal");
    const inkAutoBtn = document.getElementById("lassoInkAuto");
    const syncInkUI = () => {
      const v = input.lasso.getLineartInkThreshold();
      if (inkInp && v >= 0) inkInp.value = String(v);
      if (inkVal) inkVal.textContent = v < 0 ? t("la.inkAuto") : String(v);
      inkAutoBtn?.setAttribute("aria-pressed", v < 0 ? "true" : "false");
    };
    inkInp?.addEventListener("input", () => {
      const v = Math.max(0, Math.min(100, parseInt(inkInp.value, 10) || 0));
      input.lasso.setLineartInkThreshold(v);
      desk.magicWand.lineartInk = v;
      syncInkUI();
    });
    inkAutoBtn?.addEventListener("click", () => {
      const cur = input.lasso.getLineartInkThreshold();
      const next = cur < 0 ? Math.max(0, Math.min(100, parseInt(inkInp?.value ?? "50", 10) || 50)) : -1;
      input.lasso.setLineartInkThreshold(next);
      desk.magicWand.lineartInk = next;
      syncInkUI();
    });
    // v0.7.4 碎区下限 stepper（±8；0=关守卫）
    const aminVal = document.getElementById("lassoAminVal");
    const stepAmin = (d: number) => {
      input.lasso.setLineartMinRegion(input.lasso.getLineartMinRegion() + d);
      desk.magicWand.lineartMinRegion = input.lasso.getLineartMinRegion();
      if (aminVal) aminVal.textContent = String(input.lasso.getLineartMinRegion());
    };
    document.getElementById("lassoAminMinus")?.addEventListener("click", () => stepAmin(-8));
    document.getElementById("lassoAminPlus")?.addEventListener("click", () => stepAmin(+8));
    // v0.7.4 端点灵敏度 slider（高=抓得住收尖线头，代价=假端点）
    const sensInp = document.getElementById("lassoTipSens") as HTMLInputElement | null;
    const sensVal = document.getElementById("lassoTipSensVal");
    sensInp?.addEventListener("input", () => {
      const v = Math.max(0, Math.min(100, parseInt(sensInp.value, 10) || 0));
      input.lasso.setLineartTipSensitivity(v);
      desk.magicWand.lineartTipSens = v;
      if (sensVal) sensVal.textContent = String(v);
    });
    // v0.7.17 蔓延距离 stepper（-1=自动填到中线 / 0=像素画不碰真墨水 / 1..8 陷 n px；
    //   档位数组步进；query-time 参数不作废分区缓存，拨了即时生效）
    const BLEED_STEPS = [-1, 0, 1, 2, 3, 4, 6, 8];
    const bleedVal = document.getElementById("lassoBleedVal");
    const stepBleed = (d: number) => {
      const cur = input.lasso.getLineartBleed();
      let i = BLEED_STEPS.indexOf(cur);
      if (i < 0) i = 0;
      i = Math.max(0, Math.min(BLEED_STEPS.length - 1, i + d));
      input.lasso.setLineartBleed(BLEED_STEPS[i]);
      desk.magicWand.lineartBleed = BLEED_STEPS[i];
      if (bleedVal) bleedVal.textContent = bleedLabel(BLEED_STEPS[i]);
    };
    document.getElementById("lassoBleedMinus")?.addEventListener("click", () => stepBleed(-1));
    document.getElementById("lassoBleedPlus")?.addEventListener("click", () => stepBleed(+1));
    // 换文档回灌：desk → 引擎 + UI（阈值 syncMagicThresholdUI 同款）
    const syncLineartFromEditorState = () => {
      const mw = desk.magicWand;
      input.lasso.setLineartCloseDist(mw.lineartCloseDist);
      input.lasso.setLineartInkThreshold(mw.lineartInk);
      input.lasso.setLineartMinRegion(mw.lineartMinRegion);
      input.lasso.setLineartTipSensitivity(mw.lineartTipSens);
      input.lasso.setLineartBleed(mw.lineartBleed);
      if (dmaxVal) dmaxVal.textContent = String(input.lasso.getLineartCloseDist());
      syncInkUI();
      if (aminVal) aminVal.textContent = String(input.lasso.getLineartMinRegion());
      if (sensInp) sensInp.value = String(input.lasso.getLineartTipSensitivity());
      if (sensVal) sensVal.textContent = String(input.lasso.getLineartTipSensitivity());
      if (bleedVal) bleedVal.textContent = bleedLabel(input.lasso.getLineartBleed());
    };
    window.addEventListener("wp:applyEditorState", syncLineartFromEditorState);
    syncLineartFromEditorState();
    // v0.7.4 调试视图 toggle：端点+候选桥 overlay（绿=补上/橙=τ毙/红=碎区毙；有点无桥=ω 结构排除）。
    //   数据只在分区已缓存时出现——开了之后先 tap 一下让分区建起来。
    document.getElementById("lassoLineartDebugBtn")?.addEventListener("click", () => {
      input.lasso.setLineartDebugView(!input.lasso.getLineartDebugView());
      board.invalidateAll();
      updateLassoToolbar();
    });
  }
  // modal 内方向切换（v0.5.15 user：扩张/收缩同一入口）：切方向 = 换 op 就地重预览（预览恒从 before 派生）。
  document.getElementById("lassoSelOpExpandBtn")?.addEventListener("click", () => _setSelEditOp("expand"));
  document.getElementById("lassoSelOpShrinkBtn")?.addEventListener("click", () => _setSelEditOp("shrink"));
  amount?.addEventListener("input", _onSelEditInput);
  amount?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); _finishSelEdit(true); }
  });
  document.getElementById("lassoSelOpApply")?.addEventListener("click", () => _finishSelEdit(true));
  document.getElementById("lassoSelOpCancel")?.addEventListener("click", () => _finishSelEdit(false));
  // 点菜单外侧 → 关菜单（modal 自有 apply/cancel，不在此关）；v0.6.30 两份都管
  document.addEventListener("pointerdown", (e: Event) => {
    for (const id of ["lassoSelEditMenu", "fillSelEditMenu"]) {
      const menu = document.getElementById(id);
      if (!menu || menu.classList.contains("hidden")) continue;
      if (menu.contains(e.target as Node) || lassoSelEditBtn.contains(e.target as Node)) continue;
      menu.classList.add("hidden");
    }
  });
}

// Rack 工具 → 对应的 exclusive panel id
export const RACK_PANEL_BY_TOOL: Record<string, string> = {
  brush: PANELS.RACK_BRUSH,
  eraser: PANELS.RACK_ERASER,
  filterBrush: PANELS.RACK_FILTER_BRUSH,    // v132
  shapeBrush: PANELS.RACK_BRUSH,            // ADR-0005：共享 brush 笔架
  // v0.7.26 选区笔走笔架：lasso/fill 二次点工具钮 = 开选区笔笔架（getRackToolKey → "selPen" 列表）
  lasso: PANELS.RACK_SEL_PEN,
  fill: PANELS.RACK_SEL_PEN,
};
// （v0.6.24：_lastNonLassoTool 退役——lasso 二击 Esc 语义随组槽让位）

export function initToolbar(ctx: AppContext) {
  ({
    editMode, state, doc, board, input, history, wp2, dialReactive, rack, setStatus, leftDial,
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
  lassoConstrainBtn = byId("lassoConstrainBtn");
  lassoSelEditBtn = byId("lassoSelEditBtn");
  lassoSelEditMenu = byId("lassoSelEditMenu");
  fillSelEditMenu = byId("fillSelEditMenu");
  _transientMenus.push(lassoSelEditMenu);
  _transientMenus.push(fillSelEditMenu);
  lassoTransformBtn = byId("lassoTransformBtn");
  lassoDeselectBtn = byId("lassoDeselectBtn");
  lassoFillCommitBtn = byId("lassoFillCommitBtn");
  lassoFillCommitBtn.addEventListener("click", () => { commitFillNow(); updateLassoToolbar(); });
  // 油漆桶 = 套索的深模式 toggle（row1 变换旁，user v0.5.14）：进=fill 工具（恢复 fill 的记忆子工具），
  //   出=回套索（切出=commit 由 fill-mode 的 modechange 钩子管，这里零填色知识）。
  // v0.6.24：lassoFillModeBtn 退役（fill 升顶栏组槽）
  window.addEventListener("wp:applyEditorState", updateLassoToolbar);   // 换文档：阈值/扩张态回灌后重派生

  // v0.5.14 组槽通用：点槽 → 锚定槽下方弹紧凑图标排（user：下拉要贴槽、图标不要文字）。
  // v0.7.40 拆成两半：wireMenuItems（菜单项+外点关）+ openSlotMenu（开合锚定）——
  //   为 setOp 槽的 mode-aware 单击让路；其余 3 个调用点经 wireSlotMenu 合体，行为逐 bit 不变。
  const openSlotMenu = (slot: HTMLElement, menu: HTMLElement) => {
    const wasHidden = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    if (wasHidden) anchorPopupToBtn(menu, slot, { align: "left", offsetY: 6 });
  };
  const wireMenuItems = (slot: HTMLElement, menu: HTMLElement, onPick: (b: HTMLElement) => void) => {
    _transientMenus.push(menu);
    for (const b of [...menu.querySelectorAll<HTMLElement>("button")]) {
      b.addEventListener("click", () => { onPick(b); menu.classList.add("hidden"); updateLassoToolbar(); });
    }
    document.addEventListener("pointerdown", (e: Event) => {
      if (menu.classList.contains("hidden")) return;
      if (menu.contains(e.target as Node) || slot.contains(e.target as Node)) return;
      menu.classList.add("hidden");
    });
  };
  const wireSlotMenu = (slot: HTMLElement, menu: HTMLElement, onPick: (b: HTMLElement) => void) => {
    // 纯选择槽（v0.6.31 唯一的小三角语义）：单击=开/关菜单
    slot.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      openSlotMenu(slot, menu);
    });
    wireMenuItems(slot, menu, onPick);
  };
  // 子工具组槽（freehand/rect/ellipse/polygon/flood 收一组；v0.6.24 套索/填色真·各记各的
  //   ——desk.lassoTool/fillTool per-tool 持久化）
  lassoSubSlot = byId("lassoSubSlot");
  lassoSubSlotUse = byId("lassoSubSlotUse") as unknown as SVGUseElement;
  lassoSubMenu = byId("lassoSubMenu");
  lassoSubMenuBtns = [...lassoSubMenu.querySelectorAll<HTMLElement>("[data-lasso-sub]")];
  wireSlotMenu(lassoSubSlot, lassoSubMenu, (b) => {
    const subName = b.dataset.lassoSub as Parameters<typeof input.lasso.setSubTool>[0];
    input.lasso.setSubTool(subName);
    _selToolRec().sub = subName;   // 写当前工具自己的持久化记录
  });
  // v0.7.28（user：「已选再点」别扭回滚）：选区笔笔架入口 = 旁挂笔架图标钮（滤镜笔
  //   #filterBrushOpenRack 同款），pen 子模式才显示（context-aware，显隐在 updateLassoToolbar）
  document.getElementById("selPenRackBtn")?.addEventListener("click", () => {
    openExclusive(PANELS.RACK_SEL_PEN);
  });
  // 布尔组槽（v0.5.17 user：改回下拉，横排纯图标）
  // v0.7.40（user：「fill 里布尔应该单击直接 +/− toggle，不要展开槽再选」）：mode-aware——
  //   fill = 单击 toggle union↔subtract（"新建" 在 fill 本就隐藏，两态零信息损失；非 subtract
  //   一律当 union 处理，防老 doc 的 fillTool.setOp 存过 "new"）；lasso = 原槽菜单三选一。
  //   小三角/haspopup/title 的两态切换在 updateLassoToolbar（三角纪律：有三角=有菜单）。
  lassoSetOpSlot = byId("lassoSetOpSlot");
  lassoSetOpSlotUse = byId("lassoSetOpSlotUse") as unknown as SVGUseElement;
  lassoSetOpMenu = byId("lassoSetOpMenu");
  lassoSetOpMenuBtns = [...lassoSetOpMenu.querySelectorAll<HTMLElement>("[data-lasso-setop]")];
  wireMenuItems(lassoSetOpSlot, lassoSetOpMenu, (b) => {
    const op = b.dataset.lassoSetop as Parameters<typeof input.lasso.setSetOpMode>[0];
    input.lasso.setSetOpMode(op);
    _selToolRec().setOp = op;   // 写当前工具自己的记录（fill 里「新建」项已隐）
  });
  lassoSetOpSlot.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (editMode.current() === "fill") {
      const next = input.lasso.getSetOpMode() === "subtract" ? "union" : "subtract";
      input.lasso.setSetOpMode(next);
      _selToolRec().setOp = next;
      lassoSetOpMenu.classList.add("hidden");
      updateLassoToolbar();
      return;
    }
    openSlotMenu(lassoSetOpSlot, lassoSetOpMenu);
  });
  // v0.7.8 魔棒算法组槽（原系统 <select> 退役，家规：不用系统控件）：
  //   classic=经典 flood / lineart=论文线稿分区（断口自动闭合+填到线下，flat-coloring-oracle）。
  //   选项从 MAGIC_ALGORITHMS SSoT 填；换算法首 tap 会同步建分区（2K 实测 <1s）。
  const lassoAlgoBtn = byId("lassoAlgoBtn");
  const lassoAlgoMenu = byId("lassoAlgoMenu");
  for (const a of MAGIC_ALGORITHMS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lasso-tool-btn";
    b.setAttribute("role", "menuitem");
    b.dataset.lassoAlgo = a.id;
    b.textContent = t(a.labelKey as Parameters<typeof t>[0]);
    lassoAlgoMenu.appendChild(b);
  }
  wireSlotMenu(lassoAlgoBtn, lassoAlgoMenu, (b) => {
    input.lasso.setMagicAlgorithm(b.dataset.lassoAlgo as Parameters<typeof input.lasso.setMagicAlgorithm>[0]);
    _selToolRec().algo = b.dataset.lassoAlgo!;   // v0.7.17 per-tool 持久化（user 授权）
  });
  // （v0.7.26：选区笔自有变体/笔径控件退役——配置全归笔架（rack key "selPen"），user：「别造轮子」。
  //   笔选择 = 二次点 lasso/fill 工具钮开笔架 / 左栏 dial 笔名钮；粗细 = 左栏 dial（pen 子工具时放行）。）
  // ---- 形状笔上下文工具栏（ADR-0005）：组槽 + 约束。状态 per-doc（desk.shapeBrush），UI 改 → 写
  //   desk + 灌引擎；换文档 wp:applyEditorState 回灌（对齐魔棒阈值样板）。
  //   画一半切子工具/约束 = cancel 不进 undo（user 拍板，同两指手势接管语义）。
  shapeToolbarStack = byId("shapeToolbarStack");
  shapeSubBtns = [...byId("shapeSubCtl").querySelectorAll<HTMLElement>("[data-shape-sub]")];
  shapeSubLineUse = byId("shapeSubLineUse") as unknown as SVGUseElement;
  shapeSubRectUse = byId("shapeSubRectUse") as unknown as SVGUseElement;
  shapeSubCircleUse = byId("shapeSubCircleUse") as unknown as SVGUseElement;
  shapeGridMenu = byId("shapeGridMenu");
  shapeVarMenus = { line: byId("shapeLineVarMenu"), rect: byId("shapeRectVarMenu"), circle: byId("shapeCircleVarMenu"), grid: shapeGridMenu };
  for (const m of Object.values(shapeVarMenus)) _transientMenus.push(m);
  // v0.6.25：已选中的子工具再点 = 开变体/配置菜单（grid=行列配置 steppers 连按不关——外点关统一挂这）
  for (const [s2, menu] of Object.entries(shapeVarMenus)) {
    if (s2 !== "grid") {
      for (const mb of [...menu.querySelectorAll<HTMLElement>("[data-shape-var]")]) {
        mb.addEventListener("click", () => {
          if (input.isStrokeActive()) input.abortActiveStroke();
          const v = mb.dataset.shapeVar === "constrain";
          input.shapeBrush.setConstrainFor(s2 as "line" | "rect" | "circle", v);
          desk.shapeBrush[CONSTRAIN_KEY[s2]] = v;
          menu.classList.add("hidden");
          updateShapeToolbar();
        });
      }
    }
    document.addEventListener("pointerdown", (e: Event) => {
      if (menu.classList.contains("hidden")) return;
      const anchor = shapeSubBtns.find((sb) => sb.dataset.shapeSub === s2);
      if (menu.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      menu.classList.add("hidden");
    });
  }
  // v0.6.31：单击=切换子工具；已选中再点=开变体/配置菜单（长按撤，回 v0.6.26 形态）
  for (const b of shapeSubBtns) {
    const sub2 = b.dataset.shapeSub as Parameters<typeof input.shapeBrush.setSubTool>[0];
    const menu2 = shapeVarMenus[sub2];
    b.addEventListener("click", (e: Event) => {
      if (input.isStrokeActive()) input.abortActiveStroke();
      if (input.shapeBrush.getSubTool() === sub2) {
        e.stopPropagation();
        if (menu2) {
          const wasHidden = menu2.classList.contains("hidden");
          menu2.classList.toggle("hidden");
          if (wasHidden) anchorPopupToBtn(menu2, b, { align: "left", offsetY: 6 });
        }
        return;
      }
      input.shapeBrush.setSubTool(sub2);
      desk.shapeBrush.sub = sub2;
      updateShapeToolbar();
    });
  }
  // （v0.6.25：1:1 约束 toggle 钮 shapeConstrainBtn 与 grid ⋯ 钮 shapeGridMoreBtn 退役——
  //   变体/配置收进各子工具小三角；Shift 临时反转不受影响）
  shapeGridNuVal = byId("shapeGridNuVal");
  shapeGridNvVal = byId("shapeGridNvVal");
  shapeGridBorderBtn = byId("shapeGridBorderBtn");
  const pushGridToEngine = () => {
    input.shapeBrush.setGridConfig({
      nu: desk.shapeBrush.gridNu, nv: desk.shapeBrush.gridNv,
      border: desk.shapeBrush.gridBorder,
    });
  };
  const stepGrid = (axis: "gridNu" | "gridNv", d: number) => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    desk.shapeBrush[axis] = Math.max(1, Math.min(24, desk.shapeBrush[axis] + d));
    pushGridToEngine();
    updateShapeToolbar();
  };
  byId("shapeGridNuMinus").addEventListener("click", () => stepGrid("gridNu", -1));
  byId("shapeGridNuPlus").addEventListener("click", () => stepGrid("gridNu", +1));
  byId("shapeGridNvMinus").addEventListener("click", () => stepGrid("gridNv", -1));
  byId("shapeGridNvPlus").addEventListener("click", () => stepGrid("gridNv", +1));
  shapeGridBorderBtn.addEventListener("click", () => {
    if (input.isStrokeActive()) input.abortActiveStroke();
    desk.shapeBrush.gridBorder = !desk.shapeBrush.gridBorder;
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
    const g = desk.persp;
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
      desk.persp.plane = b.dataset.shapePlane!;
      updateShapeToolbar();
    });
  }
  shapePerspShowBtn.addEventListener("click", () => {
    desk.persp.showGizmo = !desk.persp.showGizmo;
    updateShapeToolbar();
    board.requestRender();
  });
  input.shapeBrush.setPerspProvider(() => configFromModeState(desk.persp));
  const syncShapeFromEditorState = () => {
    input.shapeBrush.setSubTool(desk.shapeBrush.sub as Parameters<typeof input.shapeBrush.setSubTool>[0]);
    input.shapeBrush.setConstrainFor("line", desk.shapeBrush.constrainLine);
    input.shapeBrush.setConstrainFor("rect", desk.shapeBrush.constrainRect);
    input.shapeBrush.setConstrainFor("circle", desk.shapeBrush.constrainCircle);
    pushGridToEngine();
    updateShapeToolbar();
  };
  window.addEventListener("wp:applyEditorState", syncShapeFromEditorState);
  syncShapeFromEditorState();
  // v242：扩展滑块从魔术棒拆走（改成选区编辑 op，见 initSelEditUI）。魔术棒只剩阈值。
  // v0.5.11：阈值 per-doc 持久化（desk.magicWand.threshold，原 desk.bucket 退役后归魔棒）。
  //   UI 改 → 写 desk + 灌引擎；换文档 → syncMagicThresholdUI 回灌（wp:applyEditorState）。
  // v0.7.2：容差滑条从两份 ⋯ 菜单搬进扳手弹出（#lassoAlgoCfgMenu，选区/填充共用一份 DOM）
  //   ——fillThreshold 镜像退役。持久化不变（desk.magicWand.threshold，per-doc）。
  // v0.7.21：滑条外提 Row1 且**按当前算法路由**（classic↔threshold / similar↔similarThreshold，两容差
  //   分开存互不打架）；引擎两值+度量恒全量灌（换文档/换算法都不会漏）。显隐/换算法的值回灌在
  //   updateLassoToolbar（lassoTolWrap 块）派生。
  // v0.7.22：滑条本体 = ramp-slider 分段模式（user 拍板：分段步长表不走连续 sqrt/log——
  //   位置空间=档位索引，低端细高端粗、无死区、值恒整数；brush-size 同精神，段表见下）。
  const TOL_SEGMENTS = [{ upTo: 20, step: 1 }, { upTo: 40, step: 2 }, { upTo: 70, step: 5 }, { upTo: 100, step: 10 }];
  lassoTolSlider = makeRampSlider({
    label: "", ariaLabel: t("la.threshold"), min: 0, max: 100, step: 1, value: 20, segments: TOL_SEGMENTS,
    onInput: (v) => {
      if (input.lasso.getMagicAlgorithm() === "similar") {
        desk.magicWand.similarThreshold = v;
        input.lasso.setSimilarThreshold(v);
      } else {
        desk.magicWand.threshold = v;
        input.lasso.setMagicThreshold(v);
      }
    },
  });
  byId("lassoTolWrap").appendChild(lassoTolSlider.el);
  const syncMagicThresholdUI = () => {
    input.lasso.setMagicThreshold(desk.magicWand.threshold);
    input.lasso.setSimilarThreshold(desk.magicWand.similarThreshold);
    input.lasso.setColorMetric(desk.magicWand.metric === "rgb" ? "rgb" : "oklab");
    const sim = input.lasso.getMagicAlgorithm() === "similar";
    lassoTolSlider?.set(sim ? desk.magicWand.similarThreshold : desk.magicWand.threshold);
  };
  // v0.7.21 色差度量（扳手行，classic/similar 共用；统一默认 OKLab——user 2026-07-30 拍板）
  const setColorMetricUI = (m: "oklab" | "rgb") => {
    desk.magicWand.metric = m;
    input.lasso.setColorMetric(m);
    updateLassoToolbar();   // aria-pressed 派生（菜单不关：toggle 类连按友好，同蚂蚁线）
  };
  document.getElementById("lassoMetricOklab")?.addEventListener("click", () => setColorMetricUI("oklab"));
  document.getElementById("lassoMetricRgb")?.addEventListener("click", () => setColorMetricUI("rgb"));
  // #31 魔棒 flood 后自动扩张（v0.5.12 内联化：aria-pressed toggle 钮 + px 输入，⚙/popup 退役）。
  //   引擎只认一个数：effective px = toggle 开 ? px : 0。UI 改 → 写 desk + 灌引擎；换文档回灌。
  lassoExpandToggle = byId("lassoExpandToggle");
  lassoMagicExpandVal = byId("lassoMagicExpandVal");
  lassoMagicExpandMenu = byId("lassoMagicExpandMenu");
  const pushMagicExpandToEngine = () => {
    input.lasso.setMagicAutoExpand(desk.magicWand.expand ? desk.magicWand.expandPx : 0);
  };
  const syncMagicExpandUI = () => {
    lassoMagicExpandVal.textContent = String(desk.magicWand.expandPx);
    pushMagicExpandToEngine();
    updateLassoToolbar();   // toggle pressed 态/stepper 显隐在 updateLassoToolbar 派生
  };
  _transientMenus.push(lassoMagicExpandMenu);
  lassoExpandToggle.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    desk.magicWand.expand = !desk.magicWand.expand;
    pushMagicExpandToEngine();
    if (desk.magicWand.expand) {
      // 开的瞬间顺势弹 stepper 调 px（v0.6.26；外点关，steppers 连按不关）
      lassoMagicExpandMenu.classList.remove("hidden");
      anchorPopupToBtn(lassoMagicExpandMenu, lassoExpandToggle, { align: "left", offsetY: 6 });
    } else {
      lassoMagicExpandMenu.classList.add("hidden");
    }
    updateLassoToolbar();
  });
  document.addEventListener("pointerdown", (e: Event) => {
    if (lassoMagicExpandMenu.classList.contains("hidden")) return;
    if (lassoMagicExpandMenu.contains(e.target as Node) || lassoExpandToggle.contains(e.target as Node)) return;
    lassoMagicExpandMenu.classList.add("hidden");
  });
  // −1+ stepper（v0.6.19 文本框退役——文本框吞快捷键+弹键盘；样板 = shapeGrid steppers 连按不关菜单）
  const stepMagicExpand = (d: number) => {
    desk.magicWand.expandPx = Math.max(0, Math.min(100, desk.magicWand.expandPx + d));
    lassoMagicExpandVal.textContent = String(desk.magicWand.expandPx);
    pushMagicExpandToEngine();
  };
  byId("lassoMagicExpandMinus").addEventListener("click", () => stepMagicExpand(-1));
  byId("lassoMagicExpandPlus").addEventListener("click", () => stepMagicExpand(+1));
  // v0.7.24 容隙 toggle + px stepper（auto-expand 同款样板；user：两个不同的 knob）。
  //   引擎只认一个数：effective px = toggle 开 ? fillGapPx : 0。classic 专属（显隐在 updateLassoToolbar）。
  const lassoGapToggle = byId("lassoGapToggle");
  const lassoGapMenu = byId("lassoGapMenu");
  const lassoGapVal = byId("lassoGapVal");
  const pushGapToEngine = () => {
    input.lasso.setFillGap(desk.magicWand.fillGap ? desk.magicWand.fillGapPx : 0);
  };
  const syncGapUI = () => {
    lassoGapVal.textContent = String(desk.magicWand.fillGapPx);
    pushGapToEngine();
    updateLassoToolbar();
  };
  _transientMenus.push(lassoGapMenu);
  lassoGapToggle.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    desk.magicWand.fillGap = !desk.magicWand.fillGap;
    pushGapToEngine();
    if (desk.magicWand.fillGap) {
      lassoGapMenu.classList.remove("hidden");
      anchorPopupToBtn(lassoGapMenu, lassoGapToggle, { align: "left", offsetY: 6 });
    } else {
      lassoGapMenu.classList.add("hidden");
    }
    updateLassoToolbar();
  });
  document.addEventListener("pointerdown", (e: Event) => {
    if (lassoGapMenu.classList.contains("hidden")) return;
    if (lassoGapMenu.contains(e.target as Node) || lassoGapToggle.contains(e.target as Node)) return;
    lassoGapMenu.classList.add("hidden");
  });
  const stepGap = (d: number) => {
    desk.magicWand.fillGapPx = Math.max(2, Math.min(32, desk.magicWand.fillGapPx + d));
    lassoGapVal.textContent = String(desk.magicWand.fillGapPx);
    pushGapToEngine();
  };
  byId("lassoGapMinus").addEventListener("click", () => stepGap(-1));
  byId("lassoGapPlus").addEventListener("click", () => stepGap(+1));
  window.addEventListener("wp:applyEditorState", syncGapUI);
  window.addEventListener("wp:applyEditorState", syncMagicExpandUI);
  window.addEventListener("wp:applyEditorState", syncMagicThresholdUI);
  syncMagicThresholdUI();
  syncMagicExpandUI();
  syncGapUI();
  // 1:1 约束 toggle（rect / ellipse 用）
  lassoConstrainBtn.addEventListener("click", () => {
    const v = !input.lasso.getConstrainSquare();
    input.lasso.setConstrainSquare(v);
    _selToolRec().constrainSquare = v;   // v0.6.24 per-tool 持久化
    updateLassoToolbar();
  });
  // v0.6.24：换文档回灌当前选区工具的记录（现有 applyEditorState 监听只派生 UI 不灌引擎——补缺口）
  window.addEventListener("wp:applyEditorState", () => {
    const m = editMode.current();
    if (m === "lasso" || m === "fill") { _pushSelToolToEngine(m); updateLassoToolbar(); }
  });
  initSelEditUI();   // v242 选区编辑（扩张/收缩）齿轮 + 菜单 + 实时预览 modal

  // 选区动作：变换。v217/218：没选区时让 lasso 用整层做隐式全选（fallbackFullLayer）。
  // selection 状态全归 lasso 管，toolbar 不直接动 doc.selection。
  byId("lassoTransformBtn").addEventListener("click", () => {
    if (editMode.current() !== "lasso") {
      // v0.6.24：T 键在 fill 下不再静默——给状态行说法（按钮本身隐藏，键走 click 代理）
      if (editMode.current() === "fill") setStatus(t("fm.noTransform"), true);
      return;
    }
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
  // v0.7.37 复位（user：「reset scale + rot + align to center」）：一个 undo 整点，同 flip/rotate 节奏
  byId("lassoResetTransformBtn").addEventListener("click", () => {
    input.lasso.resetFloatTransform();
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
    // v2（T2）：令牌 + collector 写时扣押（no-op 清除 = 零换手 = 不占 undo 步——v0.6.17 同族）。
    const token = wp2.begin("clearSel");
    (doc.selection as Selection).clearOnLayer(layer as unknown as Parameters<Selection["clearOnLayer"]>[0]);
    token.commit();
    board.invalidateAll();
    setStatus(t("se.clearedSelection"));
  });
  // v112: 全选（user：「lasso 加全选」）
  // v0.6.30：⋯ 动作共享处理器（两份菜单 data-sel-act 委托；快捷键仍 click 老 id，冒泡进委托）
  const SEL_ACTIONS: Record<string, () => void> = {
    selectAll: () => {
      const sel = Selection.full(doc.width, doc.height);
      pushSel(input.lasso.setSelection(sel));
      board.invalidateAll();
      updateLassoToolbar();
      closeSelEditUI();   // 指令项点完关菜单（toggle/slider 类不关）
    },
    invert: () => {
      const inv = doc.selection ? (doc.selection as Selection).invert(doc.width, doc.height) : Selection.full(doc.width, doc.height);
      pushSel(input.lasso.setSelection(inv));
      board.invalidateAll();
      updateLassoToolbar();
      closeSelEditUI();
    },
    resize: () => _openSelEdit("expand"),   // v0.5.15 合一入口，默认扩张
    dup: () => { selectionToNewLayer({ move: false }); closeSelEditUI(); },
    move: () => { selectionToNewLayer({ move: true }); closeSelEditUI(); },
    // v0.7.38 从当前图层 alpha 建选区（替换语义，user 拍板；组/隐藏层硬拒、空层给提示）
    fromLayer: () => {
      const layer = requireEditableLeaf(doc, setStatus);
      if (!layer) { closeSelEditUI(); return; }
      const sel = Selection.fromLayerAlpha(layer as unknown as Parameters<typeof Selection.fromLayerAlpha>[0]);
      if (!sel) { setStatus(t("la.fromLayerEmpty")); closeSelEditUI(); return; }
      pushSel(input.lasso.setSelection(sel));
      board.invalidateAll();
      updateLassoToolbar();
      closeSelEditUI();
    },
    // v0.7.38 送选区进填色（ADR-0004 修订 5 的 one-shot 携入；needs-sel 禁用兜底）
    toFill: () => { sendSelectionToFill(); closeSelEditUI(); },
    // v0.9.22 剪贴板正宫化（spec 20260819）：⋯ 菜单露出——逻辑全在 selection-ops（window 事件）。
    // 都不带 needs-sel：无选区时 copy/cut=整层、copyMerged=整张合成图、paste 恒可用。
    copy: () => { window.dispatchEvent(new CustomEvent("wp:copy")); closeSelEditUI(); },
    cut: () => { window.dispatchEvent(new CustomEvent("wp:cut")); closeSelEditUI(); },
    copyMerged: () => { window.dispatchEvent(new CustomEvent("wp:copyMerged")); closeSelEditUI(); },
    paste: () => { window.dispatchEvent(new CustomEvent("wp:paste")); closeSelEditUI(); },
  };
  for (const id of ["lassoSelEditMenu", "fillSelEditMenu"]) {
    document.getElementById(id)?.addEventListener("click", (e: Event) => {
      const b = (e.target as HTMLElement).closest?.("[data-sel-act]") as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      SEL_ACTIONS[b.dataset.selAct!]?.();
    });
  }
  // v0.7.39 Row1 同槽互斥双钮（全选/反选提出 ⋯ 菜单）；快捷键 Ctrl+A / Ctrl+Shift+I 走 .click()
  //   老惯例（input.ts），hidden 态 .click() 仍触发 → 显隐不影响快捷键
  byId("lassoRow1SelectAllBtn").addEventListener("click", () => SEL_ACTIONS.selectAll());
  byId("lassoRow1InvertBtn").addEventListener("click", () => SEL_ACTIONS.invert());
  // v0.9.22 合并复制 Row1 常驻钮（human 拍板：合并复制加按钮；兼作 Ctrl+Shift+C 被浏览器吞时的兜底）
  byId("lassoCopyMergedBtn").addEventListener("click", () => SEL_ACTIONS.copyMerged());

  // 反选：在 docW×docH 上 mask 取反


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
  fillResampleSelect(lassoSampleSel, "transform", "bicubic", tLatin as (key: string) => string);   // v0.6.45 默认双三次（真机裁决，spline 降自选）
  fillResampleSelect(els.resampleMode, "scale", "bicubic", tLatin as (key: string) => string);
  if (lassoSampleSel) {
    lassoSampleSel.addEventListener("change", () => {
      input.lasso.setSampleMode(lassoSampleSel.value);
      board.invalidateAll();
      updateLassoToolbar();
    });
  }
  // 吸色取样模式 dropdown（composite 合并 / layer 当前图层 raw）。
  //   持久化 = desk.colorPicker.layerMode（per-doc desk，进 .weebpaint/editor-state.json）——**不是 LS**，
  //   v406 起设备级 webpaint.pickMode 已删。input._doPick 经 getPickMode 读（走 bindEditorReactive 的桥）。
  pickerToolbar = document.getElementById("pickerToolbar");
  pickModeSel = document.getElementById("pickModeSel") as HTMLSelectElement | null;
  if (pickModeSel) {
    const psel = pickModeSel;
    psel.value = desk.colorPicker.layerMode;   // binding → state.pickMode（引擎 input._doPick 经 getPickMode 读）
    psel.addEventListener("change", () => { desk.colorPicker.layerMode = psel.value; });
    // desk 载入：文档的 pickMode 回灌 → 刷新下拉显示（desk 已由 Unserialize 更新，只同步 UI，不回写）
    window.addEventListener("wp:applyEditorState", () => { psel.value = desk.colorPicker.layerMode; });
  }
  // 选区 → 新层 / 复制层

  window.addEventListener("wp:lassochange", updateLassoToolbar);
  // 任何 history push/undo/redo 都可能改 doc.selection → 刷新 toolbar 显隐
  window.addEventListener("wp:histchange", updateLassoToolbar);

  // ---- EditMode → UI 派生 ----
  window.addEventListener("wp:modechange", _syncEditModeUI);
  _syncEditModeUI();   // 初始同步（boot setTool 同工具会 early-return 不 emit，这里兜一次）

  // ---- 工具按钮 ----
  // v0.6.31 回滚：四工具并列，单击=切换。长按/Alt/右键/组菜单全撤（真机难受）。
  // v0.6.55（user 2026-07-30）：恢复「二次点弹笔架」（v79 语义回归）——已激活的画笔/橡皮/形状笔
  //   再点 = toggle 该工具的笔架（openExclusive 自带 toggle）；无笔架的工具（lasso/fill）二次点仍无事。
  for (const b of els.toolBtns) {
    b.addEventListener("click", () => {
      const tool = b.dataset.tool!;   // .tool[data-tool] 选择器保证存在
      if (editMode.current() === tool) {
        // v0.7.28：lasso/fill 二次点不开笔架（context-unaware 别扭，user 回滚）——选区笔笔架
        //   走 pen 子模式旁挂的 #selPenRackBtn；映射保留在 RACK_PANEL_BY_TOOL 只为 panel 注册。
        if (tool === "lasso" || tool === "fill") return;
        const rackId = RACK_PANEL_BY_TOOL[tool];
        if (rackId) openExclusive(rackId);
        return;
      }
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
