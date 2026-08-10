// 职责（单一）：「按颜色拆分图层」sheet 编排（图层 ⋯ 菜单 → 选 k → 预览中心色/占比 →
//   拆分 or 取消）。聚类/分片数学全在 color-cluster.ts（纯字节，零 canvas）；树变更 =
//   doc.explodeLayerToLayers（collapseGroupToLayer 的逆向）；撤销 = treeStructure 快照
//   （原叶活引用进 before，一步 undo 整体还原）。
//
// 预览是**采样估计**（≤5 万样本，毫秒级，k 拖动即时重算）；commit 才对 bbox 全像素做
//   最终硬分配，占比按全分辨率重数、全空簇丢弃——所以落地层数可能 < k（sheet 里如实说明）。

import { clusterColors, partitionByNearest, hexOf, type ColorCluster } from "./backend/algorithms/color-cluster.ts";
import { colorNameIn, defaultCulture, namingCategories, categoryLabel } from "./color-name.ts";
import { wireInlineSelect } from "./inline-select.ts";
import { makeRampSlider, type RampSliderHandle } from "./ui/ramp-slider.ts";
import { countViewLeaves, type ViewLeaf } from "./workpiece/painting-view.ts";
import { t } from "./i18n/index.ts";
import type { AppContext } from "./app-context.ts";

let ctx: AppContext;

const byId = (id: string) => document.getElementById(id) as HTMLElement;
// 色名 culture（≠ localization，user 2026-07-30：二次元场景中国传统色远优于 western）。
// 词库清单/显示名全部来自 color-words.json 的 category 元数据（加词库零改码）；
// session 内记住上次选择、**不缓存默认值**（词库是异步 asset，数据到位前 defaultCulture
// 只会兜底 xkcd——别把兜底烧死成用户选择）；不持久化（进 desk/store 需另获 user 同意）。
let _culture: string | null = null;
function culture(): string { return _culture ?? defaultCulture(); }

const el = {
  backdrop: () => byId("explodeBackdrop"),
  sheet: () => byId("explodeSheet"),
  kRow: () => byId("explodeKRow"),
  swatches: () => byId("explodeSwatches"),
  msg: () => byId("explodeMsg"),
  confirm: () => byId("explodeConfirm") as HTMLButtonElement,
  cancel: () => byId("explodeCancel") as HTMLButtonElement,
  cultureLabel: () => byId("explodeCultureBtnLabel"),
};

// sheet 打开期间的瞬态（关闭即清，region 可达 16MB 级别，勿滞留）。
let _state: {
  layerId: number;
  rect: { ox: number; oy: number; w: number; h: number };
  region: Uint8ClampedArray;
  clusters: ColorCluster[];
} | null = null;
// k 滑杆（ramp-slider 深模块，家族 best practice——原生 range 退役）。max 随图层余量变 →
// 每次开 sheet 重建；k 值 session 内记住。
let _kSlider: RampSliderHandle | null = null;
let _k = 4;

function _close() {
  el.backdrop().classList.add("hidden");
  el.sheet().classList.add("hidden");
  document.removeEventListener("keydown", _onKey);
  _state = null;   // 释放 region 引用
  _kSlider?.dispose();
  _kSlider = null;
  el.kRow().innerHTML = "";
}

function _onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); _close(); }
}

// 重算聚类 + 渲染 swatch 行（chip 底色 = 中心色，标签 = 采样占比；title = hex）。
function _recompute() {
  if (!_state) return;
  _state.clusters = clusterColors(_state.region, _k);
  const box = el.swatches();
  box.innerHTML = "";
  for (const c of _state.clusters) {
    const chip = document.createElement("span");
    chip.className = "explode-swatch";
    chip.title = hexOf(c.center);
    const i = document.createElement("i");
    i.style.background = hexOf(c.center);
    const em = document.createElement("em");
    em.textContent = `${Math.max(1, Math.round(c.share * 100))}%`;
    const nm = document.createElement("span");
    nm.className = "explode-swatch-name";
    nm.textContent = colorNameIn(culture(), ...c.center);
    chip.append(i, em, nm);
    box.appendChild(chip);
  }
  el.confirm().disabled = _state.clusters.length < 2;
}

