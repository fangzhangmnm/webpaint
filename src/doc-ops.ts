// 职责（单一）：文档级变换 op —— 裁切（裁到选区 / 自由 8-handle）、水平翻转、重采样（调整尺寸）。
// 共同脊柱 runDocTransform（T3b-2 换 v2 形）：一个 compound 令牌 = 一个整点。
//   - flip/rot90/offset 走 LayerTiles computed verbs（省内存可逆变换白名单）；
//   - crop/cropResample/resample 走 LayerTiles.resizeAllLeaves（exchange record；undo 包 = 另一侧实例）；
//   - json 尺寸走 layerTree.setTreeProp("width"/"height")（树 record 同 step 翻转）；
//   - 选区走 SelectionComponent（pre-applied 直写组件 verb——T4a）；
//   - 透视 remap 走 PerspComponent.remapForDocTransform（token 记账，undo 同 step 还原——T4d，
//     persp 信封退役）；
//   - viewport 还原走 **step.hint**（提案 .h：docTransform 是 hint 的唯一住户，T4d 后只剩视口）。
// 守卫（无选区/尺寸非法/没变化）留调用方。crop/resample 是 EditMode transient（enter/apply/cancel 走 editMode）。

import { els } from "./els.ts";
import { bumpDoc } from "./signals.ts";
import { t } from "./i18n/index.ts";
import { resizeCropRect, resizeCropRectAspect, fitRectToBBox, cropRectToInts } from "./crop-geometry.ts";
import { loadCanvasTemplates, fillTemplateSelect, templatePx, templateById } from "./canvas-templates.ts";
import { desk } from "./workbench-state.ts";
import { LayerPixels } from "./tiles/tile-layer.ts";
import { resampleBytes } from "./backend/algorithms/resample-bytes.ts";
import type { Selection } from "./selection.ts";
import type { AppContext } from "./app-context.ts";

interface Rect { x: number; y: number; w: number; h: number; }
interface CropState { rect: Rect; drag: string | null; startMouse: { x: number; y: number } | null; startRect: Rect | null; mode: "free" | "template"; tpl: { tw: number; th: number; aspect: number; dpi?: number } | null; resample: boolean; }
interface TransientOpts { apply?: () => void; abort?: () => void; }

// ctx 绑入：core 单例。doc = PaintingView 端口（读面 + 选区过渡宿）。
let editMode: AppContext["editMode"], doc: AppContext["doc"], board: AppContext["board"], history: AppContext["history"], setStatus: AppContext["setStatus"];
let wp2: AppContext["wp2"];
// 命令 = 拥有它的模块的接口（显式 import，不经 ctx）
import { setMenuOpen } from "./settings-menu.ts";
import { setAdjustOpen } from "./filters-adjust.ts";
import { reportError } from "./error-badge.ts";
// ctx 绑入：仍在 app.js 的编排件（app-local function）
let _suppressTransientPanels: AppContext["_suppressTransientPanels"], _restoreTransientPanels: AppContext["_restoreTransientPanels"];

// ===== 文档变换脊柱（v2）=====
interface UiSnap { viewport: Record<string, number> }
function _captureUi(): UiSnap {
  return { viewport: { ...board.viewport } };
}
// undo/redo 的 UI 随行还原（step.hint 消费）：视口 + 尺寸标签 + 重绘（T4d：透视归组件 record）。
function _applyUi(u: UiSnap): void {
  Object.assign(board.viewport, u.viewport);
  if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
  board.invalidateAll();
}

interface DocTransformSpec {
  /** 新 doc 尺寸（缺省 = 不变）。 */
  newW?: number; newH?: number;
  /** resize 形：逐叶产新实例（旧实例进 exchange record undo 包）。 */
  mapLeaf?: (lp: LayerPixels) => LayerPixels;
  /** computed 形：LayerTiles 白名单 verb（flip/rot90/offsetWrap）。 */
  applyComputed?: () => void;
  /** 选区映射（缺省 = 保留原选区；返回 null = 清选区）。 */
  mapSelection?: (sel: Selection) => Selection | null;
  /** persp remap（走 wp2.persp 组件记账）/ viewport shift / fitToScreen（在 after UI 快照之前跑）。 */
  after?: () => void;
}

