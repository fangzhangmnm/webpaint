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
//     纯函数 src→dst（同尺寸）。mask=null 时全图，mask = gray8 Uint8Array（v0.4.6：
//     Selection.materializeMaskRegion 窄读口产物），mask[i] < 128 时该像素 passthrough。
//
// ============= 插件加载（future）=============
// window.WeebPaint.registerFilter(MyFilterClass) — 暴露在 app.js 末尾
// onFilterRegistered(fn) — 监听新 filter，菜单自动加入口
// 下载插件接口：[ai-docs/20260528-backlog.md] AI 远程 / 本地 WASM 段落

// registry 原语共享自 registry.js（candidate 2：filter 与 exporter 同一道接缝）。
import { makeRegistry } from "./registry.ts";
import { makeRampSlider } from "./ui/ramp-slider.ts";

// ============= Filter 契约（TS 化）=============
// 一个 Filter = 一个全 static 的 ES class。下面是其类型契约——消费侧
// （filters-adjust.ts、plugins/*）依赖此形状。runtime brush 方法
// （attachColorBrushBehavior 注入）是可选的。
// C8：region filter 的纯计算面（bake/defaults/bleedRadius）析出 backend/filters/（filter 档口
// 的 kernel 域）——FilterParams/clamp8 的 SSoT 在那边，这里 re-export 保存量 import 路径。

export type { FilterParams } from "./backend/filters/kernel.ts";
import type { FilterParams } from "./backend/filters/kernel.ts";
export { clamp8 } from "./backend/filters/kernel.ts";

// region filter bake：纯函数 src→dst（同尺寸）。mask=null 全图。
export interface Filter {
  id: string;
  title: string;
  category?: string;
  modes?: string[];
  bleedRadius?(params: FilterParams): number;
  defaults?(): FilterParams;
  buildBody?(container: HTMLElement, state: unknown, onChange: () => void): void;
  bake(
    srcData: Uint8ClampedArray,
    dstData: Uint8ClampedArray,
    params: FilterParams,
    mask: Uint8Array | null,
    w: number,
    h: number,
  ): void;
  // attachColorBrushBehavior 注入的 runtime brush 方法（color-brush 类 filter）
  beginBrushStroke?(
    layer: BrushLayer,
    params: FilterParams,
    brushSettings: BrushSettings,
    selection: BrushSelection | null,
    x: number,
    y: number,
    p: number,
  ): ColorBrushState;
  extendBrushStamp?(state: ColorBrushState, x: number, y: number, p: number): void;
  endBrushStroke?(state: ColorBrushState): void;
  flushDirty?(state: ColorBrushState): DirtyRect | null;
}

// color-brush 行为操作的层读写面（ViewLeaf/StrokeShadow 同形——C6 起引擎写靶可能是替身叶）。
export interface BrushLayer {
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  getImageData(docX: number, docY: number, w: number, h: number): ImageData;
  putImageData(docX: number, docY: number, img: ImageData): void;
}

export interface BrushSettings {
  size: number;
  spacingValue?: number;
  hardness?: number;
  flow?: number;
  opacity?: number;
}

export interface BrushSelection {
  bboxX: number;
  bboxY: number;
  materializeMaskRegion(x0: number, y0: number, w: number, h: number): Uint8Array;   // gray8 窄读口（selection.ts）
}

export type DirtyRect = [number, number, number, number];

// 单 stroke 的可变状态（beginBrushStroke 返回，后续方法读写）。
export interface ColorBrushState {
  layer: BrushLayer;
  params: FilterParams;
  brushSettings: BrushSettings;
  selection: BrushSelection | null;
  FilterClass: Filter;
  lastX: number;
  lastY: number;
  pendingDist: number;
  dirty: DirtyRect | null;
}

const _reg = makeRegistry<Filter>({ name: "filter" });

export function registerFilter(FilterClass: Filter): void {
  if (!FilterClass || !FilterClass.id) {
    throw new Error("Filter must have a static id");
  }
  _reg.register(FilterClass);
}

export function getFilter(id: string): Filter | null {
  return _reg.get(id);
}

export function listFilters(): Filter[] {
  return _reg.list();
}

// 监听新 filter 注册；菜单 lazy 渲染 / 插件加载后自动出现入口
export function onFilterRegistered(fn: (item: Filter) => void): () => void {
  return _reg.onRegistered(fn);
}

// ============= 共享 helper =============