// 入口（图层 ⋯ 菜单）。守卫：叶、有像素、还有 ≥1 个空位（k≥2 → 净增 ≥1 叶）。
export function openExplodeSheet(L: ViewLeaf | null) {
  if (!L || L.isGroup) return;
  if (L.bboxW <= 0 || L.bboxH <= 0) { ctx.setStatus(t("ex.empty")); return; }
  const room = ctx.doc.maxLayers - countViewLeaves(ctx.doc.layers) + 1;   // 原叶让位后可放的分片数
  if (room < 2) { ctx.setStatus(t("ex.tooMany", { n: ctx.doc.maxLayers })); return; }
  const rect = { ox: L.bboxX, oy: L.bboxY, w: L.bboxW, h: L.bboxH };
  const region = L.pixels.getRegion(rect.ox, rect.oy, rect.w, rect.h);
  _state = { layerId: L.id, rect, region, clusters: [] };
  const kMax = Math.min(8, room);
  _k = Math.max(2, Math.min(_k, kMax));
  _kSlider?.dispose();
  el.kRow().innerHTML = "";
  _kSlider = makeRampSlider({
    label: t("ex.k"), min: 2, max: kMax, step: 1, value: _k,
    onInput: (v) => { _k = v; _recompute(); },
  });
  el.kRow().appendChild(_kSlider.el);
  el.msg().classList.add("hidden");
  el.cultureLabel().textContent = categoryLabel(culture());
  el.backdrop().classList.remove("hidden");
  el.sheet().classList.remove("hidden");
  document.addEventListener("keydown", _onKey);
  _recompute();
}

function _commit() {
  if (!_state || _state.clusters.length < 2) return;
  const { doc, layers, board, setStatus, afterDocChange } = ctx;
  const L = doc.findLayer(_state.layerId);
  if (!L || L.isGroup) { _close(); return; }
  // 全分辨率硬分配（预览是采样估计；这里才是定案）。空簇丢弃 → 实际层数可能 < k。
  const centers = _state.clusters.map((c) => c.center);
  const { parts, counts } = partitionByNearest(_state.region, centers);
  // 命名 = 颜色名本身，无前缀后缀（user 2026-07-30：面板窄，前缀只会挤掉信息量）；
  //   按选中 culture 烘焙成死字符串；两簇同名（tok 尤其）→ 加序号。
  const kept: { data: Uint8ClampedArray; name: string }[] = [];
  const used = new Map<string, number>();
  for (let c = 0; c < parts.length; c++) {
    if (counts[c] === 0) continue;
    const cn = colorNameIn(culture(), ...centers[c]);
    const n = (used.get(cn) ?? 0) + 1;
    used.set(cn, n);
    kept.push({ data: parts[c], name: n > 1 ? `${cn} ${n}` : cn });
  }
  if (kept.length < 2) { setStatus(t("ex.empty")); _close(); return; }
  kept.reverse();   // clusters 按占比降序 → 反转后大簇在 parts[0] = 同级最底
  // T3b-2：结构变更走 ctx.layers.explodeLayer（v2 verb；失败=层数超限）。
  const rect = _state.rect;
  const r = layers.explodeLayer(L.id, kept, { x: rect.ox, y: rect.oy, w: rect.w, h: rect.h }, {
    undoStatus: t("lp.st.unexploded", { name: L.name }),
    redoStatus: t("lp.st.exploded", { name: L.name, k: kept.length }),
  });
  if (!r.ok) { setStatus(t("ex.tooMany", { n: doc.maxLayers })); _close(); return; }
  _close();
  afterDocChange();
  board.invalidateAll();
  setStatus(t("lp.st.exploded", { name: L.name, k: kept.length }));
}

export function initExplodeSheet(c: AppContext) {
  ctx = c;
  // 词库下拉：家规 in-app 控件（不用系统 <select>）；条目开时现建 → 数据晚到也能拿到全清单。
  wireInlineSelect("explodeCultureBtn", "explodeCultureMenu",
    () => namingCategories().map((c) => ({ value: c.id, label: c.label })),
    () => culture(),
    (v) => { _culture = v; el.cultureLabel().textContent = categoryLabel(v); if (_state) _recompute(); });
  el.confirm().addEventListener("click", _commit);
  el.cancel().addEventListener("click", _close);
  el.backdrop().addEventListener("click", _close);
}
