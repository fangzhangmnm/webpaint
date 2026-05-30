// v131 (user：「Filter 抽象成接口，插件可以使用」)
// v132 (user：「pre-alpha 不怕 refactor，所有 color adjustment 做成第一方默认安装的插件」)
//
// Filter 平台：base contract + registry + 共享 helper。
// 第一方插件在 src/plugins/，import 自己注册。
// 后期下载插件：fetch script → new Function / dynamic import → 同样调 registerFilter
//
// ============= Filter 契约 =============
// 一个 Filter = 一个 ES class，全 static：
//
//   static id           : 唯一 string（菜单 / history 用）
//   static title        : 中文显示名
//   static category     : "adjustment" / "artist" / "liquify" / ...（菜单分组，预留）
//                          v132 都是 "adjustment"，未来 "artist" plug-in 走插件下载
//   static modes        : ["region"] / ["region","brush"] / ["brush"]
//                          region = 整层 / 选区一次性烤
//                          brush  = 笔刷输入（每 stamp 触发，按 brushAlpha 局部混合）—— v132+
//   static bleedRadius(params) : 输出一个像素最多读输入 ±N 邻域（non-local 用）
//                                per-pixel filter 返 0
//                                brush 模式 runtime 用它 padding stamp bbox（region 不需要）
//   static defaults()   : 返参数初始值对象
//   static buildBody(container, state, onChange) :
//     在 container 里建 DOM。改 state.params 后调 onChange() 触发预览。
//     插件可放任何 UI——slider、色环、canvas、color ramp 等。
//   static bake(srcData, dstData, params, mask, w, h) :
//     纯函数 src→dst（同尺寸）。mask=null 时全图，mask = Uint8ClampedArray，
//     mask[i*4+3] = alpha；< 128 时该像素 passthrough。
//
// ============= 插件加载（future）=============
// window.WebPaint.registerFilter(MyFilterClass) — 暴露在 app.js 末尾
// onFilterRegistered(fn) — 监听新 filter，菜单自动加入口
// 下载插件接口：[docs/backlog.md] AI 远程 / 本地 WASM 段落

const _filters = new Map();
const _listeners = new Set();

export function registerFilter(FilterClass) {
  if (!FilterClass || !FilterClass.id) {
    throw new Error("Filter 必须有 static id");
  }
  _filters.set(FilterClass.id, FilterClass);
  for (const fn of _listeners) {
    try { fn(FilterClass); } catch (e) { console.warn("[filter listener]", e); }
  }
}

export function getFilter(id) {
  return _filters.get(id) || null;
}

export function listFilters() {
  return [..._filters.values()];
}

