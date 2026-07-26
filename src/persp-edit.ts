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
import { defaultVpsForMode, boxAxesForMode, boxCorners, solveBoxDrag, BOX_EDGES } from "./perspective-frame.ts";
import { updateShapeToolbar } from "./toolbar.ts";
import type { PerspMode, BoxParams } from "./perspective-frame.ts";
import type { AppContext } from "./app-context.ts";
import type { PerspGizmoData } from "./board.ts";

type Vp = { x: number; y: number };
type Kind = "vp1" | "vp2" | "vp3" | "ref";

let _ctx: AppContext | null = null;
let _active = false;
let _snapshot: unknown = null;
let _toolbar: HTMLElement, _layer: HTMLElement;
let _lockBtn: HTMLElement, _refBtn: HTMLElement;
const _handles = new Map<Kind, HTMLElement>();
// 参考 box（UI v2.1）：VP = SSoT，box 参数只是编辑会话的控制面（进模式时按画布重构默认）。
//   拖 box 角 → solveBoxDrag（阻尼 GN）反算 VP——弱透视时把控制灵敏度从 10×H 外搬回画布内。
let _box: BoxParams | null = null;
const _boxHandles: HTMLElement[] = [];

// mode 决定显示哪些 VP（UI v2：VP 数量 = 模式的属性，不再增删 chips）
function _mode(): PerspMode {
  const m = editorState.persp.mode;
  return (m === "p1" || m === "p2" || m === "p3") ? m : "off";
}
function _visibleKinds(): Kind[] {
  const m = _mode();
  const ks: Kind[] = [];
  if (m !== "off") ks.push("vp1");
  if (m === "p2" || m === "p3") ks.push("vp2");
  if (m === "p3") ks.push("vp3");
  if (editorState.persp.refPoint) ks.push("ref");
  return ks;
}

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

// 手柄定位（**不触发 requestRender**——它也被 onViewportChange 调，而 onViewportChange 在
//   requestRender 内部同步发射，这里再 requestRender 会无限递归；真机教训 2026-07-25）
// 当前 (mode, VP, box) 下的八角（病态 → null）
function _boxCornersNow(): Vp[] | null {
  if (!_ctx || !_box) return null;
  const g = editorState.persp;
  const m = _mode();
  if (m === "off" || !g.vp1) return null;
  const axes = boxAxesForMode(m, g.vp1, m !== "p1" ? g.vp2 : null, m === "p3" ? g.vp3 : null);
  return axes ? boxCorners(axes, _box) : null;
}

function _defaultBox(): BoxParams {
  const { doc } = _ctx!;
  const m = _mode();
  // 锚角放画布中下（人物/建筑常规站位）；pencil 轴走 1/4 行程，parallel 轴 = H/3 px
  const A = { x: clampPixelCenter(doc.width / 2 - doc.height / 6), y: clampPixelCenter(doc.height * 0.72) };
  const axes = boxAxesForMode(m, editorState.persp.vp1, m !== "p1" ? editorState.persp.vp2 : null, m === "p3" ? editorState.persp.vp3 : null);
  const t: [number, number, number] = [0.25, 0.25, 0.25];
  if (axes) {
    for (let i = 0; i < 3; i++) {
      if (axes[i].kind === "parallel") {
        const d = (axes[i] as { dir: Vp }).dir;
        t[i] = (d.y !== 0 ? -1 : 1) * doc.height / 3;   // 竖直轴向上长
      }
    }
  }
  return { A, t };
}

function _syncHandles() {
  if (!_ctx || !_active) return;
  const { board } = _ctx;
  const vis = _visibleKinds();
  for (const kind of ["vp1", "vp2", "vp3", "ref"] as Kind[]) {
    const p = _get(kind);
    const show = vis.includes(kind) && !!p;
    let el = _handles.get(kind);
    if (!show) { if (el) { el.remove(); _handles.delete(kind); } continue; }
    if (!el) { el = _mkHandle(kind, LABELS[kind]); _handles.set(kind, el); _layer.appendChild(el); }
    const s = board.docToScreen(p!.x, p!.y);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
  }
  // box 八角手柄
  const cs = _boxCornersNow();
  for (let k = 0; k < 8; k++) {
    let el = _boxHandles[k];
    if (!cs) { if (el) el.classList.add("hidden"); continue; }
    if (!el) {
      el = document.createElement("div");
      el.className = "persp-handle persp-box-handle";
      el.addEventListener("pointerdown", (e: PointerEvent) => {
        e.preventDefault(); e.stopPropagation();
        el!.setPointerCapture(e.pointerId);
        const onMove = (ev: PointerEvent) => _boxDragTo(k, ev.clientX, ev.clientY);
        const onUp = (ev: PointerEvent) => {
          el!.releasePointerCapture(ev.pointerId);
          el!.removeEventListener("pointermove", onMove);
          el!.removeEventListener("pointerup", onUp);
          el!.removeEventListener("pointercancel", onUp);
          _snapVpsToGrid();   // 拖完把 VP 钉回像素中线
        };
        el!.addEventListener("pointermove", onMove);
        el!.addEventListener("pointerup", onUp);
        el!.addEventListener("pointercancel", onUp);
      });
      _boxHandles[k] = el;
      _layer.appendChild(el);
    }
    el.classList.remove("hidden");
    const s = board.docToScreen(cs[k].x, cs[k].y);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
  }
}

