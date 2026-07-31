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

// ---- v0.7.22 分段步长表（brush-size.ts 精神的泛化；user 拍板：容差滑条走分段不走连续 sqrt/log）----
// 位置空间 = 档位索引（每档等宽触面）：构造性保证无死区、无够不着的值、值恒是规格里的整数。
// 纯函数无 DOM（node 直测）；将来笔刷 size slider 迁移 = 把 brush-size 的段表喂进来（test 有互证）。
export interface RampSeg { upTo: number; step: number }

/** 段表 → 档位值序列（含 min 起点；各段 (prev, upTo] 按 step 出档）。 */
export function segValueTable(min: number, segs: RampSeg[]): number[] {
  const vals: number[] = [min];
  let prev = min;
  for (const s of segs) {
    for (let v = prev + s.step; v <= s.upTo + 1e-9; v += s.step) vals.push(parseFloat(v.toFixed(6)));
    prev = s.upTo;
  }
  return vals;
}

/** 最近档位索引（值→位置回灌；表短，线性扫够了）。 */
export function nearestSegPos(vals: number[], v: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < vals.length; i++) {
    const d = Math.abs(vals[i] - v);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

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
  /** v0.7.22 分段步长模式：设了则位置空间=档位索引（step 忽略，键盘=±1 档）。min 是起点，
      段表须覆盖到 max。低端细高端粗的量（容差/笔粗）用这个，别用连续曲线（量化后必出死区/跳档）。 */
  segments?: RampSeg[];
}

export interface RampSliderHandle {
  el: HTMLLabelElement;
  get(): number;
  set(v: number): void;   // 外部回灌（不触发 onInput）
  dispose(): void;
}

export function makeRampSlider(o: RampSliderOpts): RampSliderHandle {
  const decimals = Math.max(0, -Math.floor(Math.log10(o.step || 1) + 1e-9));
  // 分段模式：量化=吸最近档；位置=档位索引/(档数-1)。连续模式：老路径原样。
  const table = o.segments ? segValueTable(o.min, o.segments) : null;
  const quantize = (v: number): number => {
    if (table) return table[nearestSegPos(table, v)];
    const q = o.min + Math.round((v - o.min) / o.step) * o.step;
    const c = Math.min(o.max, Math.max(o.min, q));
    return parseFloat(c.toFixed(decimals));   // 洗浮点渣（0.30000000000000004）
  };
  const toNorm = (v: number): number =>
    table ? nearestSegPos(table, v) / (table.length - 1 || 1) : (v - o.min) / (o.max - o.min || 1);
  const fromNorm = (n: number): number =>
    table ? table[Math.round(n * (table.length - 1))] : o.min + n * (o.max - o.min);
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
    const n = toNorm(cur);
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
    getValue: () => ({ x: toNorm(cur), y: 0 }),
    onDrag: (x) => apply(fromNorm(x), true),
    onCommit: () => o.onCommit?.(cur),
  });

  // 键盘：分段模式 = ±1 档（步长随档位表走，语义与拖动一致）；连续模式 = ±step 老路径。
  const nudge = (dir: number, big: boolean): number => {
    if (!table) return cur + dir * o.step * (big ? 10 : 1);
    const i = nearestSegPos(table, cur) + dir * (big ? 5 : 1);
    return table[Math.max(0, Math.min(table.length - 1, i))];
  };
  track.addEventListener("keydown", (e: KeyboardEvent) => {
    let next: number;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = nudge(-1, false);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = nudge(+1, false);
    else if (e.key === "PageDown") next = nudge(-1, true);
    else if (e.key === "PageUp") next = nudge(+1, true);
    else if (e.key === "Home") next = o.min;
    else if (e.key === "End") next = o.max;
    else return;
    apply(next, true);
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