// 结构上保证不漏 undo 事务：整个变换在一个 withPoint 令牌里，undo 包 = 各组件 collector record
// （tiles exchange/树/选区/persp）；fn 中途抛 → token.cancel 全量回滚（含已换实例/已换选区）。
function runDocTransform(label: string, tf: DocTransformSpec): void {
  editMode.applyPendingTransient();
  const ui: { before: UiSnap; after: UiSnap | null } = { before: _captureUi(), after: null };
  const res = history.withPoint("docTransform", { hint: (dir) => _applyUi(dir === "undo" ? ui.before : ui.after!) }, () => {
    if (tf.mapLeaf) {
      // T5：实例交换记账收进 LayerTiles.resizeAllLeaves（exchange record；map 期间挂起收集的
      //   纪律也在 verb 内——旧 DocResizeOp/挂起舞蹈退役）。undo 包 = 另一侧实例，同 step 与树账同向翻。
      wp2.layerTiles.resizeAllLeaves((_id, lp) => tf.mapLeaf!(lp));
    }
    tf.applyComputed?.();
    const tree = wp2.layerTree!;
    if (tf.newW !== undefined && tf.newW !== doc.width) tree.setTreeProp("width", tf.newW);
    if (tf.newH !== undefined && tf.newH !== doc.height) tree.setTreeProp("height", tf.newH);
    const oldSel = doc.selection;
    if (oldSel) {
      const mapped = tf.mapSelection ? tf.mapSelection(oldSel) : oldSel;
      if (mapped !== oldSel) {
        doc.selection = mapped;   // pre-applied：before 所有权交 SelectionComponent record（T4a）
        wp2.selection.commitPreApplied(oldSel);   // compound 令牌已开——直写组件 verb
      }
    }
    tf.after?.();
    ui.after = _captureUi();
  });
  if (!res.ok) { reportError(new Error(`[docTransform] ${label} 失败（已回滚）：${res.msg ?? "?"}`), "error"); return; }
  if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
  board.invalidateAll();
  bumpDoc();
  setStatus(label);
}

// v114: 裁切后让原 (rect.x, rect.y) 像素在屏上不挪 → viewport.tx/ty 减去 (rect.x, rect.y) × scale
// 数学：old 屏位 = old_tx + rect.x × scale；new 屏位 = new_tx + 0 × scale = new_tx
// 要等 → new_tx = old_tx + rect.x × scale
function _shiftViewportAfterCrop(rect: { x: number; y: number }) {
  const v = board.viewport;
  v.tx = v.tx + rect.x * v.scale;
  v.ty = v.ty + rect.y * v.scale;
}

// 自由裁切（8-handle）----
let _cropState: CropState | null = null;     // { rect:{x,y,w,h} in doc, drag:'nw'|'n'|'ne'|...|'move'|null, startMouse, startRect }
function _docRectToScreen(r: Rect) {
  const { tx, ty, scale } = board.viewport;
  return { x: r.x * scale + tx, y: r.y * scale + ty, w: r.w * scale, h: r.h * scale };
}
function _renderCropOverlay() {
  if (!_cropState) return;
  const r = _docRectToScreen(_cropState.rect);
  const el = document.getElementById("cropRect")!;
  el.style.left = r.x + "px";
  el.style.top  = r.y + "px";
  el.style.width  = Math.max(2, r.w) + "px";
  el.style.height = Math.max(2, r.h) + "px";
  // L69：实时显示裁切后分辨率（doc 像素，非屏幕）；模板模式且 resample 开 = 「框 → 目标」两段；
  //   resample 关（v0.6.64 默认）= 模板只是比例参考、输出保原分辨率 → 只显框的原生尺寸（同自由模式）
  const dim = document.getElementById("cropDim");
  const tpl = _cropState.tpl;
  if (dim) dim.textContent = (tpl && _cropState.resample)
    ? `${Math.round(_cropState.rect.w)} × ${Math.round(_cropState.rect.h)} → ${tpl.tw} × ${tpl.th}`
    : `${Math.round(_cropState.rect.w)} × ${Math.round(_cropState.rect.h)}`;
  // 安全线：均匀绝对边距 = 2% 短边（borderless overspray 是物理均匀量——按轴百分比会长边出更多，user 指正）
  const safety = document.getElementById("cropSafety") as HTMLElement | null;
  if (safety && !safety.classList.contains("hidden")) {
    const inset = Math.max(2, 0.02 * Math.min(r.w, r.h));
    safety.style.inset = `${inset}px`;
  }
}