// 拖 box 角：反算 (VP, box) 并写回 editorState（求解期间 VP 保持 float，抬手再 snap）
function _boxDragTo(cornerIdx: number, screenX: number, screenY: number) {
  if (!_ctx || !_box) return;
  const g = editorState.persp;
  const m = _mode();
  if (m === "off" || !g.vp1) return;
  const target = _ctx.board.screenToDoc(screenX, screenY);
  const solved = solveBoxDrag({
    mode: m, lockHorizon: g.lockHorizon,
    vp1: g.vp1, vp2: m !== "p1" ? g.vp2 : null, vp3: m === "p3" ? g.vp3 : null,
    box: _box,
  }, cornerIdx, target);
  g.vp1 = solved.vp1;
  if (m !== "p1" && solved.vp2) g.vp2 = solved.vp2;
  if (m === "p3" && solved.vp3) g.vp3 = solved.vp3;
  _box = solved.box;
  _syncUi();
}

function _snapVpsToGrid() {
  const g = editorState.persp;
  if (g.vp1) g.vp1 = _snap(g.vp1);
  if (g.vp2) g.vp2 = _snap(g.vp2);
  if (g.vp3) g.vp3 = _snap(g.vp3);
  _syncUi();
}

function _syncUi() {
  if (!_ctx || !_active) return;
  _syncHandles();
  _lockBtn.setAttribute("aria-pressed", editorState.persp.lockHorizon ? "true" : "false");
  _refBtn.setAttribute("aria-pressed", editorState.persp.refPoint ? "true" : "false");
  _ctx.board.requestRender();
}

// 重置默认（user 拍板）：VP 回默认位 + 锁地平线回开 + box 回默认（一点=正中；二点=总间隔 2H；
//   三点=+上方 1.5H 仰视）
function _resetDefaults() {
  const { doc } = _ctx!;
  const m = _mode();
  if (m === "off") return;
  const def = defaultVpsForMode(m, doc.width, doc.height);
  const g = editorState.persp;
  g.vp1 = def.vp1; g.vp2 = def.vp2; g.vp3 = def.vp3;
  g.lockHorizon = true;
  _box = _defaultBox();
  _syncUi();
}

function _toggleRef() {
  const { doc } = _ctx!;
  const g = editorState.persp;
  g.refPoint = g.refPoint ? null : _snap({ x: doc.width / 2, y: doc.height / 2 });
  _syncUi();
}

function _finish(keep: boolean) {
  if (!_active) return;
  _active = false;
  if (!keep && _snapshot) restoreShapePersp(_snapshot);
  _snapshot = null;
  _box = null;
  _toolbar.classList.add("hidden");
  _layer.classList.add("hidden");
  for (const el of _handles.values()) el.remove();
  _handles.clear();
  for (const el of _boxHandles) el?.remove();
  _boxHandles.length = 0;
  updateShapeToolbar();
  _ctx!.board.requestRender();
}

export function enterPerspEdit(): void {
  if (!_ctx || _active) return;
  if (_mode() === "off") return;   // 视口对齐无 VP 可编（按钮本就藏着）
  _snapshot = snapshotShapePersp();
  _active = true;
  // 进场把本模式缺的 VP 按默认位补齐（正常由模式切换补，这里兜底老档/异常态）
  const def = defaultVpsForMode(_mode(), _ctx.doc.width, _ctx.doc.height);
  const g = editorState.persp;
  if (!g.vp1 && def.vp1) g.vp1 = def.vp1;
  if (!g.vp2 && def.vp2) g.vp2 = def.vp2;
  if (!g.vp3 && def.vp3) g.vp3 = def.vp3;
  if (!g.refPoint) g.refPoint = _snap({ x: _ctx.doc.width / 2, y: _ctx.doc.height / 2 });   // 参考点默认开
  _box = _defaultBox();
  _ctx.editMode.enterTransient("perspEdit", { apply: () => _finish(true), abort: () => _finish(false) });
  _toolbar.classList.remove("hidden");
  _layer.classList.remove("hidden");
  _syncUi();
}

