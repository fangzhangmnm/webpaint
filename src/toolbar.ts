// 职责（单一）：工具选择 + EditMode→UI 派生 + 套索/选区工具栏。
// 即「选当前工具、把按钮高亮/可点从 EditMode 派生、lasso 子工具/集合运算/变换/选区动作工具栏」。
// drawing app 只经 editMode（持久工具 + transient）这一个轴跟工具耦合：
//   setTool → editMode.setTool → emit wp:modechange → _syncEditModeUI 重新派生整套 UI。
// ctx 绑：editMode/state/doc/board/input/history/dialReactive/rack/setStatus/leftDial,
//        + app-local（仍在 app.js，经 ctx 绑）：_suppressTransientPanels/_restoreTransientPanels/
//          _commitTransform/_cancelTransform/selectionToNewLayer/layerSpecFrom/afterDocChange。
// importable：Selection（选区取反/全选）、compressPixelSnap（fill/clear undo 快照压缩）、
//             fillResampleSelect（变换采样 dropdown SSoT）。

import { els } from "./els.ts";
import { PANELS, openExclusive, closeExclusive } from "./panel-state.js";
import { Selection } from "./selection.js";
import { compressPixelSnap } from "./pixel-edit.js";
import { requireEditableLeaf } from "./editable-leaf.js";
import { safeLSSet } from "./safe-ls.ts";
import { fillResampleSelect } from "./resample.js";

let editMode: any, state: any, doc: any, board: any, input: any, history: any,
    dialReactive: any, rack: any, setStatus: any, leftDial: any,
    _suppressTransientPanels: any,
    _commitTransform: any, _cancelTransform: any, selectionToNewLayer: any;

// 套索工具栏 DOM（initToolbar 里查表，故置为 module-level let）
let lassoToolbarStack: any, lassoToolbarRow1: any, lassoToolbarRow2: any,
    lassoSubToolBar: any, lassoSelectionActions: any, lassoTransformCtrl: any,
    lassoSubBtns: any, lassoSetOpBtns: any, lassoTransformModeBtns: any,
    lassoThresholdInput: any, lassoThresholdVal: any, lassoMagicCfgBtn: any,
    lassoMagicPopup: any, lassoConstrainBtn: any, lassoConstrainSep: any,
    lassoSelEditBtn: any,   // v242 选区编辑齿轮（有选区才亮；扩张/收缩 op）
    pickerToolbar: any, pickModeSel: any;   // 吸色 context toolbar（取样模式：合并 / 当前图层）

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
  const lassoActive = editMode.current() === "lasso";
  const showAny = (floating || hasSelection || lassoActive) && !pickerActive;
  lassoToolbarStack.classList.toggle("hidden", !showAny);
  if (!showAny) return;

  // 其他工具模式下有选区：选区只是个蒙板，工具栏只给一个"取消选区"（否则去选还得切回 lasso）。
  const otherToolSel = hasSelection && !floating && !lassoActive;
  // Row 1：lasso 模式给全套；其他工具+有选区只露 deselect（加 class，CSS 藏其余）。floating 时都不给。
  const showRow1 = (lassoActive && !floating) || otherToolSel;
  lassoToolbarRow1.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("lasso-deselect-only", otherToolSel);

  // Row 2：selectionActions（变换/填色/清除/复制/移层）只在 lasso 模式给；其他工具模式不给。floating 显 transformCtrl。
  // v217：没选区时也露 row2（至少有变换按钮）——点变换自动全选当前层。
  const showSelectionActions = !floating && lassoActive;
  const showTransformCtrl = floating;
  const showRow2 = showSelectionActions || showTransformCtrl;
  lassoToolbarRow2.classList.toggle("hidden", !showRow2);
  lassoSelectionActions.classList.toggle("hidden", !showSelectionActions);
  // 没选区时只露"变换"（隐式全选），其余 .lasso-needs-sel 靠此 class 隐藏
  lassoSelectionActions.classList.toggle("transform-only", !hasSelection);
  lassoTransformCtrl.classList.toggle("hidden", !showTransformCtrl);

  // 高亮当前 sub-tool / set-op / transform mode
  const sub = input.lasso.getSubTool();
  for (const b of lassoSubBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSub === sub ? "true" : "false");
  }
  lassoMagicCfgBtn.classList.toggle("hidden", sub !== "magic");
  // 子工具切走 → 关掉魔术棒 popup（油漆桶按工具栏没装；按 ⚙ 仅在 magic 下出）
  if (sub !== "magic") lassoMagicPopup.classList.add("hidden");
  // v242 选区编辑齿轮：有选区 + lasso 模式 + 非 floating 才亮（扩张/收缩对任何来源的选区都能用）。
  //   modal 开着时(_selEdit)恒亮——预览 shrink 到空会让 doc.selection=null，不能因此把 modal 撕掉。
  const showSelEdit = !!_selEdit || (hasSelection && showRow1 && !otherToolSel);
  lassoSelEditBtn.classList.toggle("hidden", !showSelEdit);
  if (!showSelEdit) closeSelEditUI();   // 选区没了 / 切走 → 收起齿轮菜单（此时 _selEdit 必为 null）
  // 1:1 约束按钮：仅 rect / ellipse 子工具下显示
  const showConstrain = sub === "rect" || sub === "ellipse";
  lassoConstrainBtn.classList.toggle("hidden", !showConstrain);
  lassoConstrainSep.classList.toggle("hidden", !showConstrain);
  if (showConstrain) {
    lassoConstrainBtn.setAttribute("aria-pressed", input.lasso.getConstrainSquare() ? "true" : "false");
  }
  const setOp = input.lasso.getSetOpMode();
  for (const b of lassoSetOpBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSetop === setOp ? "true" : "false");
  }
  if (floating) {
    const mode = input.lasso.getMode();
    for (const b of lassoTransformModeBtns) {
      b.setAttribute("aria-pressed", b.dataset.lassoMode === mode ? "true" : "false");
    }
    const sm = input.lasso.getSampleMode();
    const sel = document.getElementById("lassoSampleSel") as any;
    if (sel && sel.value !== sm) sel.value = sm;
  }
}

