// 调色板小窗：256×256 浮动 canvas + 3 个迷你工具（刷 / 涂 / 吸）
// user 场景：在小窗里混色（不要拖 HSV），吸到主画。
// 实现：独立 mini 画布，不走主 BrushEngine（避免污染主画图层 / 历史）。
//
// API:
//   new PaletteWindow({ root, onColorSampled, getCurrentColor })
//     onColorSampled(hex): 吸色时回调，通常 setColor 主画
//     getCurrentColor(): 拿当前主色用于"刷"模式
//   .open() / .close() / .isOpen()
//   .setMode("brush" | "smudge" | "picker")
//   .clear()
//   .getSerializedState() / .applySerializedState(s)  ← 持久化 to webpaint/state.json

const CANVAS_SIZE = 256;

export class PaletteWindow {
  constructor({ root, onColorSampled, getCurrentColor }) {
    this.root = root;
    this.onColorSampled = onColorSampled;
    this.getCurrentColor = getCurrentColor || (() => "#000");
    this.canvas = root.querySelector(".palette-canvas");
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext("2d");
    this._fillBackground();
    this.mode = "brush";
    this._open = root.classList.contains("hidden") ? false : true;
    this._wireEvents();
    this._wireToolButtons();
    this._wireDrag();
  }

  _fillBackground() {
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }
  clear() { this._fillBackground(); }

  open() { this.root.classList.remove("hidden"); this._open = true; }
  close() { this.root.classList.add("hidden"); this._open = false; }
  toggle() { this._open ? this.close() : this.open(); }
  isOpen() { return this._open; }

  setMode(m) {
    if (m !== "brush" && m !== "smudge" && m !== "picker") return;
    this.mode = m;
    this._refreshToolButtons();
  }

  _refreshToolButtons() {
    for (const b of this.root.querySelectorAll(".palette-tool")) {
      b.setAttribute("aria-pressed", b.dataset.paletteTool === this.mode ? "true" : "false");
    }
  }

  _wireToolButtons() {
    for (const b of this.root.querySelectorAll(".palette-tool")) {
      b.addEventListener("click", () => this.setMode(b.dataset.paletteTool));
    }
    const clearBtn = this.root.querySelector(".palette-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => this.clear());
    const closeBtn = this.root.querySelector(".palette-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this.close());
    this._refreshToolButtons();
  }

  _toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * CANVAS_SIZE,
      y: ((e.clientY - r.top) / r.height) * CANVAS_SIZE,
    };
  }
  _sample(x, y) {
    const ix = Math.max(0, Math.min(CANVAS_SIZE - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(CANVAS_SIZE - 1, Math.floor(y)));
    const d = this.ctx.getImageData(ix, iy, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }
  _toHex({ r, g, b }) {
    return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, v|0)).toString(16).padStart(2, "0")).join("");
  }

  _wireEvents() {
    let active = false, lastX = 0, lastY = 0, loaded = null;
    const onDown = (e) => {
      e.stopPropagation();
      this.canvas.setPointerCapture(e.pointerId);
      const { x, y } = this._toLocal(e);
      if (this.mode === "picker") { this.onColorSampled(this._toHex(this._sample(x, y))); return; }
      active = true; lastX = x; lastY = y;
      if (this.mode === "smudge") loaded = this._sample(x, y);
      this._paint(x, y, loaded);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!active) return;
      const { x, y } = this._toLocal(e);
      const dx = x - lastX, dy = y - lastY;
      const L = Math.hypot(dx, dy);
      const step = 3;
      if (L > step) {
        const n = Math.ceil(L / step);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          this._paint(lastX + dx * t, lastY + dy * t, loaded);
        }
        lastX = x; lastY = y;
      } else {
        this._paint(x, y, loaded);
        lastX = x; lastY = y;
      }
    };
    const onUp = (e) => { active = false; loaded = null; e?.stopPropagation?.(); };
    this.canvas.addEventListener("pointerdown", onDown);
    this.canvas.addEventListener("pointermove", onMove);
    this.canvas.addEventListener("pointerup", onUp);
    this.canvas.addEventListener("pointercancel", onUp);
    this.canvas.addEventListener("pointerleave", () => { /* keep active during fast drag */ });
  }

  _paint(x, y, loaded) {
    const ctx = this.ctx;
    if (this.mode === "brush") {
      ctx.fillStyle = this.getCurrentColor();
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.mode === "smudge" && loaded) {
      const cur = this._sample(x, y);
      const strength = 0.85, dryness = 0.05;
      const out = {
        r: loaded.r * strength + cur.r * (1 - strength),
        g: loaded.g * strength + cur.g * (1 - strength),
        b: loaded.b * strength + cur.b * (1 - strength),
      };
      ctx.fillStyle = `rgb(${out.r|0},${out.g|0},${out.b|0})`;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      loaded.r = loaded.r * (1 - dryness) + cur.r * dryness;
      loaded.g = loaded.g * (1 - dryness) + cur.g * dryness;
      loaded.b = loaded.b * (1 - dryness) + cur.b * dryness;
    }
  }

  _wireDrag() {
    const head = this.root.querySelector(".palette-head");
    if (!head) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = this.root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.root.style.left = (ox + (e.clientX - sx)) + "px";
      this.root.style.top  = (oy + (e.clientY - sy)) + "px";
      this.root.style.right = "auto";
      this.root.style.bottom = "auto";
    });
    head.addEventListener("pointerup", () => { dragging = false; });
  }

  // serialize：保存 canvas 内容（toDataURL b64）+ 窗口位置
  getSerializedState() {
    try {
      return {
        open: this._open,
        mode: this.mode,
        imageB64: this.canvas.toDataURL("image/png"),
        position: this.root.style.left ? { left: this.root.style.left, top: this.root.style.top } : null,
      };
    } catch (_) { return null; }
  }
  applySerializedState(s) {
    if (!s) return;
    if (s.mode) this.setMode(s.mode);
    if (s.position) {
      this.root.style.left = s.position.left;
      this.root.style.top = s.position.top;
      this.root.style.right = "auto";
      this.root.style.bottom = "auto";
    }
    if (s.imageB64) {
      const img = new Image();
      img.onload = () => { this.ctx.clearRect(0,0,CANVAS_SIZE,CANVAS_SIZE); this.ctx.drawImage(img, 0, 0); };
      img.src = s.imageB64;
    }
    if (s.open) this.open(); else this.close();
  }
}
