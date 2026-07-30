// 1D ramp slider（UI 深模块，v0.7.8）——自绘横向滑块 DOM 工厂，替代原生 <input type=range>。
//
// 动机：原生 range 做不了 shift 细调（指针动、值慢动）；track 渐变（color ramp）要靠一堆
// 浏览器前缀伪元素 hack。这里自绘 track+thumb，拖动走 drag-value 拖动核（capture 兜底 +
// shift 相对累积一次做对），渐变就是普通 background。
//
// 消费者：filters.ts makeSliderRow（adjust 系全部滑块）经此升级；色轮 hue 条在 Vue 组件内
// 直接用 drag-value 核（同一行为，渲染归 Vue）。左栏 dial / 图层不透明度 / 笔刷设置 ~20 条
// 后续批次迁移（коalescing commit 钩子 onCommit 已备好）。
//
// 无障碍：role=slider + tabindex，←→↑↓ = ±step，PageUp/Down = ±10 step，Home/End = 端点。

import { attachDragValue } from "./drag-value.ts";

export interface RampSliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (v: number) => void;
  /** 拖动/键盘一次调整结束（coalescing history 用）。 */
  onCommit?: (v: number) => void;
  fmt?: (v: number) => string;
  /** track 的 CSS background（color ramp）。缺省 = 素色 track。 */
  gradient?: string;
  ariaLabel?: string;
}

export interface RampSliderHandle {
  el: HTMLLabelElement;
  get(): number;
  set(v: number): void;   // 外部回灌（不触发 onInput）
  dispose(): void;
}

export function makeRampSlider(o: RampSliderOpts): RampSliderHandle {
  const decimals = Math.max(0, -Math.floor(Math.log10(o.step || 1) + 1e-9));
  const quantize = (v: number): number => {
    const q = o.min + Math.round((v - o.min) / o.step) * o.step;
    const c = Math.min(o.max, Math.max(o.min, q));
    return parseFloat(c.toFixed(decimals));   // 洗浮点渣（0.30000000000000004）
  };
  let cur = quantize(o.value);

  const wrap = document.createElement("label");
  wrap.className = "brush-slider-row";
  wrap.innerHTML = `<span class="brush-slider-label"></span>` +
    `<div class="ramp-slider" role="slider" tabindex="0"><div class="ramp-slider-thumb"></div></div>` +
    `<span class="brush-slider-value"></span>`;
  (wrap.querySelector(".brush-slider-label") as HTMLElement).textContent = o.label;
  const track = wrap.querySelector(".ramp-slider") as HTMLElement;
  const thumb = wrap.querySelector(".ramp-slider-thumb") as HTMLElement;
  const valEl = wrap.querySelector(".brush-slider-value") as HTMLElement;
  if (o.gradient) { track.style.background = o.gradient; track.classList.add("color-ramp"); }
  track.setAttribute("aria-label", o.ariaLabel || o.label);
  track.setAttribute("aria-valuemin", String(o.min));
  track.setAttribute("aria-valuemax", String(o.max));

  const render = () => {
    const n = (cur - o.min) / (o.max - o.min || 1);
    thumb.style.left = (n * 100) + "%";
    valEl.textContent = o.fmt ? o.fmt(cur) : String(cur);
    track.setAttribute("aria-valuenow", String(cur));
  };
  render();

  const apply = (v: number, fire: boolean) => {
    const q = quantize(v);
    if (q === cur) return;
    cur = q;
    render();
    if (fire) o.onInput(cur);
  };

  const drag = attachDragValue(track, {
    getValue: () => ({ x: (cur - o.min) / (o.max - o.min || 1), y: 0 }),
    onDrag: (x) => apply(o.min + x * (o.max - o.min), true),
    onCommit: () => o.onCommit?.(cur),
  });

  track.addEventListener("keydown", (e: KeyboardEvent) => {
    let d = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -o.step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") d = o.step;
    else if (e.key === "PageDown") d = -o.step * 10;
    else if (e.key === "PageUp") d = o.step * 10;
    else if (e.key === "Home") { apply(o.min, true); o.onCommit?.(cur); e.preventDefault(); return; }
    else if (e.key === "End") { apply(o.max, true); o.onCommit?.(cur); e.preventDefault(); return; }
    else return;
    apply(cur + d, true);
    o.onCommit?.(cur);
    e.preventDefault();
  });

  return {
    el: wrap,
    get: () => cur,
    set(v: number) { cur = quantize(v); render(); },
    dispose() { drag.dispose(); },
  };
}
