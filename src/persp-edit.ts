// VP 编辑模式（ADR-0006 UI v2.2）——crop 同款半模态 transient：拖消失点/参考 box gizmo。
//
// 结构：DOM 手柄（screen 坐标，VP 常在画布外也能拖；board.onViewportChange 链式挂钩跟随
//   pan/zoom）+ board overlay 画淡地平线/box 棱线（setPerspGizmoProvider）。
// 语义（user 拍板三轮）：
//   · VP per-mode 分开存（editorState.persp.p1/p2/p3），坐标 snap 像素中线 +0.5；
//     lockHorizon 默认开（重置默认时回开）；参考点已删（box 取代——「低配的方块」）。
//   · 参考 box：VP = SSoT，box 参数只是编辑会话控制面。**顶点分层**（not every vertex is equal）：
//     A（最前角）= 整体平移不动 VP；B1/B2/B3（连 A 的三个）= 主控——精确单轴（转该轴 VP + 行程，
//     锁地平线时 VP 沿地平线滑）；C/D（更次级）= 阻尼 GN 全参数微调。
//   · 应用=保留（transient apply），取消/ctrl-z=回快照。工具条 = lasso 图标风格（重置/锁/✓/✕）。
import { editorState } from "./workbench-state.ts";
import { clampPixelCenter } from "./shape-geometry.ts";
import { defaultVpsForMode, boxAxesForMode, boxCorners, solveBoxDrag, BOX_EDGES } from "./perspective-frame.ts";
import { updateShapeToolbar } from "./toolbar.ts";
import type { PerspMode, BoxParams, Family } from "./perspective-frame.ts";
import type { AppContext } from "./app-context.ts";
import type { PerspGizmoData } from "./board.ts";

type Vp = { x: number; y: number };
type Kind = "vp1" | "vp2" | "vp3";

let _ctx: AppContext | null = null;
let _active = false;
let _toolbar: HTMLElement, _layer: HTMLElement;
let _lockBtn: HTMLElement, _lockUse: SVGUseElement;
const _handles = new Map<Kind, HTMLElement>();
let _box: BoxParams | null = null;   // 工作引用；SSoT 在 editorState 槽位（随 VP 持久化，user 拍板）
const _boxHandles: HTMLElement[] = [];

function _saveBox() {
  const s = _slot() as unknown as { box?: BoxParams | null } | null;
  if (s && _box) s.box = { A: { ..._box.A }, t: [..._box.t] as [number, number, number] };
}
function _loadBox(): BoxParams | null {
  const s = _slot() as { box?: BoxParams | null } | null;
  const b = s?.box;
  return b ? { A: { ...b.A }, t: [...b.t] as [number, number, number] } : null;
}

function _mode(): PerspMode {
  const m = editorState.persp.mode;
  return (m === "p1" || m === "p2" || m === "p3") ? m : "off";
}
// 当前模式的 VP 槽（per-mode 分开存）
function _slot(): { vp1: Vp | null; vp2?: Vp | null; vp3?: Vp | null } | null {
  const m = _mode();
  const g = editorState.persp;
  return m === "p1" ? g.p1 : m === "p2" ? g.p2 : m === "p3" ? g.p3 : null;
}
function _get(kind: Kind): Vp | null {
  const s = _slot();
  if (!s) return null;
  return kind === "vp1" ? s.vp1 : kind === "vp2" ? (s.vp2 ?? null) : (s.vp3 ?? null);
}
function _set(kind: Kind, v: Vp | null) {
  const s = _slot();
  if (!s) return;
  if (kind === "vp1") s.vp1 = v;
  else if (kind === "vp2" && "vp2" in s) s.vp2 = v;
  else if (kind === "vp3" && "vp3" in s) s.vp3 = v;
}
function _visibleKinds(): Kind[] {
  const m = _mode();
  if (m === "p1") return ["vp1"];
  if (m === "p2") return ["vp1", "vp2"];
  if (m === "p3") return ["vp1", "vp2", "vp3"];
  return [];
}

