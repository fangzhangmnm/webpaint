// v131 (user：「Filter 抽象成接口，插件可以使用」)
//
// 调色 / 图像滤镜的统一接口。built-in 滤镜（HSB、色彩平衡、Curves、锐化模糊）
// 都实现 Filter；plugin 通过 registerFilter(...) 接入。
//
// 接口契约：
//   - id: 唯一 string 标识（菜单项 id、history entry 用）
//   - title: 中文显示名
//   - modes: ["region"] / ["brush"] / ["region","brush"]，声明支持的应用模式
//       region = 整层 / 选区一次性烤（v131 这版）
//       brush  = 笔刷输入（每 stamp 触发，按 brushAlpha 局部混合）—— v132+ 计划
//   - bleedRadius(params): 输出某像素最多需要读输入 ±N 邻域像素（non-local 用）
//       per-pixel filter（HSB / Curves）= 0
//       3×3 box blur N 次迭代 = N
//       brush 模式 runtime 必须按这个 padding brush bbox 才能避免边缘 clamp 失真
//       region 整层模式不需要用（src 自然就是整层，边界即层边）
//   - defaults(): 返回参数初始值对象
//   - buildBody(container, state, onChange): 在 container 里建 DOM，
//     用户交互时改 state.params 并调 onChange()（触发预览）
//   - bake(srcData, dstData, params, mask, w, h):
//       逐像素把 src 算到 dst；mask=null 时全图，mask 是 Uint8ClampedArray（mask[i*4+3]=alpha）
//
// state 形状：
//   { active, params, beforeSnap, srcImg, surrogate, surCtx, maskData }
//   buildBody 不要碰 active / beforeSnap / srcImg，只关心 params。
//
// 插件注入示例（理论上）：
//   window.WebPaint.registerFilter(class MyFilter { ... });
//   然后 app.js 的菜单需要也加一个入口（未来加 plugin-menu 自动注册）

const _filters = new Map();

export function registerFilter(FilterClass) {
  if (!FilterClass || !FilterClass.id) {
    throw new Error("Filter 必须有 static id");
  }
  _filters.set(FilterClass.id, FilterClass);
}

export function getFilter(id) {
  return _filters.get(id) || null;
}

export function listFilters() {
  return [..._filters.values()];
}

// ---------- 工具 ----------

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

function row(label, key, min, max, step, init, onChange, fmt) {
  const wrap = document.createElement("label");
  wrap.className = "brush-slider-row";
  wrap.innerHTML = `<span class="brush-slider-label">${label}</span>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${init}" />` +
    `<span class="brush-slider-value"></span>`;
  const input = wrap.querySelector("input");
  const val = wrap.querySelector(".brush-slider-value");
  const update = (v) => { val.textContent = fmt ? fmt(v) : String(v); };
  update(init);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    update(v);
    onChange(key, v);
  });
  return wrap;
}

function sectionTitle(text) {
  const d = document.createElement("div");
  d.className = "adjust-section-title";
  d.textContent = text;
  return d;
}

// ============ HSB Filter (原 BCSH) ============

export class HsbFilter {
  static id = "hsb";
  static title = "色相饱和度 / 亮度对比";
  static menuId = "adjustColor";
  static modes = ["region"];
  static bleedRadius() { return 0; }    // per-pixel

  static defaults() {
    return { brightness: 0, contrast: 0, saturation: 0, hue: 0 };
  }

  static buildBody(container, state, onChange) {
    const set = (k, v) => { state.params[k] = v | 0; onChange(); };
    container.appendChild(row("亮度", "brightness", -100, 100, 1, state.params.brightness, set));
    container.appendChild(row("对比", "contrast",   -100, 100, 1, state.params.contrast,   set));
    container.appendChild(row("饱和", "saturation", -100, 100, 1, state.params.saturation, set));
    container.appendChild(row("色相", "hue",        -180, 180, 1, state.params.hue,        set, (v) => `${v|0}°`));
  }

