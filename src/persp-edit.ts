// VP 编辑模式（ADR-0006）——crop 同款半模态 transient：拖消失点/参考点 gizmo。
//
// 结构：DOM 手柄（screen 坐标，VP 常在画布外也能拖；board.onViewportChange 链式挂钩跟随
//   pan/zoom）+ board overlay 画淡地平线/参考点射线（setPerspGizmoProvider，只在本模式非空）。
// 语义（user 拍板）：VP 坐标 snap 像素中线 +0.5（与形状端点同格系）；VP1/VP2 = 水平对
//   （lockHorizon 开 = 锁 doc 水平线，默认开；极端场景关掉可歪地平线）；VP3 = 竖直族（只有
//   位置，地平线下=俯视/上=仰视）；参考点数学无用、只发淡射线帮美工立框架（**只在本模式显示**）。
//   应用=保留（transient apply），取消/ctrl-z=回快照。3D grid 弃案（两角点拖不出来，手动画）。
import { editorState, snapshotShapePersp, restoreShapePersp } from "./workbench-state.ts";
import { clampPixelCenter } from "./shape-geometry.ts";
import { updateShapeToolbar } from "./toolbar.ts";
import type { AppContext } from "./app-context.ts";
import type { PerspGizmoData } from "./board.ts";

type Vp = { x: number; y: number };
type Kind = "vp1" | "vp2" | "vp3" | "ref";

let _ctx: AppContext | null = null;
let _active = false;
let _snapshot: unknown = null;
let _toolbar: HTMLElement, _layer: HTMLElement;
let _chips: Record<Kind, HTMLElement>, _lockBtn: HTMLElement;
const _handles = new Map<Kind, HTMLElement>();

const _get = (k: Kind): Vp | null =>
  k === "vp1" ? editorState.persp.vp1 : k === "vp2" ? editorState.persp.vp2 :
  k === "vp3" ? editorState.persp.vp3 : editorState.persp.refPoint;
const _set = (k: Kind, v: Vp | null) => {
  if (k === "vp1") editorState.persp.vp1 = v;
  else if (k === "vp2") editorState.persp.vp2 = v;
  else if (k === "vp3") editorState.persp.vp3 = v;
  else editorState.persp.refPoint = v;
};

export function perspEditActive(): boolean { return _active; }

function _snap(p: Vp): Vp { return { x: clampPixelCenter(p.x), y: clampPixelCenter(p.y) }; }

// 手柄拖拽写回（lockHorizon：拖 VP1 带着 VP2 的 y；拖 VP2 只能沿地平线滑）
function _moveTo(kind: Kind, screenX: number, screenY: number) {
  const { board } = _ctx!;
  let p = _snap(board.screenToDoc(screenX, screenY));
  const g = editorState.persp;
  if (g.lockHorizon && kind === "vp2" && g.vp1) p = { x: p.x, y: g.vp1.y };
  _set(kind, p);
  if (g.lockHorizon && kind === "vp1" && g.vp2) g.vp2 = { x: g.vp2.x, y: p.y };
  _syncUi();
}

function _mkHandle(kind: Kind, label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "persp-handle";
  el.dataset.kind = kind;
  el.textContent = label;
  el.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => _moveTo(kind, ev.clientX, ev.clientY);
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  });
  return el;
}

const LABELS: Record<Kind, string> = { vp1: "1", vp2: "2", vp3: "V", ref: "◎" };

function _syncUi() {
  if (!_ctx || !_active) return;
  const { board } = _ctx;
  const g = editorState.persp;
  for (const kind of ["vp1", "vp2", "vp3", "ref"] as Kind[]) {
    const p = _get(kind);
    let el = _handles.get(kind);
    if (!p) { if (el) { el.remove(); _handles.delete(kind); } continue; }
    if (!el) { el = _mkHandle(kind, LABELS[kind]); _handles.set(kind, el); _layer.appendChild(el); }
    const s = board.docToScreen(p.x, p.y);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    _chipsSync();
  }
  _chipsSync();
  _lockBtn.setAttribute("aria-pressed", g.lockHorizon ? "true" : "false");
  board.requestRender();
}

function _chipsSync() {
  for (const kind of ["vp1", "vp2", "vp3", "ref"] as Kind[]) {
    _chips[kind].setAttribute("aria-pressed", _get(kind) ? "true" : "false");
  }
}