export function perspEditActive(): boolean { return _active; }

function _snap(p: Vp): Vp { return { x: clampPixelCenter(p.x), y: clampPixelCenter(p.y) }; }

// VP 手柄拖拽写回（lockHorizon：拖 VP1 带着 VP2 的 y；拖 VP2 只能沿地平线滑）
function _moveTo(kind: Kind, screenX: number, screenY: number) {
  const { board } = _ctx!;
  let p = _snap(board.screenToDoc(screenX, screenY));
  const g = editorState.persp;
  const vp1 = _get("vp1");
  if (g.lockHorizon && kind === "vp2" && vp1) p = { x: p.x, y: vp1.y };
  _set(kind, p);
  if (g.lockHorizon && kind === "vp1") {
    const vp2 = _get("vp2");
    if (vp2) _set("vp2", { x: vp2.x, y: p.y });
  }
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

const LABELS: Record<Kind, string> = { vp1: "1", vp2: "2", vp3: "V" };

function _axesNow(): [Family, Family, Family] | null {
  const m = _mode();
  if (m === "off") return null;
  return boxAxesForMode(m, _get("vp1"), m !== "p1" ? _get("vp2") : null, m === "p3" ? _get("vp3") : null);
}

function _boxCornersNow(): Vp[] | null {
  if (!_ctx || !_box) return null;
  const axes = _axesNow();
  return axes ? boxCorners(axes, _box) : null;
}

function _defaultBox(): BoxParams {
  const { doc } = _ctx!;
  const A = { x: clampPixelCenter(doc.width / 2 - doc.height / 6), y: clampPixelCenter(doc.height * 0.72) };
  const axes = _axesNow();
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
  for (const kind of ["vp1", "vp2", "vp3"] as Kind[]) {
    const p = _get(kind);
    const show = vis.includes(kind) && !!p;
    let el = _handles.get(kind);
    if (!show) { if (el) { el.remove(); _handles.delete(kind); } continue; }
    if (!el) { el = _mkHandle(kind, LABELS[kind]); _handles.set(kind, el); _layer.appendChild(el); }
    const s = board.docToScreen(p!.x, p!.y);
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
  }
  // box 八角手柄：分层视觉（A 最大、B 次之、C/D 最小——not every vertex is equal）
  const cs = _boxCornersNow();
  for (let k = 0; k < 8; k++) {
    let el = _boxHandles[k];
    if (!cs) { if (el) el.classList.add("hidden"); continue; }
    if (!el) {
      el = document.createElement("div");
      el.className = "persp-handle persp-box-handle";
      el.dataset.rank = k === 0 ? "a" : k <= 3 ? "b" : "c";
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

// box 顶点分层拖拽（user：not every vertex are created equal）：
//   0=A：整体平移（VP 不动）；1-3=B_i：单轴主控（精确解——转该轴 VP + 设行程；锁地平线时
//   水平 VP 沿地平线滑）；4-7=C/D：次级，阻尼 GN 全参数微调。
function _boxDragTo(cornerIdx: number, screenX: number, screenY: number) {
  if (!_ctx || !_box) return;
  const g = editorState.persp;
  const m = _mode();
  const vp1 = _get("vp1");
  if (m === "off" || !vp1) return;
  const target = _ctx.board.screenToDoc(screenX, screenY);
  if (cornerIdx === 0) {
    _box = { A: target, t: _box.t };
    _saveBox();
    _syncUi();
    return;
  }
  if (cornerIdx >= 1 && cornerIdx <= 3) {
    const axes = _axesNow();
    if (!axes) return;
    const ax = axes[cornerIdx - 1];
    const A = _box.A;
    if (ax.kind === "parallel") {
      // 平行轴：只有行程（投影到方向上，带符号）
      const d = ax.dir;
      const t = (target.x - A.x) * d.x + (target.y - A.y) * d.y;
      const tt: [number, number, number] = [..._box.t];
      tt[cornerIdx - 1] = t;
      _box = { A, t: tt };
      _saveBox();
    } else {
      // pencil 轴：拖 B_i = 转轴向 + 设行程。锁地平线的水平 VP → 沿地平线滑（A→target 延长到地平线）；
      //   自由 VP → 绕 A 等距旋转（保持 |VP−A|）。
      const kind: Kind = cornerIdx === 1 ? "vp1" : cornerIdx === 2 ? "vp2" : "vp3";
      const isHorizontalVp = kind === "vp1" || kind === "vp2";
      const old = _get(kind);
      if (!old) return;
      let nv: Vp | null = null;
      if (isHorizontalVp && g.lockHorizon) {
        const dy = target.y - A.y;
        if (Math.abs(dy) > 1e-3) {
          const s = (old.y - A.y) / dy;   // 延长 A→target 到地平线 y=old.y
          if (s > 1.01) nv = { x: A.x + (target.x - A.x) * s, y: old.y };
        }
      } else {
        const r = Math.hypot(old.x - A.x, old.y - A.y);
        const L = Math.hypot(target.x - A.x, target.y - A.y);
        if (L > 1e-6 && r > 1e-6) {
          nv = { x: A.x + ((target.x - A.x) / L) * r, y: A.y + ((target.y - A.y) / L) * r };
        }
      }
      if (nv) {
        _set(kind, nv);
        if (kind === "vp1" && g.lockHorizon) {
          const vp2 = _get("vp2");
          if (vp2) _set("vp2", { x: vp2.x, y: nv.y });
        }
      }
      const vpNow = _get(kind);
      if (vpNow) {
        const dist = Math.hypot(vpNow.x - A.x, vpNow.y - A.y);
        const L = Math.hypot(target.x - A.x, target.y - A.y);
        const tt: [number, number, number] = [..._box.t];
        tt[cornerIdx - 1] = Math.max(0.02, Math.min(0.9, dist > 1e-6 ? L / dist : tt[cornerIdx - 1]));
        _box = { A, t: tt };
      }
    }
    _saveBox();
    _syncUi();
    return;
  }
  // C/D：阻尼 GN 全参数（次级微调）
  const solved = solveBoxDrag({
    mode: m, lockHorizon: g.lockHorizon,
    vp1, vp2: m !== "p1" ? _get("vp2") : null, vp3: m === "p3" ? _get("vp3") : null,
    box: _box,
  }, cornerIdx, target);
  _set("vp1", solved.vp1);
  if (m !== "p1" && solved.vp2) _set("vp2", solved.vp2);
  if (m === "p3" && solved.vp3) _set("vp3", solved.vp3);
  _box = solved.box;
  _saveBox();
  _syncUi();
}

function _snapVpsToGrid() {
  for (const k of ["vp1", "vp2", "vp3"] as Kind[]) {
    const v = _get(k);
    if (v) _set(k, _snap(v));
  }
  _syncUi();
}

function _syncUi() {
  if (!_ctx || !_active) return;
  _syncHandles();
  const lock = editorState.persp.lockHorizon;
  _lockBtn.setAttribute("aria-pressed", lock ? "true" : "false");
  _lockUse.setAttribute("href", lock ? "#lock" : "#unlock");
  _ctx.board.requestRender();
}

// 重置默认（user 拍板）：VP 回默认位 + 锁地平线回开 + box 回默认
function _resetDefaults() {
  const { doc } = _ctx!;
  const m = _mode();
  if (m === "off") return;
  const def = defaultVpsForMode(m, doc.width, doc.height);
  _set("vp1", def.vp1);
  if (m !== "p1") _set("vp2", def.vp2);
  if (m === "p3") _set("vp3", def.vp3);
  editorState.persp.lockHorizon = true;
  _box = _defaultBox();
  _saveBox();
  _syncUi();
}

// 退出恒 apply（user：VP setting 是 editor state 不进 undo history → 没有 commit/cancel）
function _finish() {
  if (!_active) return;
  _active = false;
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
  _active = true;
  // 进场把本模式缺的 VP 按默认位补齐（正常由模式切换补，这里兜底老档/异常态）
  const def = defaultVpsForMode(_mode(), _ctx.doc.width, _ctx.doc.height);
  if (!_get("vp1") && def.vp1) _set("vp1", def.vp1);
  if (_mode() !== "p1" && !_get("vp2") && def.vp2) _set("vp2", def.vp2);
  if (_mode() === "p3" && !_get("vp3") && def.vp3) _set("vp3", def.vp3);
  _box = _loadBox() ?? _defaultBox();   // 存过的 box 跟文件走（user 拍板），首次用默认
  _saveBox();
  _ctx.editMode.enterTransient("perspEdit", { apply: () => _finish(), abort: () => _finish() });
  _toolbar.classList.remove("hidden");
  _layer.classList.remove("hidden");
  _syncUi();
}

export function initPerspEdit(ctx: AppContext): void {
  _ctx = ctx;
  _toolbar = document.getElementById("perspToolbar")!;
  _layer = document.getElementById("perspHandles")!;
  _lockBtn = document.getElementById("perspLockBtn")!;
  _lockUse = document.getElementById("perspLockUse") as unknown as SVGUseElement;
  document.getElementById("perspResetBtn")!.addEventListener("click", () => _resetDefaults());
  _lockBtn.addEventListener("click", () => {
    const g = editorState.persp;
    g.lockHorizon = !g.lockHorizon;
    if (g.lockHorizon) {
      const vp1 = _get("vp1"), vp2 = _get("vp2");
      if (vp1 && vp2) _set("vp2", { x: vp2.x, y: vp1.y });
    }
    _syncUi();
  });
  // 形状笔透视区里的入口（再点 = 退出，恒 apply；点其他工具 = onToolSwitch apply 同款）
  document.getElementById("shapeVpEditBtn")?.addEventListener("click", () => {
    if (_active) { _finish(); ctx.editMode.exitTransient(); }
    else enterPerspEdit();
  });
  // pan/zoom 中手柄跟随（单槽回调 → 链式包装，别打断 crop 的；只定位不 render，防递归）
  const prev = ctx.board.onViewportChange;
  ctx.board.onViewportChange = () => { prev?.(); if (_active) _syncHandles(); };
  // 换文档：收 UI（状态本就 live 在 editorState，新 doc 已 Unserialize）
  window.addEventListener("wp:applyEditorState", () => { if (_active) _finish(); });
  // gizmo：淡地平线 + VP 圈 + box 棱线（编辑模式）；绘图态 showGizmo 开 → 只显 VP+地平线
  ctx.board.setPerspGizmoProvider(() => {
    const g = editorState.persp;
    const m = _mode();
    if (m === "off") return null;
    const vp1 = _get("vp1"), vp2 = m !== "p1" ? _get("vp2") : null, vp3 = m === "p3" ? _get("vp3") : null;
    if (!vp1) return null;
    if (!_active && (!g.showGizmo || _ctx!.editMode.current() !== "shapeBrush")) return null;
    const L = (ctx.doc.width + ctx.doc.height) * 4;
    const out: PerspGizmoData = { horizon: null, rays: [], vps: [] };
    for (const v of [vp1, vp2, vp3]) if (v) out.vps.push(v);
    let d = { x: 1, y: 0 };
    if (vp2) {
      const len = Math.hypot(vp2.x - vp1.x, vp2.y - vp1.y) || 1;
      d = { x: (vp2.x - vp1.x) / len, y: (vp2.y - vp1.y) / len };
    }
    out.horizon = [
      { x: vp1.x - d.x * L, y: vp1.y - d.y * L },
      { x: vp1.x + d.x * L, y: vp1.y + d.y * L },
    ];
    if (_active) {
      const cs = _boxCornersNow();
      if (cs) out.boxEdges = BOX_EDGES.map(([a, b]) => [cs[a], cs[b]] as [Vp, Vp]);
    }
    return out;
  });
}
