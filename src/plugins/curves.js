// 曲线（RGBA + 复合）
// 5 通道：复合 / R / G / B / A
// 应用顺序：复合（同时作用于 R/G/B）→ R/G/B 各自 → A
//
// v132 (user：「曲线不是折线！」)：
//   分段插值改 Monotonic Cubic Hermite (Fritsch-Carlson)
//   保单调性 / 不 overshoot（vs Catmull-Rom 在密集点会 over/undershoot 被 clamp 成 plateau）

import { registerFilter, clamp8 } from "../filters.js";

export class CurvesFilter {
  static id = "curves";
  static title = "曲线";
  static category = "adjustment";
  static modes = ["region"];
  static bleedRadius() { return 0; }

  static defaults() {
    const id = () => [[0, 0], [255, 255]];
    return { active: "comp", comp: id(), r: id(), g: id(), b: id(), a: id() };
  }

  // v135 (user：「曲线还是有点怪，不是 PS / Unity 手感」)：换 Catmull-Rom
  //   切线 = (邻居 y 差) / (邻居 x 差) — 中心差分
  //   端点 = 单边斜率
  //   平滑舒服（视觉跟 PS / Unity Curve Editor 一致）
  //   越界值会 clamp 到 0..255，偶尔出现 plateau 是 trade-off（PS 也这样）
  //   Hermite basis 复用：y(t) = h00·y0 + h10·dx·m0 + h01·y1 + h11·dx·m1
  static _buildLut(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    const n = pts.length;
    const lut = new Uint8Array(256);
    if (n < 2) {
      for (let x = 0; x < 256; x++) lut[x] = x;
      return lut;
    }
    // 1) Catmull-Rom 切线（中心差分；端点单边）
    const tans = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        const dx = pts[1][0] - pts[0][0];
        tans[i] = dx === 0 ? 0 : (pts[1][1] - pts[0][1]) / dx;
      } else if (i === n - 1) {
        const dx = pts[n - 1][0] - pts[n - 2][0];
        tans[i] = dx === 0 ? 0 : (pts[n - 1][1] - pts[n - 2][1]) / dx;
      } else {
        const dx = pts[i + 1][0] - pts[i - 1][0];
        tans[i] = dx === 0 ? 0 : (pts[i + 1][1] - pts[i - 1][1]) / dx;
      }
    }
    // 2) 采样到 LUT（Hermite basis）
    let seg = 0;
    for (let x = 0; x < 256; x++) {
      while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
      const x0 = pts[seg][0], y0 = pts[seg][1];
      const x1 = pts[seg + 1][0], y1 = pts[seg + 1][1];
      const dx = x1 - x0;
      if (dx === 0) { lut[x] = clamp8(y0); continue; }
      const t = (x - x0) / dx;
      const t2 = t * t, t3 = t2 * t;
      const h00 =  2 * t3 - 3 * t2 + 1;
      const h10 =      t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 =      t3 -     t2;
      const y = h00 * y0 + h10 * dx * tans[seg] + h01 * y1 + h11 * dx * tans[seg + 1];
      lut[x] = clamp8(y);
    }
    return lut;
  }

  static buildBody(container, state, onChange) {
    container.innerHTML = "";
    // 通道 selector
    const tabs = document.createElement("div");
    tabs.className = "curves-tabs";
    const CH = [
      { id: "comp", label: "全部", color: "#999" },
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
        for (const x of tabs.children) x.setAttribute("aria-pressed", x.dataset.ch === c.id ? "true" : "false");
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
    const ctx = canvas.getContext("2d");

    function getPts() { return state.params[state.params.active]; }
    function setPts(pts) { state.params[state.params.active] = pts; }
    function toScreen(x, y) { return { sx: (x / 255) * SIZE, sy: SIZE - (y / 255) * SIZE }; }
    function toData(sx, sy) {
      return [
        Math.max(0, Math.min(255, Math.round((sx / SIZE) * 255))),
        Math.max(0, Math.min(255, Math.round((1 - sy / SIZE) * 255))),
      ];
    }
    function draw() {
      const ch = state.params.active;
      const chDef = CH.find((c) => c.id === ch);
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
      const lut = CurvesFilter._buildLut(getPts());
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
    let dragIdx = -1, longPressTimer = null, downAt = null;
    canvas.addEventListener("pointerdown", (e) => {
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
        let ins = newPts.findIndex((pt) => pt[0] > dx);
        if (ins < 0) ins = newPts.length - 1;
        if (ins === 0) ins = 1;
        newPts.splice(ins, 0, [dx, dy]);
        setPts(newPts);
        dragIdx = ins;
        onChange(); draw();
      }
      downAt = { sx, sy };
    });
    canvas.addEventListener("pointermove", (e) => {
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
    const endDrag = (e) => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      dragIdx = -1;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    draw();
  }

  static bake(srcData, dstData, p, mask) {
    const lutComp = CurvesFilter._buildLut(p.comp);
    const lutR    = CurvesFilter._buildLut(p.r);
    const lutG    = CurvesFilter._buildLut(p.g);
    const lutB    = CurvesFilter._buildLut(p.b);
    const lutA    = CurvesFilter._buildLut(p.a);
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      dstData[o]   = lutR[lutComp[srcData[o]]];
      dstData[o+1] = lutG[lutComp[srcData[o+1]]];
      dstData[o+2] = lutB[lutComp[srcData[o+2]]];
      dstData[o+3] = lutA[srcData[o+3]];
    }
  }
}

registerFilter(CurvesFilter);