  static bake(srcData, dstData, p, mask) {
    const b = 1 + (p.brightness / 100);
    const c = 1 + (p.contrast / 100);
    const sat = 1 + (p.saturation / 100);
    const hueRad = (p.hue | 0) * Math.PI / 180;
    const cosH = Math.cos(hueRad), sinH = Math.sin(hueRad);
    const lumR = 0.213, lumG = 0.715, lumB = 0.072;
    const m11 = lumR + cosH * (1 - lumR) + sinH * (-lumR);
    const m12 = lumG + cosH * (-lumG)    + sinH * (-lumG);
    const m13 = lumB + cosH * (-lumB)    + sinH * (1 - lumB);
    const m21 = lumR + cosH * (-lumR)    + sinH * 0.143;
    const m22 = lumG + cosH * (1 - lumG) + sinH * 0.140;
    const m23 = lumB + cosH * (-lumB)    + sinH * (-0.283);
    const m31 = lumR + cosH * (-lumR)    + sinH * (-(1 - lumR));
    const m32 = lumG + cosH * (-lumG)    + sinH * lumG;
    const m33 = lumB + cosH * (1 - lumB) + sinH * lumB;
    const useHue = p.hue !== 0;
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      let r = srcData[o], g = srcData[o+1], bl = srcData[o+2];
      r *= b; g *= b; bl *= b;
      r = (r - 128) * c + 128;
      g = (g - 128) * c + 128;
      bl = (bl - 128) * c + 128;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = luma + (r - luma) * sat;
      g = luma + (g - luma) * sat;
      bl = luma + (bl - luma) * sat;
      if (useHue) {
        const nr = r * m11 + g * m12 + bl * m13;
        const ng = r * m21 + g * m22 + bl * m23;
        const nb = r * m31 + g * m32 + bl * m33;
        r = nr; g = ng; bl = nb;
      }
      dstData[o]   = clamp8(r);
      dstData[o+1] = clamp8(g);
      dstData[o+2] = clamp8(bl);
      dstData[o+3] = srcData[o+3];
    }
  }
}

// ============ Color Balance（PS 风格 3 区 × 3 轴）============
//
// 3 区段：shadow / midtone / highlight，每区 3 个轴：青-红 / 品-绿 / 黄-蓝
// 每轴 -100..100。+100 加红/绿/蓝，-100 加青/品/黄。
// 区段权重按 luma 三段高斯：shadow 在 luma≈0 处峰值，mid 在 0.5，hi 在 1。

export class ColorBalanceFilter {
  static id = "colorBalance";
  static title = "色彩平衡";
  static menuId = "adjustColorBalance";
  static modes = ["region"];
  static bleedRadius() { return 0; }    // per-pixel

  static defaults() {
    return { shR: 0, shG: 0, shB: 0, mR: 0, mG: 0, mB: 0, hiR: 0, hiG: 0, hiB: 0 };
  }

  static buildBody(container, state, onChange) {
    const set = (k, v) => { state.params[k] = v | 0; onChange(); };
    const axisRows = (prefix) => {
      container.appendChild(row("青  ⟷  红", prefix + "R", -100, 100, 1, state.params[prefix + "R"], set));
      container.appendChild(row("品  ⟷  绿", prefix + "G", -100, 100, 1, state.params[prefix + "G"], set));
      container.appendChild(row("黄  ⟷  蓝", prefix + "B", -100, 100, 1, state.params[prefix + "B"], set));
    };
    container.appendChild(sectionTitle("阴影"));
    axisRows("sh");
    container.appendChild(sectionTitle("中间调"));
    axisRows("m");
    container.appendChild(sectionTitle("高光"));
    axisRows("hi");
  }

  static bake(srcData, dstData, p, mask) {
    // 三段 luma 权重函数（每段高斯 σ≈0.25，中心 0/0.5/1）
    // 预算 LUT[256] 三组权重避免每像素重算
    const wShadow = new Float32Array(256);
    const wMid    = new Float32Array(256);
    const wHi     = new Float32Array(256);
    const SIG2 = 2 * 0.25 * 0.25;
    for (let i = 0; i < 256; i++) {
      const l = i / 255;
      wShadow[i] = Math.exp(-(l - 0) * (l - 0) / SIG2);
      wMid[i]    = Math.exp(-(l - 0.5) * (l - 0.5) / SIG2);
      wHi[i]     = Math.exp(-(l - 1) * (l - 1) / SIG2);
    }
    const dR = (l) => (p.shR * wShadow[l] + p.mR * wMid[l] + p.hiR * wHi[l]) / 100 * 64;
    const dG = (l) => (p.shG * wShadow[l] + p.mG * wMid[l] + p.hiG * wHi[l]) / 100 * 64;
    const dB = (l) => (p.shB * wShadow[l] + p.mB * wMid[l] + p.hiB * wHi[l]) / 100 * 64;
    // delta LUT 预算（按 luma 0..255 索引）
    const dRLut = new Float32Array(256);
    const dGLut = new Float32Array(256);
    const dBLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      dRLut[i] = dR(i); dGLut[i] = dG(i); dBLut[i] = dB(i);
    }
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      const r = srcData[o], g = srcData[o+1], b = srcData[o+2];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
      const li = luma > 255 ? 255 : luma < 0 ? 0 : luma;
      dstData[o]   = clamp8(r + dRLut[li]);
      dstData[o+1] = clamp8(g + dGLut[li]);
      dstData[o+2] = clamp8(b + dBLut[li]);
      dstData[o+3] = srcData[o+3];
    }
  }
}