// 一行 slider row：label + 滑块 + 数字
//   onChange(key, value) 在 input 时触发
//   fmt(value) 可选格式化数字显示
//   gradient 可选 CSS background（color ramp slider）
// v0.7.8：内部从原生 range 换 ui/ramp-slider 深模块（自绘 track+thumb，drag-value 拖动核）——
//   全部 adjust 滑块一次性获得 shift 细调（指针动、值慢动）；签名/返回不变，消费者零改动。
export interface SliderRowOpts {
  fmt?: (value: number) => string;
  gradient?: string;
}

export function makeSliderRow(
  label: string,
  key: string,
  min: number,
  max: number,
  step: number,
  init: number,
  onChange: (key: string, value: number) => void,
  opts: SliderRowOpts = {},
): HTMLLabelElement {
  return makeRampSlider({
    label, min, max, step, value: init,
    fmt: opts.fmt, gradient: opts.gradient,
    onInput: (v) => onChange(key, v),
  }).el;
}

export function makeSectionTitle(text: string): HTMLDivElement {
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
export function attachColorBrushBehavior(FilterClass: Filter): void {
  FilterClass.beginBrushStroke = function(layer: BrushLayer, params: FilterParams, brushSettings: BrushSettings, selection: BrushSelection | null, x: number, y: number, p: number): ColorBrushState {
    const state: ColorBrushState = {
      layer, params, brushSettings, selection, FilterClass,
      lastX: x, lastY: y, pendingDist: 0, dirty: null,
    };
    _colorBrushStamp(state, x, y, p);
    return state;
  };
  FilterClass.extendBrushStamp = function(state: ColorBrushState, x: number, y: number, p: number): void {
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
  FilterClass.endBrushStroke = function(_state: ColorBrushState): void { /* nothing */ };
  FilterClass.flushDirty = function(state: ColorBrushState): DirtyRect | null {
    const d = state.dirty;
    state.dirty = null;
    return d;
  };
}

// 单 stamp 内的工作：读 layer 像素 → filter.bake → 圆形 alpha + 选区 → 合回 layer
function _colorBrushStamp(state: ColorBrushState, cx: number, cy: number, pressure: number): void {
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
  const srcImg = layer.getImageData(ex0, ey0, ew, eh);   // doc 坐标读（绕物化 canvas）
  const dstImg = new ImageData(ew, eh);
  FilterClass.bake(srcImg.data, dstImg.data, params, null, ew, eh);
  const ox = sx0 - ex0, oy = sy0 - ey0;
  const sw = sx1 - sx0, sh = sy1 - sy0;
  let selData: Uint8Array | null = null;
  if (selection) selData = selection.materializeMaskRegion(sx0, sy0, sw, sh);   // v0.4.6：gray8 窄读，canvas 中转死
  const layerImg = layer.getImageData(sx0, sy0, sw, sh);
  const layerData = layerImg.data;
  const flow = Math.max(0, Math.min(1, brushSettings.flow ?? brushSettings.opacity ?? 1));
  let blended = false;   // v0.6.17：一个像素都没混过（选区全裁/flow=0）→ 跳过写回，免得同字节换新 tile 句柄骗过 no-op 守卫
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
      if (selData) a *= selData[j * sw + i] / 255;
      if (a <= 0) continue;
      blended = true;
      const lo = (j * sw + i) * 4;
      const fo = ((j + oy) * ew + (i + ox)) * 4;
      layerData[lo]     = layerData[lo]     * (1 - a) + dstImg.data[fo]     * a;
      layerData[lo + 1] = layerData[lo + 1] * (1 - a) + dstImg.data[fo + 1] * a;
      layerData[lo + 2] = layerData[lo + 2] * (1 - a) + dstImg.data[fo + 2] * a;
      layerData[lo + 3] = layerData[lo + 3] * (1 - a) + dstImg.data[fo + 3] * a;
    }
  }
  if (!blended) return;   // 零像素混合 → 不写回、不标 dirty（见上）
  layer.putImageData(sx0, sy0, layerImg);   // doc 坐标写回 tile
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
export interface SelectOption {
  value: string;
  label: string;
}

export function makeSelectRow(
  label: string,
  key: string,
  options: SelectOption[],
  init: string,
  onChange: (key: string, value: string) => void,
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "brush-slider-row";
  wrap.innerHTML = `<span class="brush-slider-label">${label}</span>` +
    `<select style="flex:1; font:inherit; padding:2px 4px;">` +
    options.map((o) => `<option value="${o.value}"${o.value === init ? " selected" : ""}>${o.label}</option>`).join("") +
    `</select><span class="brush-slider-value" style="min-width:0"></span>`;
  const sel = wrap.querySelector("select")!;
  sel.addEventListener("change", () => onChange(key, sel.value));
  return wrap;
}