export function initPerspEdit(ctx: AppContext): void {
  _ctx = ctx;
  _toolbar = document.getElementById("perspToolbar")!;
  _layer = document.getElementById("perspHandles")!;
  _refBtn = document.getElementById("perspRefBtn")!;
  _lockBtn = document.getElementById("perspLockBtn")!;
  document.getElementById("perspResetBtn")!.addEventListener("click", () => _resetDefaults());
  _refBtn.addEventListener("click", () => _toggleRef());
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
  // pan/zoom 中手柄跟随（单槽回调 → 链式包装，别打断 crop 的；只定位不 render，防递归）
  const prev = ctx.board.onViewportChange;
  ctx.board.onViewportChange = () => { prev?.(); if (_active) _syncHandles(); };
  // 换文档：只收 UI 不动状态（新 doc 的 persp 已 Unserialize，绝不能拿旧快照 restore 污染）
  window.addEventListener("wp:applyEditorState", () => { if (_active) _finish(true); });
  // gizmo：淡地平线 + VP 圈 + 参考点射线（只在本模式非空；平时零成本）
  ctx.board.setPerspGizmoProvider(() => {
    const g = editorState.persp;
    const m = _mode();
    if (m === "off") return null;
    // 绘图态（非编辑模式）：showGizmo 开且形状笔激活 → 只显 VP+地平线（user：作画时也要看得到）
    if (!_active) {
      if (!g.showGizmo || _ctx!.editMode.current() !== "shapeBrush" || !g.vp1) return null;
      const vp2d = (m === "p2" || m === "p3") ? g.vp2 : null, vp3d = m === "p3" ? g.vp3 : null;
      const Ld = (ctx.doc.width + ctx.doc.height) * 4;
      const outd: PerspGizmoData = { horizon: null, rays: [], vps: [] };
      for (const v of [g.vp1, vp2d, vp3d]) if (v) outd.vps.push(v);
      let dd = { x: 1, y: 0 };
      if (vp2d) {
        const len = Math.hypot(vp2d.x - g.vp1.x, vp2d.y - g.vp1.y) || 1;
        dd = { x: (vp2d.x - g.vp1.x) / len, y: (vp2d.y - g.vp1.y) / len };
      }
      outd.horizon = [
        { x: g.vp1.x - dd.x * Ld, y: g.vp1.y - dd.y * Ld },
        { x: g.vp1.x + dd.x * Ld, y: g.vp1.y + dd.y * Ld },
      ];
      return outd;
    }
    // 按模式取活跃 VP（存着的多余 VP 不显——mode 决定数量，UI v2）
    const vp1 = g.vp1, vp2 = (m === "p2" || m === "p3") ? g.vp2 : null, vp3 = m === "p3" ? g.vp3 : null;
    const L = (ctx.doc.width + ctx.doc.height) * 4;
    const out: PerspGizmoData = { horizon: null, rays: [], vps: [] };
    for (const v of [vp1, vp2, vp3]) if (v) out.vps.push(v);
    if (vp1) {
      let d = { x: 1, y: 0 };
      if (vp2) {
        const len = Math.hypot(vp2.x - vp1.x, vp2.y - vp1.y) || 1;
        d = { x: (vp2.x - vp1.x) / len, y: (vp2.y - vp1.y) / len };
      }
      out.horizon = [
        { x: vp1.x - d.x * L, y: vp1.y - d.y * L },
        { x: vp1.x + d.x * L, y: vp1.y + d.y * L },
      ];
    }
    const ref = g.refPoint;
    if (ref) {
      for (const v of [vp1, vp2, vp3]) {
        if (!v) continue;
        const len = Math.hypot(v.x - ref.x, v.y - ref.y) || 1;
        const d = { x: (v.x - ref.x) / len, y: (v.y - ref.y) / len };
        out.rays.push([ref, { x: ref.x + d.x * L, y: ref.y + d.y * L }]);
      }
      // 尚存平行族的参考线（水平族：一点透视；竖直族：非三点）
      if (m === "p1") out.rays.push([{ x: ref.x - L, y: ref.y }, { x: ref.x + L, y: ref.y }]);
      if (m !== "p3") out.rays.push([{ x: ref.x, y: ref.y - L }, { x: ref.x, y: ref.y + L }]);
    }
    // 参考 box 的 12 条棱
    const cs = _boxCornersNow();
    if (cs) {
      out.boxEdges = BOX_EDGES.map(([a, b]) => [cs[a], cs[b]] as [Vp, Vp]);
    }
    return out;
  });
}