// ---- 工具 ----
export function setTool(t: string) {
  // v96：airbrush 工具不存在了。老 doc 持久化里可能存了 "airbrush" → 透明回退到 brush
  if (t === "airbrush") t = "brush";
  // v120：shapes 撤了。老 doc 持久化里可能存了 "shapes" → 透明回退 brush
  if (t === "shapes") t = "brush";
  // v110：smudge engine 未真实装（user：「smudge 和 shapes 灰色先不响应」）
  if (t === "smudge") {
    setStatus("涂抹 工具暂未启用");
    return;
  }
  // 切工具 = 决定性动作 → editMode.setTool 内部按 onToolSwitch 把停驻 transient apply/cancel（不在这单独调）
  // v132: 切到非 filterBrush 工具时自动退出 filter brush 模式（藏 toolbar / 清 state）
  if (state.filterBrush && t !== "filterBrush") {
    state.filterBrush = null;
    const tb = document.getElementById("filterBrushToolbar");
    if (tb) tb.classList.add("hidden");
  }
  editMode.setTool(t);   // emit wp:modechange → _syncEditModeUI 派生按钮高亮 / lasso 工具栏
  document.body.dataset.tool = t;   // 持久工具的 CSS hook（transient 期间保持不变）
  // 切工具 → 应用该工具的 per-tool state（size/flow/activeBrushId）+ preset 冻结字段
  if (t === "brush" || t === "smudge" || t === "eraser" || t === "filterBrush") {
    rack.applyToolState(t);
  }
  if (t === "smudge") {
    setStatus("smudge engine 待实装；现在按 brush 走");
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
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", (!transient && b.dataset.tool === m) ? "true" : "false");
  // 液化 / filterBrush 没独立 data-tool 按钮，用 adjust 按钮高亮（transient 期间也不亮）
  els.topAdjustBtn?.setAttribute("aria-pressed", (m === "liquify" || m === "filterBrush") ? "true" : "false");
  // 注：body.dataset.tool 保持"持久工具"（在 setTool 里设），不在这改成 transient 名——避免扰乱
  // 依赖 body[data-tool] 的 CSS（且 data-mode 被图库占用）。transient 的 UI 抑制走面板 suppress + 按钮高亮。
  // slider 禁用：size/opacity 仅 canDraw 模式可调 → 反应式镜像，<LeftDial> 绑 :disabled。color 仅 allowsColor 可点。
  dialReactive.canDraw = editMode.canDraw();
  if (els.activeSwatch) (els.activeSwatch as any).disabled = !editMode.allowsColor();
  updateLassoToolbar();             // 选区/变换工具栏跟着重新派生
}

// ===== v242 选区编辑 op：扩张 / 收缩（走 adjust transient + 实时预览）=====
// 齿轮 → 菜单(扩张/收缩) → modal：数字输入，蚂蚁线随输入实时变；应用/取消。
//   预览 = 直接改 doc.selection（不 push history）；应用 = push 一条 selectionChange(before→after)；
//   取消 / ctrl-z / 切工具 = 还原 before。硬边（Selection.morphed），不羽化——羽化是以后的事。
// 设计照搬 filters-adjust 的 transient 生命周期（enterTransient("adjust") + 统一 exit 同步点）。
let _selEdit: any = null;   // { before, op:'expand'|'shrink', rafId } —— 仅 modal 开着时非 null

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
  doc.selection = s.before.morphed(signed, doc.width, doc.height);
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
function _openSelEdit(op: "expand" | "shrink") {
  if (!doc.selection) return;
  const { menu, popup, title, amount } = _selEditEls();
  menu?.classList.add("hidden");
  if (_selEdit) _finishSelEdit(false);    // 已开着另一个 → 先取消旧的（还原）再开新的
  _selEdit = { before: doc.selection, op, rafId: 0 };
  if (title) title.textContent = op === "expand" ? "扩张选区" : "收缩选区";
  if (amount) amount.value = "1";         // 默认 1px（最常用的轻微扩缩）
  popup?.classList.remove("hidden");
  _runSelEditPreview();                    // 初次预览
  // adjust transient：apply=采纳预览，abort=还原。切工具/ctrl-z 都经此（onToolSwitch=apply）。
  editMode.enterTransient("adjust", { apply: () => _finishSelEdit(true), abort: () => _finishSelEdit(false) });
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
    if (after !== before && history) history.push({ type: "selectionChange", before, after });
    setStatus(s.op === "expand" ? "选区已扩张" : "选区已收缩");
  } else {
    doc.selection = s.before;               // 还原
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
  lassoSelEditBtn.addEventListener("click", (e: any) => {
    e.stopPropagation();
    if (_selEdit) return;                   // modal 开着时齿轮不响应
    menu?.classList.toggle("hidden");
  });
  document.getElementById("lassoSelExpandBtn")?.addEventListener("click", () => _openSelEdit("expand"));
  document.getElementById("lassoSelShrinkBtn")?.addEventListener("click", () => _openSelEdit("shrink"));
  amount?.addEventListener("input", _onSelEditInput);
  amount?.addEventListener("keydown", (e: any) => {
    if (e.key === "Enter") { e.preventDefault(); _finishSelEdit(true); }
  });
  document.getElementById("lassoSelOpApply")?.addEventListener("click", () => _finishSelEdit(true));
  document.getElementById("lassoSelOpCancel")?.addEventListener("click", () => _finishSelEdit(false));
  // 点菜单外侧 → 关菜单（modal 自有 apply/cancel，不在此关）
  document.addEventListener("pointerdown", (e: any) => {
    if (!menu || menu.classList.contains("hidden")) return;
    if (menu.contains(e.target) || lassoSelEditBtn.contains(e.target)) return;
    menu.classList.add("hidden");
  });
}

// Rack 工具 → 对应的 exclusive panel id
export const RACK_PANEL_BY_TOOL: Record<string, any> = {
  brush: PANELS.RACK_BRUSH,
  smudge: PANELS.RACK_SMUDGE,
  eraser: PANELS.RACK_ERASER,
  filterBrush: PANELS.RACK_FILTER_BRUSH,    // v132
};
let _lastNonLassoTool = "brush";

export function initToolbar(ctx) {
  ({
    editMode, state, doc, board, input, history, dialReactive, rack, setStatus, leftDial,
    _suppressTransientPanels, _commitTransform, _cancelTransform,
    selectionToNewLayer,
  } = ctx);

  // ---- 套索/选区工具栏 DOM ----
  // 两行 toolbar stack（v93）：row1 = 选区方式，row2 = 操作 / 变换
  lassoToolbarStack = document.getElementById("lassoToolbarStack");
  lassoToolbarRow1 = document.getElementById("lassoToolbarRow1");
  lassoToolbarRow2 = document.getElementById("lassoToolbarRow2");
  lassoSubToolBar = document.getElementById("lassoSubToolBar");
  lassoSelectionActions = document.getElementById("lassoSelectionActions");
  lassoTransformCtrl = document.getElementById("lassoTransformCtrl");
  lassoSubBtns = [...(lassoSubToolBar as any).querySelectorAll("[data-lasso-sub]")];
  lassoSetOpBtns = [...(lassoSubToolBar as any).querySelectorAll("[data-lasso-setop]")];
  lassoTransformModeBtns = [...(lassoTransformCtrl as any).querySelectorAll("[data-lasso-mode]")];
  lassoThresholdInput = document.getElementById("lassoThreshold");
  lassoThresholdVal = document.getElementById("lassoThresholdVal");
  lassoMagicCfgBtn = document.getElementById("lassoMagicCfgBtn");
  lassoMagicPopup = document.getElementById("lassoMagicPopup");
  lassoConstrainBtn = document.getElementById("lassoConstrainBtn");
  lassoConstrainSep = document.querySelector(".lasso-constrain-sep");
  lassoSelEditBtn = document.getElementById("lassoSelEditBtn");

  // sub-tool picker
  for (const b of lassoSubBtns) {
    b.addEventListener("click", () => {
      input.lasso.setSubTool(b.dataset.lassoSub);
      updateLassoToolbar();
    });
  }
  // set-op modifier
  for (const b of lassoSetOpBtns) {
    b.addEventListener("click", () => {
      input.lasso.setSetOpMode(b.dataset.lassoSetop);
      updateLassoToolbar();
    });
  }
  // v242：扩展滑块从魔术棒拆走（改成选区编辑 op，见 initSelEditUI）。魔术棒只剩阈值。
  (lassoThresholdInput as any).addEventListener("input", () => {
    const v = parseInt((lassoThresholdInput as any).value, 10) || 0;
    input.lasso.setMagicThreshold(v);
    (lassoThresholdVal as any).textContent = String(v);
  });
  // 设置按钮 → popup toggle
  function toggleMagicPopup(e: any) {
    e.stopPropagation();
    (lassoMagicPopup as any).classList.toggle("hidden");
  }
  (lassoMagicCfgBtn as any).addEventListener("click", toggleMagicPopup);
  // 点 popup 外侧 → 关
  document.addEventListener("pointerdown", (e: any) => {
    if ((lassoMagicPopup as any).classList.contains("hidden")) return;
    if ((lassoMagicPopup as any).contains(e.target)) return;
    if ((lassoMagicCfgBtn as any).contains(e.target)) return;
    (lassoMagicPopup as any).classList.add("hidden");
  });
  // 1:1 约束 toggle（rect / ellipse 用）
  (lassoConstrainBtn as any).addEventListener("click", () => {
    input.lasso.setConstrainSquare(!input.lasso.getConstrainSquare());
    updateLassoToolbar();
  });
  initSelEditUI();   // v242 选区编辑（扩张/收缩）齿轮 + 菜单 + 实时预览 modal

  // 选区动作：变换。v217/218：没选区时让 lasso 用整层做隐式全选（fallbackFullLayer）。
  // selection 状态全归 lasso 管，toolbar 不直接动 doc.selection。
  (document.getElementById("lassoTransformBtn") as any).addEventListener("click", () => {
    if (!doc.activeLayer) return;
    const ok = input.lasso.liftSelectionForTransform(doc.activeLayer, { fallbackFullLayer: true });
    if (ok) {
      editMode.enterTransient("transform", { apply: _commitTransform, abort: _cancelTransform });
      updateLassoToolbar();
      _suppressTransientPanels("transform");
    } else if (doc.selection) {
      // v232 (user)：选区里没有可变换的像素（全透明 / 与图层无交集 / 小于 2×2）→ 不进变换，
      // 顺手清掉这个没用的选区，别让它卡在那。
      const entry = input.lasso.setSelection(null);
      if (entry && history) history.push(entry);
      board.invalidateAll();
      updateLassoToolbar();
      setStatus("选区里没有可变换的像素，已取消选区");
    } else {
      setStatus("图层是空的，没东西可变换");
    }
  });

  (document.getElementById("lassoDeselectBtn") as any).addEventListener("click", () => {
    const entry = input.lasso.setSelection(null);
    if (entry && history) history.push(entry);
    board.invalidateAll();
    updateLassoToolbar();
  });
  // 填色：选区内填当前颜色（push stroke-type entry，可 Ctrl+Z）
  (document.getElementById("lassoFillBtn") as any).addEventListener("click", () => {
    const layer = requireEditableLeaf(doc, setStatus);
    if (!layer || !doc.selection) return;
    const before = layer.snapshot();
    doc.selection.fillOnLayer(layer, state.color);
    const after = layer.snapshot();
    const entry: any = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
    history.push(entry);
    compressPixelSnap(entry.before, (blob: any) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob: any) => { entry.afterBlob  = blob; });
    board.invalidateAll();
    setStatus(`已填色：${state.color}`);
  });
  // 清除：选区内 dst-out
  (document.getElementById("lassoClearBtn") as any).addEventListener("click", () => {
    const layer = requireEditableLeaf(doc, setStatus);
    if (!layer || !doc.selection) return;
    const before = layer.snapshot();
    doc.selection.clearOnLayer(layer);
    const after = layer.snapshot();
    const entry: any = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
    history.push(entry);
    compressPixelSnap(entry.before, (blob: any) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob: any) => { entry.afterBlob  = blob; });
    board.invalidateAll();
    setStatus("已清除选区内像素");
  });
  // v112: 全选（user：「lasso 加全选」）
  (document.getElementById("lassoSelectAllBtn") as any).addEventListener("click", () => {
    const sel = Selection.full(doc.width, doc.height);
    const entry = input.lasso.setSelection(sel);
    if (entry && history) history.push(entry);
    board.invalidateAll();
    updateLassoToolbar();
  });

  // 反选：在 docW×docH 上 mask 取反
  (document.getElementById("lassoInvertBtn") as any).addEventListener("click", () => {
    const inv = doc.selection ? doc.selection.invert(doc.width, doc.height) : Selection.full(doc.width, doc.height);
    const entry = input.lasso.setSelection(inv);
    if (entry && history) history.push(entry);
    board.invalidateAll();
    updateLassoToolbar();
  });

  // transform 模式 picker + 应用 / 取消
  for (const b of lassoTransformModeBtns) {
    b.addEventListener("click", () => {
      input.lasso.setMode(b.dataset.lassoMode);
      updateLassoToolbar();
    });
  }
  // commit/cancel 按钮 = 薄壳，走 EditMode → 运行 transform transient 的 apply/abort 闭包（_commit/_cancelTransform）
  (document.getElementById("lassoCommitBtn") as any).addEventListener("click", () => {
    editMode.applyPendingTransient();
  });
  (document.getElementById("lassoCancelBtn") as any).addEventListener("click", () => {
    editMode.abortTransient();
  });
  // Stamp：写入图层但保留 float（连击多次叠加盖印）
  (document.getElementById("lassoStampBtn") as any).addEventListener("click", () => {
    if (!input.lasso.hasFloating()) return;
    if (input.lasso.stamp()) {
      board.invalidateAll();
      setStatus("已盖印");
    }
  });
  // v120: 插值模式 dropdown（旧 3 个按钮 → 1 个 select）
  const lassoSampleSel = document.getElementById("lassoSampleSel") as any;
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
  // 吸色取样模式 dropdown（composite 合并 / layer 当前图层 raw）。持久化到 LS；input._doPick 经 getPickMode 读。
  pickerToolbar = document.getElementById("pickerToolbar");
  pickModeSel = document.getElementById("pickModeSel");
  if (pickModeSel) {
    pickModeSel.value = state.pickMode;
    pickModeSel.addEventListener("change", () => {
      state.pickMode = pickModeSel.value;
      safeLSSet("webpaint.pickMode", pickModeSel.value);
    });
  }
  // 选区 → 新层 / 复制层
  (document.getElementById("lassoDuplicateBtn") as any).addEventListener("click", () => {
    selectionToNewLayer({ move: false });
  });
  (document.getElementById("lassoMoveToLayerBtn") as any).addEventListener("click", () => {
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
      const t = b.dataset.tool;
      // tap-active-again：已激活的 rack 工具再点 → 开/关该工具的笔架 sheet
      // 详 conversation v79→v80：「tap = 切换 / 已激活 tap = 开 rack」
      if (editMode.current() === t && RACK_PANEL_BY_TOOL[t]) {
        openExclusive(RACK_PANEL_BY_TOOL[t]);
        return;
      }
      // v124 (user) 第二次按 lasso = Esc 语义：清选区 + 回上一个非 lasso 工具
      if (editMode.current() === "lasso" && t === "lasso") {
        if (doc.selection) {
          const entry = input.lasso.setSelection(null);
          if (entry) history.push(entry);
          board.invalidateAll();
        }
        setTool(_lastNonLassoTool || "brush");
        closeExclusive();
        return;
      }
      if (editMode.current() !== "lasso") _lastNonLassoTool = editMode.current();
      setTool(t);
      // 切到新 tool 时关掉之前开的 rack（防止 stale）
      closeExclusive();
    });
  }
  window.addEventListener("wp:settool", (e: any) => setTool(e.detail));

  // v120 删：Shapes 子工具栏。shapes tool 撤了 → 以后 shapes 改 brush preset 的 toggle 字段
  // pencil 模式下双击 → 笔↔橡皮。但 floating 选区存在时屏蔽（避免误触切工具 = 自动 apply 变换）
  window.addEventListener("wp:doubletap", () => {
    if (input.lasso.hasFloating()) {
      setStatus("套索浮层进行中，双击切换暂停（点应用 / 取消 / 返回工具栏）");
      return;
    }
    const next = editMode.current() === "eraser" ? "brush" : "eraser";
    setTool(next);
    setStatus(`双击 · ${next === "eraser" ? "橡皮" : "笔刷"}`);
  });
  setTool(editMode.current());
}
