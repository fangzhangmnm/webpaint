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
  createApp, defineComponent, reactive, ref, computed, watch, onMounted, onUnmounted,
} from "../../vendor/vue/vue.esm-browser.prod.js";
import { hsvToHex, hexToHsv, normalizeHex, sameHex } from "./color-model.ts";
import { parseColorName, searchColorNames, type ColorNameHit } from "../color-name.ts";
import { attachInputSense, type InputSenseHandle } from "./input-sense.ts";
import { attachDragValue, type DragValueHandle } from "./drag-value.ts";
import { t } from "../i18n/index.ts";

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

    // ---- SV pad / hue 条拖动（v0.7.8 收进 drag-value 拖动核）----
    // capture + buttons 兜底 + shift 细调（相对累积、指示器独立于光标）全在核里；
    // 这里只做归一化值 ↔ HSV 映射。round-trip 不变式不受影响（仍只经 commit 吐 hex）。
    const hueEl = ref<HTMLElement | null>(null);
    const hueDeg = computed(() => Math.round(hsv.h));
    let _drags: DragValueHandle[] = [];
    const hexInput = ref<HTMLInputElement | null>(null);
    let _sense: InputSenseHandle | null = null;
    onMounted(() => {
      draw();
      // 色名 IntelliSense：通用 input-sense 控件 + 色名数据源（media = 色板 chip）。
      // 色词候选选中即换色；**词库候选**（discovery：输入部分词库名出「中国传统色:」）
      // 选中 = 回填「id:」并重开候选 = 继续浏览整板，不 commit。
      if (hexInput.value) {
        _sense = attachInputSense<ColorNameHit>(hexInput.value, {
          search: (q) => searchColorNames(q).map((it) => {
            if (it.category) return { label: it.name, value: it };
            const chip = document.createElement("i");
            chip.className = "color-chip";
            chip.style.background = it.hex;
            return { label: it.name, value: it, media: chip };
          }),
          onPick: (it) => {
            const el = hexInput.value;
            if (it.value.category) {
              if (el) { el.value = it.value.category + ":"; el.dispatchEvent(new Event("input", { bubbles: true })); }
              return;
            }
            const d = hexToHsv(it.value.hex);
            hsv.h = d.h; hsv.s = d.s; hsv.v = d.v;
            commit();
          },
        });
      }
      if (pad.value) {
        _drags.push(attachDragValue(pad.value, {
          getValue: () => ({ x: hsv.s, y: 1 - hsv.v }),
          onDrag: (x, y) => { hsv.s = x; hsv.v = 1 - y; commit(); },
        }));
      }
      if (hueEl.value) {
        _drags.push(attachDragValue(hueEl.value, {
          getValue: () => ({ x: hsv.h / 360, y: 0 }),
          onDrag: (x) => { hsv.h = Math.round(x * 360); commit(); },
        }));
      }
    });
    onUnmounted(() => { for (const d of _drags) d.dispose(); _drags = []; _sense?.dispose(); _sense = null; });

    function onHueKey(e: KeyboardEvent) {
      const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1
        : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
      if (!d) return;
      hsv.h = Math.max(0, Math.min(360, hsv.h + d * (e.shiftKey ? 10 : 1)));
      commit();
      e.preventDefault();
    }
    // 文本框契约（2026-07-30 user）：**只有回车才 commit**；失焦/Esc 一律弹回现有 truth
    //   （半输入永不生效——原 @change 在 blur 也 commit，点别处会把没敲完的字当输入吞掉）。
    // 解析：hex 优先；不是 hex 再按颜色名认——统一词表**全语言搜索**（优先级 mpl > css > en >
    //   zh > ja > tok：单字母 b / tab:blue / CSS 关键字 / xkcd 全表含 slang / 传统色+拼音 / 和色+かな）。
    function onHexKey(e: KeyboardEvent) {
      const el = e.target as HTMLInputElement;
      if (e.key === "Enter") {
        e.preventDefault();
        const norm = normalizeHex(el.value) ?? parseColorName(el.value);
        if (!norm) { el.value = hexText.value; return; }   // 非法：静默弹回（组件不持 status）
        const d = hexToHsv(norm);
        hsv.h = d.h; hsv.s = d.s; hsv.v = d.v;
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        el.value = hexText.value;
        el.blur();
      }
    }
    function onHexBlur(e: Event) {
      (e.target as HTMLInputElement).value = hexText.value;   // :value 绑定不会自己拉回未 commit 的 DOM 值
    }

    // i18n：t() 在 setup 调（key 受 tsc 检查），模板只引 L.*（§5a 纪律）。
    const L = { svPad: t("cw.svPad"), hue: t("cw.hue") };
    return { pad, hueEl, hueDeg, hsv, hex, hexText, hexInput, onHueKey, onHexKey, onHexBlur, L };
  },
  // 多根 = fragment：挂进 .float-panel-body 后三个节点成为它的直接 flex 子节点，
  // DOM 结构与原 index.html 一字不差（样式全 class-based，照旧生效）。
  // v0.7.8：hue 从原生 range 换自绘（ramp-slider 同款 track/thumb class）——原生 range 做不了 shift 细调。
  template: `
    <canvas ref="pad" class="sv-pad" width="240" height="180" :aria-label="L.svPad"></canvas>
    <div ref="hueEl" class="hue-slider ramp-slider" role="slider" tabindex="0" :aria-label="L.hue"
      :aria-valuenow="hueDeg" aria-valuemin="0" aria-valuemax="360" @keydown="onHueKey">
      <div class="ramp-slider-thumb" :style="{ left: (hsv.h / 360 * 100) + '%' }"></div>
    </div>
    <div class="picker-row">
      <span class="picker-preview" :style="{ background: hex }"></span>
      <input ref="hexInput" type="text" maxlength="24" :value="hexText" @keydown="onHexKey" @blur="onHexBlur" aria-label="HEX" />
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