// ---- v0.6.48 裁剪·定尺寸模式（设计定稿 ai-docs/20260729-crop-template-mode.md；fit 基准=原画布，v0.6.51 user 纠正）----
// 模板控件显隐 + 目标换算 + 框吸到 contain-fit。tplId="custom" 读 wh 输入框。
function _applyCropTemplate(tplId: string) {
  if (!_cropState) return;
  let tw = 0, th = 0;
  if (tplId === "custom") {
    tw = parseInt((document.getElementById("cropCustomW") as HTMLInputElement).value, 10) | 0;
    th = parseInt((document.getElementById("cropCustomH") as HTMLInputElement).value, 10) | 0;
    if (tw < 1 || th < 1) { _cropState.tpl = null; _syncCropModeUI(); return; }   // 未填完 → 暂不锁
  } else {
    const t = templateById(tplId);
    if (!t) return;
    const px = templatePx(t);
    tw = px.w; th = px.h;
    desk.crop.templateId = tplId;   // desk 便利记忆（无 DPI 语义）
  }
  _cropState.tpl = { tw, th, aspect: tw / th, dpi: tplId === "custom" ? undefined : templateById(tplId)?.dpi };
  // 初始框 = 画布矩形的 cover（框⊆画布、居中、比例锁死——不跳出画布，可预期；fit 按钮才按内容 bbox）
  _cropState.rect = fitRectToBBox({ x: 0, y: 0, w: doc.width, h: doc.height }, tw / th, "cover");
  _syncCropModeUI();
  _renderCropOverlay();
}
// 按 _cropState.tpl 有无同步 toolbar 控件 + 安全线 + Apply 文案。
function _syncCropModeUI() {
  const tpl = _cropState?.tpl ?? null;
  const isT = _cropState?.mode === "template";
  document.getElementById("cropModeFree")!.setAttribute("aria-pressed", String(!isT));
  document.getElementById("cropModeTemplate")!.setAttribute("aria-pressed", String(isT));
  const show = (id: string, on: boolean) => document.getElementById(id)!.classList.toggle("hidden", !on);
  show("cropTemplateSel", isT);
  const isCustom = isT && (document.getElementById("cropTemplateSel") as HTMLSelectElement).value === "custom";
  show("cropCustomW", isCustom); show("cropCustomH", isCustom); show("cropCustomX", isCustom);
  show("cropFitCover", isT); show("cropFitContain", isT);
  // v0.6.64 resample toggle（模板模式专属，默认关）
  show("cropResampleToggle", isT);
  document.getElementById("cropResampleToggle")!.setAttribute("aria-pressed", String(!!_cropState?.resample));
  show("cropSafety", !!tpl);
  // apply/cancel 已图标化（#check/#x，v0.6.52）——文案在 title；别写 textContent（会抹掉 svg）
  document.getElementById("cropRect")!.classList.add("tpl-move");   // v0.6.63：两模式框内均可整体平移（v125 只 handle 语义废止）
}
function _openCropMode() {
  // v154 (user)：自由裁切要求 rot=0（裁切框是屏幕轴对齐 DOM，doc 旋转会错位）。
  //   以前弹提示让用户手动按 0；改成自动复位旋转（保 zoom/位置，只归零 rot），直接进。
  if (board.viewport.rot && Math.abs(board.viewport.rot) > 0.01) {
    board.setViewport(board.viewport.tx, board.viewport.ty, board.viewport.scale, 0);
    setStatus(t("tm.rotationResetForCrop"));
  }
  _cropState = {
    rect: { x: 0, y: 0, w: doc.width, h: doc.height },
    drag: null, startMouse: null, startRect: null,
    mode: "free",
    tpl: null,   // 模板模式：{tw,th,aspect,dpi?}；null=自由（或自定义未填完）
    resample: false,   // v0.6.64（user）：默认关——模板只作比例参考；开才重采样到目标分辨率
  };
  _syncCropModeUI();
  document.getElementById("cropOverlay")!.classList.remove("hidden");
  document.getElementById("cropToolbar")!.classList.remove("hidden");
  _renderCropOverlay();
  _suppressTransientPanels("crop");
  // crop transient：apply/abort 都 = 丢弃裁切框（真裁只走 Apply 按钮）。决定性动作/ctrl-z 不会误裁。
  (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("crop", { apply: _closeCropMode, abort: _closeCropMode });
}
function _closeCropMode() {
  _cropState = null;
  document.getElementById("cropOverlay")!.classList.add("hidden");
  document.getElementById("cropToolbar")!.classList.add("hidden");
  _restoreTransientPanels();
  editMode.exitTransient();   // sync 点：任何关闭路径（按钮/decisive）都清 EditMode 的 transient
}

export function _updateMenuCropLabel() {
  const lbl = document.getElementById("menuCropLabel");
  if (!lbl) return;
  lbl.textContent = doc.selection ? t("menu.cropToSelection") : t("menu.cropFree");
}

// 重采样对话框 ----
function _openResampleDialog() {
  els.resampleBackdrop.classList.remove("hidden");
  els.resampleSheet.classList.remove("hidden");
  els.resampleW.value = String(doc.width);
  els.resampleH.value = String(doc.height);
  els.resampleW.focus();
  // 锁比例：变 W 自动改 H
  const aspect = doc.width / doc.height;
  const onW = () => {
    if (!els.resampleLock.checked) return;
    const w = parseFloat(els.resampleW.value) | 0;
    if (w > 0) els.resampleH.value = String(Math.max(1, Math.round(w / aspect)));
  };
  const onH = () => {
    if (!els.resampleLock.checked) return;
    const h = parseFloat(els.resampleH.value) | 0;
    if (h > 0) els.resampleW.value = String(Math.max(1, Math.round(h * aspect)));
  };
  els.resampleW.oninput = onW;
  els.resampleH.oninput = onH;
}
function _closeResampleDialog() {
  els.resampleBackdrop.classList.add("hidden");
  els.resampleSheet.classList.add("hidden");
}

// 偏移接缝（环绕）对话框 ----
// 默认预填半幅（dx=W/2, dy=H/2）：seamless 贴图最常用的「把四边接缝汇到中央」一步。
function _openOffsetDialog() {
  els.offsetBackdrop.classList.remove("hidden");
  els.offsetSheet.classList.remove("hidden");
  els.offsetX.value = String(Math.round(doc.width / 2));
  els.offsetY.value = String(Math.round(doc.height / 2));
  els.offsetX.focus();
  els.offsetHalf.onclick = () => {
    els.offsetX.value = String(Math.round(doc.width / 2));
    els.offsetY.value = String(Math.round(doc.height / 2));
  };
}
function _closeOffsetDialog() {
  els.offsetBackdrop.classList.add("hidden");
  els.offsetSheet.classList.add("hidden");
}

export function initDocOps(ctx: AppContext) {
  ({ editMode, doc, board, history, setStatus, wp2,
     _suppressTransientPanels, _restoreTransientPanels } = ctx);

  // 裁到选区 ----
  document.getElementById("adjustCropToSelection")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    if (!doc.selection) { setStatus(t("tm.noSelectionDrawLasso"), true); return; }
    const s = doc.selection;
    const x = Math.max(0, s.bboxX | 0), y = Math.max(0, s.bboxY | 0);
    const w = Math.min(doc.width - x, s.bboxW | 0), h = Math.min(doc.height - y, s.bboxH | 0);
    if (w < 1 || h < 1) { setStatus(t("tm.selectionTooSmall"), true); return; }
    runDocTransform(t("tm.croppedToSelection", { w, h }), {
      newW: w, newH: h,
      mapLeaf: (lp) => lp.cropped(x, y, w, h),
      mapSelection: (sel) => sel.croppedTo(x, y, w, h),
      after: () => {
        wp2.persp.remapForDocTransform((p) => ({ x: p.x - x, y: p.y - y }));   // ADR-0006：VP 随裁剪平移
        _shiftViewportAfterCrop({ x, y });
      },
    });
  });

  // crop 时画布 pan/zoom（两指 / 滚轮）→ rect SSoT 是 doc 坐标，重投影到屏幕跟随 viewport
  board.onViewportChange = () => { if (_cropState) _renderCropOverlay(); };

  document.getElementById("adjustCropFree")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    _openCropMode();
  });

  // v124 合并裁切入口：有选区 → 裁到选区；无选区 → 自由裁切。label 在 setMenuOpen(true) 时动态切
  const _menuCropBtn = document.getElementById("menuCrop");
  if (_menuCropBtn) {
    _menuCropBtn.addEventListener("click", () => {
      if (doc.selection) (document.getElementById("adjustCropToSelection") as HTMLElement).click();
      else                (document.getElementById("adjustCropFree") as HTMLElement).click();
    });
  }

  // 水平翻转整个画布（所有层 + 选区）。一次 docTransform op，可撤销。
  const _menuFlipHBtn = document.getElementById("menuFlipH");
  if (_menuFlipHBtn) {
    _menuFlipHBtn.addEventListener("click", () => {
      if (editMode.hasPendingTransient()) editMode.applyPendingTransient();   // v0.5.38 决定性动作=apply 悬浮 transient
      setMenuOpen(false);
      setAdjustOpen(false);
      const W = doc.width;
      runDocTransform(t("tm.flippedHorizontal"), {
        applyComputed: () => wp2.layerTiles.flipHorizontalAll(),
        mapSelection: (sel) => sel.flippedHorizontal(W),
        after: () => wp2.persp.remapForDocTransform((p) => ({ x: W - p.x, y: p.y })),   // ADR-0006：像素中线 W−(i+.5)=(W−i−1)+.5 仍在格上
      });
    });
  }

  // 逆时针旋转画布 90°（所有层 + 选区）。doc 尺寸 W↔H 互换 → 必须重设视口（否则内容飞出屏幕）。
  // 选最简单正确方案：旋转后 fitToScreen() 重新居中铺满（rot 复位为 0）；它在 applyFn 内执行，
  // after 快照含新视口，undo 还原旧视口 → 往返正确。
  const _menuRotate90Btn = document.getElementById("menuRotate90");
  if (_menuRotate90Btn) {
    _menuRotate90Btn.addEventListener("click", () => {
      if (editMode.hasPendingTransient()) editMode.applyPendingTransient();   // v0.5.38 决定性动作=apply 悬浮 transient
      setMenuOpen(false);
      setAdjustOpen(false);
      const W = doc.width, H = doc.height;
      runDocTransform(t("tm.rotated90CCW"), {
        applyComputed: () => wp2.layerTiles.rotate90All(1),
        newW: H, newH: W,
        mapSelection: (sel) => sel.rotated90CCW(W, H),
        after: () => {
          // ADR-0006：VP 随转（(x,y)→(y, W−x)，同 doc 像素映射）；VP 对的地平线转成竖直 →
          //   自动解锁 lockHorizon（锁的语义 = doc 水平线，转后无法表示；下次 VP 编辑可重锁）。
          wp2.persp.remapForDocTransform((p) => ({ x: p.y, y: W - p.x }), { unlockHorizon: true });
          board.fitToScreen();
        },
      });
    });
  }

  document.getElementById("cropToolbarCancel")!.addEventListener("click", () => _closeCropMode());
  document.getElementById("cropToolbarApply")!.addEventListener("click", () => {
    if (!_cropState) return;
    const tpl = _cropState.tpl;
    // v0.6.64：resample 关（默认）→ 模板只是比例参考，走普通裁切保原分辨率（下方自由路径）
    if (tpl && _cropState.resample) {
      // v0.6.49 模板模式：裁剪+重采样原子 op（保层）。frame 保浮点（比例精确）；
      //   VP 随裁缩重映射（ADR-0006 同款）；尺寸剧变 → fitToScreen。
      const fr = { ..._cropState.rect };
      const sx = tpl.tw / fr.w, sy = tpl.th / fr.h;
      const tw = tpl.tw, th = tpl.th;
      // 裁剪+重采样原子变换（v0.6.48 语义原样；逐叶只处理 frame∩内容框子矩形，保 tile 稀疏性）。
      const fx = fr.x, fy = fr.y, fw = Math.max(1, fr.w), fh = Math.max(1, fr.h);
      runDocTransform(t("crop.templated", { w: tw, h: th }), {
        newW: tw, newH: th,
        mapLeaf: (lp) => {
          const np = new LayerPixels(tw, th);
          const b = lp.contentBounds(true);
          if (!b) return np;
          const ix0 = Math.max(fx, b.x), iy0 = Math.max(fy, b.y);
          const ix1 = Math.min(fx + fw, b.x + b.w), iy1 = Math.min(fy + fh, b.y + b.h);
          const iw = Math.ceil(ix1 - ix0), ih = Math.ceil(iy1 - iy0);
          if (iw <= 0 || ih <= 0) return np;
          const srcBytes = lp.getRegion(Math.floor(ix0), Math.floor(iy0), iw, ih);
          const nbx = Math.floor((ix0 - fx) * sx), nby = Math.floor((iy0 - fy) * sy);
          const nbw = Math.max(1, Math.min(tw - nbx, Math.round(iw * sx)));
          const nbh = Math.max(1, Math.min(th - nby, Math.round(ih * sy)));
          np.putRegion(nbx, nby, nbw, nbh, resampleBytes(srcBytes, iw, ih, nbw, nbh, "auto"));
          return np;
        },
        mapSelection: (sel) => {
          const cropped = sel.croppedTo(Math.round(fx), Math.round(fy), Math.round(fw), Math.round(fh));
          if (!cropped) return null;
          const out = cropped.resampledTo(sx, sy);
          if (cropped !== sel && cropped !== out) cropped.dispose();   // 中间产物即弃（sel 本体归 op）
          return out;
        },
        after: () => {
          wp2.persp.remapForDocTransform((p) => ({ x: (p.x - fx) * sx, y: (p.y - fy) * sy }));
          board.fitToScreen();
        },
      });
      _closeCropMode();
      return;
    }
    // v127 (user：「裁切还可以扩张」)：允许 x/y 负（向左/向上扩），允许 w/h > doc（向右/向下扩）
    //   只保最小 1 + 最大 8192；doc.cropTo 已支持负 dx/dy
    const { x, y, w, h } = cropRectToInts(_cropState.rect, { min: 1, max: 8192 });
    runDocTransform(t("tm.cropped", { w, h }), {
      newW: w, newH: h,
      mapLeaf: (lp) => lp.cropped(x, y, w, h),
      mapSelection: (sel) => sel.croppedTo(x, y, w, h),
      after: () => {
        wp2.persp.remapForDocTransform((p) => ({ x: p.x - x, y: p.y - y }));   // ADR-0006：VP 随裁剪平移（含负向扩张）
        _shiftViewportAfterCrop({ x, y });
      },
    });
    _closeCropMode();
  });

  // ---- v0.6.49 模板模式控件（v0.6.48 首版的接线块因文本替换静默漏落——本次补上）----
  {
    const tplSel = document.getElementById("cropTemplateSel") as HTMLSelectElement;
    // 模板下拉：SSoT = canvas-templates.json（v0.7.32 起和新建作品共用同一份表 + 同一个投影函数；
    // 此前两边各有一张表，往新建里加的尺寸这里永远看不到）。async fetch，回来了再填。
    // 先同步投影一次：模板模式按钮会把 value 设成 "custom"，那条 option 必须先在（否则赋值落空、
    // _syncCropModeUI 会误判成非自定义、把 W/H 输入框藏起来）。json 回来再投影一次补上模板。
    fillTemplateSelect(tplSel, t("crop.customTpl"));
    void loadCanvasTemplates().then(() => fillTemplateSelect(tplSel, t("crop.customTpl")));
    // 分段按钮 自由|模板（两项下拉太笨——user 2026-07-29 UI 意见）
    document.getElementById("cropModeFree")!.addEventListener("click", () => {
      if (!_cropState || _cropState.mode === "free") return;
      _cropState.mode = "free";
      _cropState.tpl = null;
      _syncCropModeUI();
      _renderCropOverlay();
    });
    document.getElementById("cropModeTemplate")!.addEventListener("click", () => {
      if (!_cropState || _cropState.mode === "template") return;
      _cropState.mode = "template";
      // 默认=自定义、预填当前画布尺寸（user 拍板）→ 初始比例=画布比例、框=整画布，零跳变。
      tplSel.value = "custom";
      (document.getElementById("cropCustomW") as HTMLInputElement).value = String(doc.width);
      (document.getElementById("cropCustomH") as HTMLInputElement).value = String(doc.height);
      _applyCropTemplate("custom");
    });
    tplSel.addEventListener("change", () => _applyCropTemplate(tplSel.value));
    const onCustom = () => { if (tplSel.value === "custom") _applyCropTemplate("custom"); };
    (document.getElementById("cropCustomW") as HTMLInputElement).addEventListener("input", onCustom);
    (document.getElementById("cropCustomH") as HTMLInputElement).addEventListener("input", onCustom);
    // fit 基准 = **原画布**（user 2026-07-29 纠正——不是内容 bbox）。命名对齐 Windows 壁纸模式：
    //   填充(Fill)=框⊆画布盖满无留白（画布出框部分裁掉）；适应(Fit)=画布⊆框全装进（四周留白）。
    const canvasRect = () => ({ x: 0, y: 0, w: doc.width, h: doc.height });
    document.getElementById("cropFitCover")!.addEventListener("click", () => {
      if (!_cropState?.tpl) return;
      _cropState.rect = fitRectToBBox(canvasRect(), _cropState.tpl.aspect, "cover");
      _renderCropOverlay();
    });
    document.getElementById("cropFitContain")!.addEventListener("click", () => {
      if (!_cropState?.tpl) return;
      _cropState.rect = fitRectToBBox(canvasRect(), _cropState.tpl.aspect, "contain");
      _renderCropOverlay();
    });
    // v0.6.64 resample toggle（user）：关=比例参考保原分辨率；开=裁后重采样到目标
    document.getElementById("cropResampleToggle")!.addEventListener("click", () => {
      if (!_cropState) return;
      _cropState.resample = !_cropState.resample;
      _syncCropModeUI();
      _renderCropOverlay();   // 分辨率提示随 toggle 换算
    });
  }

  // 裁切 overlay 拖拽 (handle / rect 内 = move)
  (function bindCropOverlayPointer() {
    const overlay = document.getElementById("cropOverlay")!;
    overlay.addEventListener("pointerdown", (e: PointerEvent) => {
      if (!_cropState) return;
      e.preventDefault();
      e.stopPropagation();
      // v125「只有拖 handle 才行」→ v0.6.50 模板模式框内=move → v0.6.63（user）自由模式跟进：
      //   两模式统一，rect 内部拖 = 整体平移（rect 外的 overlay 空白仍 no-op）。
      let handle = (e.target as HTMLElement | null)?.dataset?.handle || null;
      if (!handle) {
        const tid = (e.target as HTMLElement | null)?.id;
        if (tid === "cropRect" || tid === "cropDim") handle = "move";
        else return;
      }
      // 捕获在 handle 上（overlay 现在 pointer-events:none，捕在它身上不稳）。pointerup 自动释放。
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
      _cropState.drag = handle;
      _cropState.startMouse = { x: e.clientX, y: e.clientY };
      _cropState.startRect = { ...(_cropState.rect) };
    });
    overlay.addEventListener("pointermove", (e: PointerEvent) => {
      if (!_cropState || !_cropState.drag) return;
      const dx_screen = e.clientX - _cropState.startMouse!.x;
      const dy_screen = e.clientY - _cropState.startMouse!.y;
      const scale = board.viewport.scale;
      const dx = dx_screen / scale;
      const dy = dy_screen / scale;
      // 8-handle resize 几何（含「缩到下限对边不动」+ v127 向外扩张）抽到 crop-geometry.js
      // 模板模式：锁比版（v0.6.48）
      _cropState.rect = _cropState.tpl
        ? resizeCropRectAspect(_cropState.drag, _cropState.startRect!, dx, dy, _cropState.tpl.aspect, { min: 4, max: 8192 })
        : resizeCropRect(_cropState.drag, _cropState.startRect!, dx, dy, { min: 4, max: 8192 });
      _renderCropOverlay();
    });
    overlay.addEventListener("pointerup", (e: PointerEvent) => {
      if (!_cropState) return;
      try { overlay.releasePointerCapture(e.pointerId); } catch {}
      _cropState.drag = null;
    });
    overlay.addEventListener("pointercancel", (e: PointerEvent) => {
      if (!_cropState) return;
      try { overlay.releasePointerCapture(e.pointerId); } catch {}
      _cropState.drag = null;
    });
  })();

  // 重采样 ----
  document.getElementById("adjustResample")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    editMode.applyPendingTransient();   // 决定性命令：先 commit 掉浮动变换/调色，再改 doc 尺寸（否则浮层错位+undo 不一致）
    _openResampleDialog();
  });
  els.resampleCancel.addEventListener("click", () => _closeResampleDialog());
  els.resampleBackdrop.addEventListener("click", () => _closeResampleDialog());
  els.resampleConfirm.addEventListener("click", () => {
    const nw = parseFloat(els.resampleW.value) | 0;
    const nh = parseFloat(els.resampleH.value) | 0;
    const mode = els.resampleMode.value || "bicubic";
    if (nw < 1 || nh < 1 || nw > 8192 || nh > 8192) { setStatus(t("tm.sizeOutOfRange"), true); return; }
    if (nw === doc.width && nh === doc.height) { _closeResampleDialog(); return; }
    const sx = nw / doc.width, sy = nh / doc.height;
    runDocTransform(t("tm.resampled", { w: nw, h: nh, mode }), {
      newW: nw, newH: nh,
      // v0.6.46 字节管线原样：逐叶 getRegion → resample-bytes → 直落新 tile，零 premult 往返。
      mapLeaf: (lp) => {
        const np = new LayerPixels(nw, nh);
        const b = lp.contentBounds(true);
        if (!b) return np;
        const srcBytes = lp.getRegion(b.x, b.y, b.w, b.h);
        const nbw = Math.max(1, Math.round(b.w * sx));
        const nbh = Math.max(1, Math.round(b.h * sy));
        np.putRegion(Math.round(b.x * sx), Math.round(b.y * sy), nbw, nbh, resampleBytes(srcBytes, b.w, b.h, nbw, nbh, mode));
        return np;
      },
      mapSelection: (sel) => sel.resampledTo(sx, sy),
      after: () => {
        // ADR-0006 §7 补漏：resample 从未过 remapShapePersp（改画布尺寸后透视静默错位）。
        //   缩放破 +0.5 格系 → 重钉像素中线（水平地平线仍水平，lockHorizon 不动）。
        const c = (v: number) => Math.floor(v) + 0.5;
        wp2.persp.remapForDocTransform((p) => ({ x: c(p.x * sx), y: c(p.y * sy) }));
      },
    });
    _closeResampleDialog();
  });

  // 偏移接缝（环绕）---- doc 尺寸不变（像 flipH），无需 viewport shift。
  document.getElementById("menuOffset")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    editMode.applyPendingTransient();   // 决定性命令：先 commit 浮动变换/调色再改像素
    _openOffsetDialog();
  });
  els.offsetCancel.addEventListener("click", () => _closeOffsetDialog());
  els.offsetBackdrop.addEventListener("click", () => _closeOffsetDialog());
  els.offsetConfirm.addEventListener("click", () => {
    const dx = parseFloat(els.offsetX.value) | 0;
    const dy = parseFloat(els.offsetY.value) | 0;
    // 归一化到 [0,W)/[0,H) 判 no-op（偏移整幅 = 不动）。doc.offsetWrap 内也会再兜一次。
    const ox = ((dx % doc.width) + doc.width) % doc.width;
    const oy = ((dy % doc.height) + doc.height) % doc.height;
    if (ox === 0 && oy === 0) { _closeOffsetDialog(); return; }
    const W = doc.width, H = doc.height;
    runDocTransform(t("tm.offset", { dx, dy }), {
      applyComputed: () => wp2.layerTiles.offsetWrapAll(dx, dy),
      mapSelection: (sel) => sel.offsetWrapped(ox, oy, W, H),
      after: () => wp2.persp.remapForDocTransform((p) => ({ x: p.x + ox, y: p.y + oy })),   // ADR-0006：VP 平移不 wrap（VP 本可在画布外）
    });
    _closeOffsetDialog();
  });
}
