// 色轮组件（UI 深化 candidate 1 · Vue pilot）。
//
// 这是「薄 Vue 外壳」：渲染 SV pad + 色相条 + HEX 输入 + 预览，把领域计算全部委托给
// color-model.ts 的纯函数。组件**唯一对外输出**是 emit("pick", hex)——印证勘探结论
// 「色轮只吐 set color」。输入只有 props.color（当前色）。drawing app 与色轮只经一个 color 值耦合。
//
// 工具链：vendor 的 vue.esm-browser.prod.js（含 template 编译器）→ esbuild 原样 bundle 进
// dist。无 SFC、无 CDN（合 vendor-everything 红线）。组件写在 .ts 里用 template 字符串。
//
// round-trip 不变式（保住旧 bug fix）：内部拖动 pad/hue 产生的 hex 回灌（props.color 变成
// 刚 emit 出去的值）**不**重新派生 HSV——否则低饱和/低明度处 hue 数学无定义，slider 跳回 0。
// 用 sameHex(incoming, lastEmitted) 判定「这是不是我刚吐出去的」。外部源（吸色/载图/HEX 输入）才 sync。

import {
  createApp, defineComponent, reactive, ref, computed, watch, onMounted,
} from "../../vendor/vue/vue.esm-browser.prod.js";
import { hsvToHex, hexToHsv, normalizeHex, sameHex } from "./color-model.ts";

export const ColorWheel = defineComponent({
  name: "ColorWheel",
  props: {
    color: { type: String, default: "#000000" },
  },
  emits: ["pick"],
  setup(props: { color: string }, { emit }: { emit: (e: "pick", hex: string) => void }) {
    const hsv = reactive(hexToHsv(props.color));
    const pad = ref<HTMLCanvasElement | null>(null);
    const hexText = ref(props.color);
    let lastEmitted: string | null = null;

    const hex = computed(() => hsvToHex(hsv.h, hsv.s, hsv.v));

    function draw() {
      const c = pad.value;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const w = c.width, h = c.height;
      // 横向 = saturation，纵向 = 1-value：hue 底色 + 水平白渐 + 垂直黑渐
      ctx.fillStyle = `hsl(${hsv.h} 100% 50%)`;
      ctx.fillRect(0, 0, w, h);
      const gx = ctx.createLinearGradient(0, 0, w, 0);
      gx.addColorStop(0, "rgba(255,255,255,1)");
      gx.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gx;
      ctx.fillRect(0, 0, w, h);
      const gy = ctx.createLinearGradient(0, 0, 0, h);
      gy.addColorStop(0, "rgba(0,0,0,0)");
      gy.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = gy;
      ctx.fillRect(0, 0, w, h);
      // marker
      const mx = hsv.s * w, my = (1 - hsv.v) * h;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
    }

    // 内部产生新色：更新预览/输入框 + 记 lastEmitted + 吐出去
    function commit() {
      const out = hex.value;
      hexText.value = out;
      lastEmitted = out;
      emit("pick", out);
    }

    // 外部色变更才 sync HSV（守 round-trip 不变式）
    watch(() => props.color, (next: string) => {
      hexText.value = next;
      if (sameHex(next, lastEmitted)) return;   // 这是我刚吐的回灌：不动 hue
      const d = hexToHsv(next);
      hsv.h = d.h; hsv.s = d.s; hsv.v = d.v;
      lastEmitted = next;
      draw();
    });

    watch(hsv, () => draw(), { flush: "post" });
    onMounted(draw);

    // ---- SV pad 拖动 ----
    let dragging = false;
    function padPick(e: PointerEvent) {
      const c = pad.value;
      if (!c) return;
      const r = c.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
      hsv.s = x / r.width;
      hsv.v = 1 - y / r.height;
      commit();
    }
    function padDown(e: PointerEvent) {
      dragging = true;
      pad.value?.setPointerCapture(e.pointerId);
      padPick(e);
    }
    function padMove(e: PointerEvent) { if (dragging) padPick(e); }
    function padUp() { dragging = false; }

    function onHue(e: Event) {
      hsv.h = parseFloat((e.target as HTMLInputElement).value);
      commit();
    }
    function onHex(e: Event) {
      const el = e.target as HTMLInputElement;
      const norm = normalizeHex(el.value);
      if (!norm) { el.value = props.color; return; }   // 非法：静默还原（组件不持 status）
      const d = hexToHsv(norm);
      hsv.h = d.h; hsv.s = d.s; hsv.v = d.v;
      commit();
    }

    return { pad, hsv, hex, hexText, padDown, padMove, padUp, onHue, onHex };
  },
  // 多根 = fragment：挂进 .float-panel-body 后三个节点成为它的直接 flex 子节点，
  // DOM 结构与原 index.html 一字不差（样式全 class-based，照旧生效）。
  template: `
    <canvas ref="pad" class="sv-pad" width="240" height="180" aria-label="饱和度 / 明度面板"
      @pointerdown="padDown" @pointermove="padMove" @pointerup="padUp" @pointercancel="padUp"></canvas>
    <input type="range" min="0" max="360" step="1" class="hue-slider" :value="hsv.h" @input="onHue" aria-label="色相" />
    <div class="picker-row">
      <span class="picker-preview" :style="{ background: hex }"></span>
      <input type="text" maxlength="9" :value="hexText" @change="onHex" aria-label="HEX" />
    </div>
  `,
});

// 挂载控制器：app 拿到 setColor（外部色推进来）+ unmount。
// color 用 ref 桥接 app 的命令式 state.color ⇄ 组件 reactive prop。
export interface ColorWheelHandle {
  setColor(hex: string): void;
  unmount(): void;
}

export function mountColorWheel(
  el: HTMLElement,
  opts: { getColor: () => string; onPick: (hex: string) => void },
): ColorWheelHandle {
  const color = ref(opts.getColor());
  const app = createApp(defineComponent({
    components: { ColorWheel },
    setup() {
      return { color, onPick: opts.onPick };
    },
    template: `<ColorWheel :color="color" @pick="onPick" />`,
  }));
  app.mount(el);
  return {
    setColor(hex: string) { color.value = hex; },
    unmount() { app.unmount(); },
  };
}