// ============ Curves（RGBA + 复合）============
//
// 5 个通道：复合 / R / G / B / A，每个一个 piecewise linear 曲线
// 曲线 = 排序后的 [x, y] 点数组，至少 2 个（默认两端 (0,0) (255,255)）
// 应用顺序（PS 一致）：复合 → 通道 R/G/B 各自 → A

export class CurvesFilter {
  static id = "curves";
  static title = "曲线";
  static menuId = "adjustCurves";
  static modes = ["region"];
  static bleedRadius() { return 0; }    // per-pixel（LUT）

  static defaults() {
    const id = () => [[0, 0], [255, 255]];
    return { active: "comp", comp: id(), r: id(), g: id(), b: id(), a: id() };
  }

  // 把点列 → 256-entry Uint8 LUT（分段线性）
  static _buildLut(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    const lut = new Uint8Array(256);
    let pi = 0;
    for (let x = 0; x < 256; x++) {
      while (pi < pts.length - 2 && x > pts[pi + 1][0]) pi++;
      const [x0, y0] = pts[pi];
      const [x1, y1] = pts[pi + 1] || pts[pi];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      const y = y0 + (y1 - y0) * t;
      lut[x] = clamp8(y);
    }
    return lut;
  }

  static buildBody(container, state, onChange) {
    container.innerHTML = "";
    // channel selector
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

    // canvas editor
    const SIZE = 224;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    canvas.className = "curves-canvas";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");

    function getActivePoints() { return state.params[state.params.active]; }
    function setActivePoints(pts) { state.params[state.params.active] = pts; }

    function toScreen(x, y) {
      return { sx: (x / 255) * SIZE, sy: SIZE - (y / 255) * SIZE };
    }
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
      // background grid
      ctx.fillStyle = "#1c1c1c";
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const p = (i / 4) * SIZE;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SIZE); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SIZE, p); ctx.stroke();
      }
      // diagonal identity
      ctx.strokeStyle = "#444";
      ctx.beginPath(); ctx.moveTo(0, SIZE); ctx.lineTo(SIZE, 0); ctx.stroke();
      // curve (LUT polyline)
      const lut = CurvesFilter._buildLut(getActivePoints());
      ctx.strokeStyle = chDef.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const { sx, sy } = toScreen(x, lut[x]);
        if (x === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      // points
      for (const [px, py] of getActivePoints()) {
        const { sx, sy } = toScreen(px, py);
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fillStyle = chDef.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // pointer interactions
    let dragIdx = -1;
    let longPressTimer = null;
    let downAt = null;
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const pts = getActivePoints();
      const HIT = 12;
      // 命中？
      let hit = -1;
      for (let i = 0; i < pts.length; i++) {
        const { sx: px, sy: py } = toScreen(pts[i][0], pts[i][1]);
        if ((sx - px) ** 2 + (sy - py) ** 2 < HIT * HIT) { hit = i; break; }
      }
      if (hit >= 0) {
        dragIdx = hit;
        // 长按删除（除两端）
        if (hit !== 0 && hit !== pts.length - 1) {
          longPressTimer = setTimeout(() => {
            const cur = getActivePoints();
            if (cur.length > 2) {
              cur.splice(hit, 1);
              setActivePoints(cur);
              onChange();
              draw();
            }
            dragIdx = -1;
          }, 500);
        }
      } else {
        // tap empty = 添加点
        const [dx, dy] = toData(sx, sy);
        const newPts = pts.slice();
        let ins = newPts.findIndex((p) => p[0] > dx);
        if (ins < 0) ins = newPts.length - 1;
        if (ins === 0) ins = 1;
        newPts.splice(ins, 0, [dx, dy]);
        setActivePoints(newPts);
        dragIdx = ins;
        onChange();
        draw();
      }
      downAt = { sx, sy };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (dragIdx < 0) return;
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (longPressTimer && downAt) {
        if ((sx - downAt.sx) ** 2 + (sy - downAt.sy) ** 2 > 16) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
      const pts = getActivePoints();
      const [dx, dy] = toData(sx, sy);
      // 端点只能动 y，不能改 x
      if (dragIdx === 0) pts[0] = [0, dy];
      else if (dragIdx === pts.length - 1) pts[pts.length - 1] = [255, dy];
      else {
        // 中间点 x 限制在前后邻居之间
        const xMin = pts[dragIdx - 1][0] + 1;
        const xMax = pts[dragIdx + 1][0] - 1;
        pts[dragIdx] = [Math.max(xMin, Math.min(xMax, dx)), dy];
      }
      onChange();
      draw();
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

// ============ Sharpen / Blur（双极）============
//
// 单一 slider -100..+100：负为模糊（box blur 半径成正比），正为锐化（unsharp mask 量）
// 0 = identity passthrough

export class SharpenBlurFilter {
  static id = "sharpenBlur";
  static title = "锐化 / 模糊";
  static menuId = "adjustSharpenBlur";
  static modes = ["region"];      // v132 加 "brush"（dodge/burn 风格局部锐化模糊）

  // bleed = 模糊 N 次 box 半径 = N（amt<0），或 unsharp 单次 box = 1（amt>0）
  // brush 模式 runtime 看这个 padding brush bbox
  static bleedRadius(p) {
    const amt = (p && p.amount) | 0;
    if (amt < 0) return Math.max(1, Math.min(10, Math.round(-amt / 10)));
    if (amt > 0) return 1;
    return 0;
  }

  static defaults() { return { amount: 0 }; }

  static buildBody(container, state, onChange) {
    container.appendChild(row("← 模糊      锐化 →", "amount", -100, 100, 1, state.params.amount, (k, v) => {
      state.params.amount = v | 0;
      onChange();
    }));
  }

  static bake(srcData, dstData, p, mask, w, h) {
    const amt = p.amount | 0;
    if (amt === 0) {
      dstData.set(srcData);
      return;
    }
    if (amt < 0) {
      // 模糊：3×3 box blur 迭代 N 次，N = round(-amt / 10) clamp 1..10
      const N = Math.max(1, Math.min(10, Math.round(-amt / 10)));
      let src = srcData;
      const tmp = new Uint8ClampedArray(srcData.length);
      let dst = tmp;
      for (let it = 0; it < N; it++) {
        SharpenBlurFilter._boxBlur3(src, dst, w, h, mask);
        [src, dst] = [dst, src];
      }
      // src 当前是最后写入。若 N 是偶数 src=tmp，奇数 src=输入；目标 dstData 复制 src
      if (src !== dstData) dstData.set(src);
      return;
    }
    // 锐化：unsharp mask
    //   blurred = boxBlur(src)
    //   dst = src + amount/100 * (src - blurred)
    const blurred = new Uint8ClampedArray(srcData.length);
    SharpenBlurFilter._boxBlur3(srcData, blurred, w, h, null);  // 锐化时全图算 blur
    const k = amt / 100 * 2;       // -100..100 → -2..2 sharpen strength
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      dstData[o]   = clamp8(srcData[o]   + k * (srcData[o]   - blurred[o]));
      dstData[o+1] = clamp8(srcData[o+1] + k * (srcData[o+1] - blurred[o+1]));
      dstData[o+2] = clamp8(srcData[o+2] + k * (srcData[o+2] - blurred[o+2]));
      dstData[o+3] = srcData[o+3];
    }
  }

  // 3×3 box blur，clamp-to-edge
  static _boxBlur3(src, dst, w, h, mask) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (mask && mask[o + 3] < 128) {
          dst[o] = src[o]; dst[o+1] = src[o+1]; dst[o+2] = src[o+2]; dst[o+3] = src[o+3];
          continue;
        }
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
            const sy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
            const so = (sy * w + sx) * 4;
            r += src[so]; g += src[so+1]; b += src[so+2]; a += src[so+3];
          }
        }
        dst[o]   = (r / 9) | 0;
        dst[o+1] = (g / 9) | 0;
        dst[o+2] = (b / 9) | 0;
        dst[o+3] = (a / 9) | 0;
      }
    }
  }
}

// 注册 built-in 滤镜
registerFilter(HsbFilter);
registerFilter(ColorBalanceFilter);
registerFilter(CurvesFilter);
registerFilter(SharpenBlurFilter);