// 监听新 filter 注册；菜单 lazy 渲染 / 插件加载后自动出现入口
export function onFilterRegistered(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ============= 共享 helper =============

export function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// 一行 slider row：label + range + 数字
//   onChange(key, value) 在 input 时触发
//   fmt(value) 可选格式化数字显示
//   gradient 可选 CSS background（color ramp slider）
export function makeSliderRow(label, key, min, max, step, init, onChange, opts = {}) {
  const { fmt, gradient } = opts;
  const wrap = document.createElement("label");
  wrap.className = "brush-slider-row";
  wrap.innerHTML = `<span class="brush-slider-label">${label}</span>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${init}" />` +
    `<span class="brush-slider-value"></span>`;
  const input = wrap.querySelector("input");
  if (gradient) {
    // v132 修：input 默认 track 盖了 background；要 .color-ramp class 切自定义 track
    input.style.background = gradient;
    input.classList.add("color-ramp");
  }
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

export function makeSectionTitle(text) {
  const d = document.createElement("div");
  d.className = "adjust-section-title";
  d.textContent = text;
  return d;
}

// ============= 「色彩转换」brush 模式 helper =============
//
// blur / sharpen / 未来 mosaic-brush / color-shift-brush 这种 "src → dst" 类 filter
// 共用一套 brush 行为：spacing 控的 stamp 序列 + 圆形 stamp alpha + 选区 mask + blend
//
// Filter 用法：
//   class BlurFilter {
//     static bake(...) { ... }
//     static bleedRadius(p) { ... }
//   }
//   attachColorBrushBehavior(BlurFilter);
//   // 之后 BlurFilter.beginBrushStroke/extendBrushStamp/endBrushStroke/flushDirty 都有了
//
// 跟 liquify（位移场）那种 filter 不同；位移场 filter 自己写完整 brush 方法。
export function attachColorBrushBehavior(FilterClass) {
  FilterClass.beginBrushStroke = function(layer, params, brushSettings, selection, x, y, p) {
    const state = {
      layer, params, brushSettings, selection, FilterClass,
      lastX: x, lastY: y, pendingDist: 0, dirty: null,
    };
    _colorBrushStamp(state, x, y, p);
    return state;
  };
  FilterClass.extendBrushStamp = function(state, x, y, p) {
    const dx = x - state.lastX, dy = y - state.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return;
    const bs = state.brushSettings;
    const R = Math.max(2, bs.size / 2);
    const spacingPx = Math.max(1, R * 2 * (bs.spacingValue || 0.06));
    state.pendingDist += dist;
    if (state.pendingDist < spacingPx) {
      state.lastX = x; state.lastY = y;
      return;
    }
    const ux = dx / dist, uy = dy / dist;
    let placedDist = spacingPx - (state.pendingDist - dist);
    while (placedDist <= dist) {
      _colorBrushStamp(state, state.lastX + ux * placedDist, state.lastY + uy * placedDist, p);
      placedDist += spacingPx;
    }
    state.pendingDist = dist - (placedDist - spacingPx);
    state.lastX = x; state.lastY = y;
  };
  FilterClass.endBrushStroke = function(_state) { /* nothing */ };
  FilterClass.flushDirty = function(state) {
    const d = state.dirty;
    state.dirty = null;
    return d;
  };
}

// 单 stamp 内的工作：读 layer 像素 → filter.bake → 圆形 alpha + 选区 → 合回 layer
function _colorBrushStamp(state, cx, cy, pressure) {
  const { layer, FilterClass, params, brushSettings, selection } = state;
  const R = Math.max(2, brushSettings.size / 2 * (pressure ?? 1));
  const hardness = brushSettings.hardness ?? 0.6;
  const bx0 = Math.floor(cx - R), by0 = Math.floor(cy - R);
  const bx1 = Math.ceil(cx + R),  by1 = Math.ceil(cy + R);
  // clamp 到 layer.bbox（filter brush 不扩层 —— 没像素就不处理）
  const lx0 = layer.bboxX, ly0 = layer.bboxY;
  const lx1 = lx0 + layer.bboxW, ly1 = ly0 + layer.bboxH;
  const sx0 = Math.max(bx0, lx0), sy0 = Math.max(by0, ly0);
  const sx1 = Math.min(bx1, lx1), sy1 = Math.min(by1, ly1);
  if (sx1 <= sx0 || sy1 <= sy0) return;
  const bleed = FilterClass.bleedRadius ? FilterClass.bleedRadius(params) : 0;
  const ex0 = Math.max(lx0, sx0 - bleed), ey0 = Math.max(ly0, sy0 - bleed);
  const ex1 = Math.min(lx1, sx1 + bleed), ey1 = Math.min(ly1, sy1 + bleed);
  const ew = ex1 - ex0, eh = ey1 - ey0;
  if (ew <= 0 || eh <= 0) return;
  const srcImg = layer.ctx.getImageData(ex0 - lx0, ey0 - ly0, ew, eh);
  const dstImg = new ImageData(ew, eh);
  FilterClass.bake(srcImg.data, dstImg.data, params, null, ew, eh);
  const ox = sx0 - ex0, oy = sy0 - ey0;
  const sw = sx1 - sx0, sh = sy1 - sy0;
  let selData = null;
  if (selection) {
    const sc = document.createElement("canvas");
    sc.width = sw; sc.height = sh;
    const sctx = sc.getContext("2d");
    sctx.drawImage(selection.maskCanvas, selection.bboxX - sx0, selection.bboxY - sy0);
    selData = sctx.getImageData(0, 0, sw, sh).data;
  }
  const layerImg = layer.ctx.getImageData(sx0 - lx0, sy0 - ly0, sw, sh);
  const layerData = layerImg.data;
  const flow = Math.max(0, Math.min(1, brushSettings.flow ?? brushSettings.opacity ?? 1));
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const px = sx0 + i, py = sy0 + j;
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > R) continue;
      const innerR = R * hardness;
      let stampA;
      if (dist <= innerR) stampA = 1;
      else {
        const t = (dist - innerR) / (R - innerR);
        stampA = 1 - (t * t * (3 - 2 * t));
      }
      let a = stampA * flow;
      if (selData) a *= selData[(j * sw + i) * 4 + 3] / 255;
      if (a <= 0) continue;
      const lo = (j * sw + i) * 4;
      const fo = ((j + oy) * ew + (i + ox)) * 4;
      layerData[lo]     = layerData[lo]     * (1 - a) + dstImg.data[fo]     * a;
      layerData[lo + 1] = layerData[lo + 1] * (1 - a) + dstImg.data[fo + 1] * a;
      layerData[lo + 2] = layerData[lo + 2] * (1 - a) + dstImg.data[fo + 2] * a;
      layerData[lo + 3] = layerData[lo + 3] * (1 - a) + dstImg.data[fo + 3] * a;
    }
  }
  layer.ctx.putImageData(layerImg, sx0 - lx0, sy0 - ly0);
  const d = state.dirty;
  if (!d) state.dirty = [sx0, sy0, sx1, sy1];
  else {
    d[0] = Math.min(d[0], sx0);
    d[1] = Math.min(d[1], sy0);
    d[2] = Math.max(d[2], sx1);
    d[3] = Math.max(d[3], sy1);
  }
}

// 给插件 / 自定义 UI 用：返回一个 `<select>` row
export function makeSelectRow(label, key, options, init, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "brush-slider-row";
  wrap.innerHTML = `<span class="brush-slider-label">${label}</span>` +
    `<select style="flex:1; font:inherit; padding:2px 4px;">` +
    options.map((o) => `<option value="${o.value}"${o.value === init ? " selected" : ""}>${o.label}</option>`).join("") +
    `</select><span class="brush-slider-value" style="min-width:0"></span>`;
  const sel = wrap.querySelector("select");
  sel.addEventListener("change", () => onChange(key, sel.value));
  return wrap;
}
