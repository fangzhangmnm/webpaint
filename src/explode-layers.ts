// 职责（单一）：「按颜色拆分图层」sheet 编排（图层 ⋯ 菜单 → 选 k → 预览中心色/占比 →
//   拆分 or 取消）。聚类/分片数学全在 color-cluster.ts（纯字节，零 canvas）；树变更 =
//   doc.explodeLayerToLayers（collapseGroupToLayer 的逆向）；撤销 = treeStructure 快照
//   （原叶活引用进 before，一步 undo 整体还原）。
//
// 预览是**采样估计**（≤5 万样本，毫秒级，k 拖动即时重算）；commit 才对 bbox 全像素做
//   最终硬分配，占比按全分辨率重数、全空簇丢弃——所以落地层数可能 < k（sheet 里如实说明）。

import { clusterColors, partitionByNearest, hexOf, type ColorCluster } from "./color-cluster.ts";
import { countLeaves, type Layer } from "./doc.ts";
import { t } from "./i18n/index.ts";
import type { AppContext } from "./app-context.ts";

let ctx: AppContext;

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const el = {
  backdrop: () => byId("explodeBackdrop"),
  sheet: () => byId("explodeSheet"),
  k: () => byId("explodeK") as HTMLInputElement,
  kVal: () => byId("explodeKVal"),
  swatches: () => byId("explodeSwatches"),
  msg: () => byId("explodeMsg"),
  confirm: () => byId("explodeConfirm") as HTMLButtonElement,
  cancel: () => byId("explodeCancel") as HTMLButtonElement,
};

// sheet 打开期间的瞬态（关闭即清，region 可达 16MB 级别，勿滞留）。
let _state: {
  layerId: number;
  rect: { ox: number; oy: number; w: number; h: number };
  region: Uint8ClampedArray;
  clusters: ColorCluster[];
} | null = null;

function _close() {
  el.backdrop().classList.add("hidden");
  el.sheet().classList.add("hidden");
  document.removeEventListener("keydown", _onKey);
  _state = null;   // 释放 region 引用
}

function _onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); _close(); }
}

// 重算聚类 + 渲染 swatch 行（chip 底色 = 中心色，标签 = 采样占比；title = hex）。
function _recompute() {
  if (!_state) return;
  const k = parseInt(el.k().value, 10);
  el.kVal().textContent = String(k);
  _state.clusters = clusterColors(_state.region, k);
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
    chip.append(i, em);
    box.appendChild(chip);
  }
  el.confirm().disabled = _state.clusters.length < 2;
}

// 入口（图层 ⋯ 菜单）。守卫：叶、有像素、还有 ≥1 个空位（k≥2 → 净增 ≥1 叶）。
export function openExplodeSheet(L: Layer | null) {
  if (!L || L.isGroup) return;
  if (L.bboxW <= 0 || L.bboxH <= 0) { ctx.setStatus(t("ex.empty")); return; }
  const room = ctx.doc.maxLayers - countLeaves(ctx.doc.layers) + 1;   // 原叶让位后可放的分片数
  if (room < 2) { ctx.setStatus(t("ex.tooMany", { n: ctx.doc.maxLayers })); return; }
  const rect = { ox: L.bboxX, oy: L.bboxY, w: L.bboxW, h: L.bboxH };
  const region = L.pixels.getRegion(rect.ox, rect.oy, rect.w, rect.h);
  _state = { layerId: L.id, rect, region, clusters: [] };
  const kInput = el.k();
  kInput.max = String(Math.min(8, room));
  if (parseInt(kInput.value, 10) > room) kInput.value = String(room);
  el.msg().classList.add("hidden");
  el.backdrop().classList.remove("hidden");
  el.sheet().classList.remove("hidden");
  document.addEventListener("keydown", _onKey);
  _recompute();
}

function _commit() {
  if (!_state || _state.clusters.length < 2) return;
  const { doc, history, workpiece, ops, board, setStatus, afterDocChange } = ctx;
  const L = doc.findLayer(_state.layerId);
  if (!L || L.isGroup) { _close(); return; }
  // 全分辨率硬分配（预览是采样估计；这里才是定案）。空簇丢弃 → 实际层数可能 < k。
  const centers = _state.clusters.map((c) => c.center);
  const { parts, counts } = partitionByNearest(_state.region, centers);
  const kept: { data: Uint8ClampedArray; name: string }[] = [];
  for (let c = 0; c < parts.length; c++) {
    if (counts[c] === 0) continue;
    kept.push({ data: parts[c], name: `${L.name} ${hexOf(centers[c])}` });
  }
  if (kept.length < 2) { setStatus(t("ex.empty")); _close(); return; }
  kept.reverse();   // clusters 按占比降序 → 反转后大簇在 parts[0] = 同级最底
  const before = doc.snapshotTree();
  const out = doc.explodeLayerToLayers(L.id, kept, _state.rect);
  if (!out) { setStatus(t("ex.tooMany", { n: doc.maxLayers })); _close(); return; }
  const after = doc.snapshotTree();
  history.run(workpiece, ops.treeStructure, {
    before, after,
    undoStatus: t("lp.st.unexploded", { name: L.name }),
    redoStatus: t("lp.st.exploded", { name: L.name, k: out.length }),
  });
  _close();
  afterDocChange();
  board.invalidateAll();
  setStatus(t("lp.st.exploded", { name: L.name, k: out.length }));
}

export function initExplodeSheet(c: AppContext) {
  ctx = c;
  el.confirm().addEventListener("click", _commit);
  el.cancel().addEventListener("click", _close);
  el.backdrop().addEventListener("click", _close);
  el.k().addEventListener("input", _recompute);
}
