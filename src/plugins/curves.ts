// 曲线——UI 面（通道 tab + 曲线 canvas 编辑器：拖点/加点/长按删点）。
// 数学 = backend/filters/curves-kernel.ts（C8 析出：bake/defaults/buildCurveLut 委托 kernel；
// UI 画曲线与 bake 同一条 LUT，所见即所烤）。

import { registerFilter } from "../filters.ts";
import { t } from "../i18n/index.ts";
import { CurvesKernel, buildCurveLut, type CurvePoint } from "../backend/filters/curves-kernel.ts";

type Point = CurvePoint;

interface CurvesBuildState {
  params: { active: string; [ch: string]: unknown };
}

export class CurvesFilter {
  static id = "curves";
  static title = t("flt.curves.title");
  static category = "adjustment";
  static modes = ["region"];
  static bleedRadius = CurvesKernel.bleedRadius;
  static defaults = CurvesKernel.defaults;
  static bake = CurvesKernel.bake;

  static buildBody(container: HTMLElement, state: CurvesBuildState, onChange: () => void): void {
    container.innerHTML = "";
    // 通道 selector
    const tabs = document.createElement("div");
    tabs.className = "curves-tabs";
    const CH = [
      { id: "comp", label: t("flt.curves.all"), color: "#999" },
      { id: "r",    label: "R",    color: "#e44" },
      { id: "g",    label: "G",    color: "#3a3" },
      { id: "b",    label: "B",    color: "#46e" },
      { id: "a",    label: "A",    color: "#bbb" },
    ];
    for (const c of CH) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "curves-tab";
      b.textContent = c.label;
      b.style.borderBottomColor = c.color;
      b.dataset.ch = c.id;
      b.addEventListener("click", () => {
        state.params.active = c.id;
        for (const x of tabs.children) x.setAttribute("aria-pressed", (x as HTMLElement).dataset.ch === c.id ? "true" : "false");
        draw();
      });
      b.setAttribute("aria-pressed", state.params.active === c.id ? "true" : "false");
      tabs.appendChild(b);
    }
    container.appendChild(tabs);

    const SIZE = 224;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    canvas.className = "curves-canvas";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;

    function getPts(): Point[] { return state.params[state.params.active] as Point[]; }
    function setPts(pts: Point[]): void { state.params[state.params.active] = pts; }
    function toScreen(x: number, y: number): { sx: number; sy: number } { return { sx: (x / 255) * SIZE, sy: SIZE - (y / 255) * SIZE }; }
    function toData(sx: number, sy: number): Point {
      return [
        Math.max(0, Math.min(255, Math.round((sx / SIZE) * 255))),
        Math.max(0, Math.min(255, Math.round((1 - sy / SIZE) * 255))),
      ];
    }
    function draw() {
      const ch = state.params.active;
      const chDef = CH.find((c) => c.id === ch)!;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = "#1c1c1c"; ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const p = (i / 4) * SIZE;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SIZE); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SIZE, p); ctx.stroke();
      }
      ctx.strokeStyle = "#444";
      ctx.beginPath(); ctx.moveTo(0, SIZE); ctx.lineTo(SIZE, 0); ctx.stroke();
      const lut = buildCurveLut(getPts());
      ctx.strokeStyle = chDef.color; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const { sx, sy } = toScreen(x, lut[x]);
        if (x === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      for (const [px, py] of getPts()) {
        const { sx, sy } = toScreen(px, py);
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fillStyle = chDef.color; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    let dragIdx = -1, longPressTimer: ReturnType<typeof setTimeout> | null = null, downAt: { sx: number; sy: number } | null = null;
    canvas.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const pts = getPts();
      const HIT = 12;
      let hit = -1;
      for (let i = 0; i < pts.length; i++) {
        const { sx: px, sy: py } = toScreen(pts[i][0], pts[i][1]);
        if ((sx - px) ** 2 + (sy - py) ** 2 < HIT * HIT) { hit = i; break; }
      }
      if (hit >= 0) {
        dragIdx = hit;
        if (hit !== 0 && hit !== pts.length - 1) {
          longPressTimer = setTimeout(() => {
            const cur = getPts();
            if (cur.length > 2) {
              cur.splice(hit, 1);
              setPts(cur); onChange(); draw();
            }
            dragIdx = -1;
          }, 500);
        }
      } else {
        const [dx, dy] = toData(sx, sy);
        const newPts = pts.slice();
        let ins = newPts.findIndex((pt: Point) => pt[0] > dx);
        if (ins < 0) ins = newPts.length - 1;
        if (ins === 0) ins = 1;
        newPts.splice(ins, 0, [dx, dy]);
        setPts(newPts);
        dragIdx = ins;
        onChange(); draw();
      }
      downAt = { sx, sy };
    });
    canvas.addEventListener("pointermove", (e: PointerEvent) => {
      if (dragIdx < 0) return;
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (longPressTimer && downAt) {
        if ((sx - downAt.sx) ** 2 + (sy - downAt.sy) ** 2 > 16) {
          clearTimeout(longPressTimer); longPressTimer = null;
        }
      }
      const pts = getPts();
      const [dx, dy] = toData(sx, sy);
      if (dragIdx === 0) pts[0] = [0, dy];
      else if (dragIdx === pts.length - 1) pts[pts.length - 1] = [255, dy];
      else {
        const xMin = pts[dragIdx - 1][0] + 1;
        const xMax = pts[dragIdx + 1][0] - 1;
        pts[dragIdx] = [Math.max(xMin, Math.min(xMax, dx)), dy];
      }
      onChange(); draw();
    });
    const endDrag = (e: PointerEvent): void => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      dragIdx = -1;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    draw();
  }
}

registerFilter(CurvesFilter);