// chip 点击：无 → 在合理默认位创建；有 → 移除（移除 vp1 时 vp2 顶上——planeFamilies 以 vp1 为先）
function _toggle(kind: Kind) {
  const { doc } = _ctx!;
  const g = editorState.persp;
  const cur = _get(kind);
  if (cur) {
    _set(kind, null);
    if (kind === "vp1" && g.vp2) { g.vp1 = g.vp2; g.vp2 = null; }
  } else {
    const horizonY = g.vp1 ? g.vp1.y : clampPixelCenter(doc.height * 0.4);
    const def: Vp =
      kind === "vp1" ? _snap({ x: -doc.width * 0.25, y: horizonY }) :
      kind === "vp2" ? _snap({ x: doc.width * 1.25, y: horizonY }) :
      kind === "vp3" ? _snap({ x: doc.width / 2, y: doc.height * 1.6 }) :
      _snap({ x: doc.width / 2, y: doc.height / 2 });
    if (kind === "vp2" && !g.vp1) { _set("vp1", def); }   // 没 VP1 先补 VP1（排序不变式）
    else _set(kind, def);
    if (kind === "vp2" && g.vp1 && g.vp2 && g.vp2.x < g.vp1.x) { const t = g.vp1; g.vp1 = g.vp2; g.vp2 = t; }
  }
  _syncUi();
}

function _finish(keep: boolean) {
  if (!_active) return;
  _active = false;
  if (!keep && _snapshot) restoreShapePersp(_snapshot);
  _snapshot = null;
  _toolbar.classList.add("hidden");
  _layer.classList.add("hidden");
  for (const el of _handles.values()) el.remove();
  _handles.clear();
  updateShapeToolbar();
  _ctx!.board.requestRender();
}

export function enterPerspEdit(): void {
  if (!_ctx || _active) return;
  _snapshot = snapshotShapePersp();
  _active = true;
  _ctx.editMode.enterTransient("perspEdit", { apply: () => _finish(true), abort: () => _finish(false) });
  _toolbar.classList.remove("hidden");
  _layer.classList.remove("hidden");
  _syncUi();
}

export function initPerspEdit(ctx: AppContext): void {
  _ctx = ctx;
  _toolbar = document.getElementById("perspToolbar")!;
  _layer = document.getElementById("perspHandles")!;
  _chips = {
    vp1: document.getElementById("perspVp1Btn")!,
    vp2: document.getElementById("perspVp2Btn")!,
    vp3: document.getElementById("perspVp3Btn")!,
    ref: document.getElementById("perspRefBtn")!,
  };
  _lockBtn = document.getElementById("perspLockBtn")!;
  for (const kind of ["vp1", "vp2", "vp3", "ref"] as Kind[]) {
    _chips[kind].addEventListener("click", () => _toggle(kind));
  }
  _lockBtn.addEventListener("click", () => {
    const g = editorState.persp;
    g.lockHorizon = !g.lockHorizon;
    if (g.lockHorizon && g.vp1 && g.vp2) g.vp2 = { x: g.vp2.x, y: g.vp1.y };
    _syncUi();
  });
  document.getElementById("perspApplyBtn")!.addEventListener("click", () => { _finish(true); ctx.editMode.exitTransient(); });
  document.getElementById("perspCancelBtn")!.addEventListener("click", () => { _finish(false); ctx.editMode.exitTransient(); });
  // 形状笔透视菜单里的入口
  document.getElementById("shapeVpEditBtn")?.addEventListener("click", () => enterPerspEdit());
  // pan/zoom 中手柄跟随（单槽回调 → 链式包装，别打断 crop 的）
  const prev = ctx.board.onViewportChange;
  ctx.board.onViewportChange = () => { prev?.(); if (_active) _syncUi(); };
  // gizmo：淡地平线 + VP 圈 + 参考点射线（只在本模式非空；平时零成本）
  ctx.board.setPerspGizmoProvider(() => {
    if (!_active) return null;
    const g = editorState.persp;
    const L = (ctx.doc.width + ctx.doc.height) * 4;
    const out: PerspGizmoData = { horizon: null, rays: [], vps: [] };
    for (const v of [g.vp1, g.vp2, g.vp3]) if (v) out.vps.push(v);
    if (g.vp1) {
      let d = { x: 1, y: 0 };
      if (g.vp2) {
        const len = Math.hypot(g.vp2.x - g.vp1.x, g.vp2.y - g.vp1.y) || 1;
        d = { x: (g.vp2.x - g.vp1.x) / len, y: (g.vp2.y - g.vp1.y) / len };
      }
      out.horizon = [
        { x: g.vp1.x - d.x * L, y: g.vp1.y - d.y * L },
        { x: g.vp1.x + d.x * L, y: g.vp1.y + d.y * L },
      ];
    }
    const ref = g.refPoint;
    if (ref) {
      for (const v of [g.vp1, g.vp2, g.vp3]) {
        if (!v) continue;
        const len = Math.hypot(v.x - ref.x, v.y - ref.y) || 1;
        const d = { x: (v.x - ref.x) / len, y: (v.y - ref.y) / len };
        out.rays.push([ref, { x: ref.x + d.x * L, y: ref.y + d.y * L }]);
      }
      // 尚存平行族的参考线（水平族：<2 个水平 VP；竖直族：无 VP3）
      if (!(g.vp1 && g.vp2)) out.rays.push([{ x: ref.x - L, y: ref.y }, { x: ref.x + L, y: ref.y }]);
      if (!g.vp3) out.rays.push([{ x: ref.x, y: ref.y - L }, { x: ref.x, y: ref.y + L }]);
    }
    return out;
  });
}
