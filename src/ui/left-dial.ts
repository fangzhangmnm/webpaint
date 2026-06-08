// 左栏 dial（UI 深化 candidate 1 · Step 2）——笔指示按钮 + size/opacity 竖滑块 + zoom-aware size popup。
//
// 绑定到反应式 dial SSoT（app 的 state.toolStates / dialReactive，经 getter 读）：size/opacity/sizeMax/
// brushName/canDraw 都是 computed（读 reactive → 自动追踪）。滑块输入写回（onSize/onOpacity = app setSize/setOpacity）。
// popup 由组件自持（滑块拖动即闪）；外部 [ ] 键盘调粗经 handle.flashSize() 经反应式信号触发闪。
// 笔指示按钮：tap=开 rack，长按 600ms=进设置（长按后吞掉 click）。
//
// 删掉了 app.js 的：updateSidebarBrushIndicator / showSizePopup / 两个 slider input 监听 /
//   applyToolState 的 slider-DOM-push / _sidebarBrushBtn tap-长按手势。

import { createApp, defineComponent, reactive, ref, computed, watch } from "../../vendor/vue/vue.esm-browser.prod.js";
import { sliderPosToSize, sizeToSliderPos, sliderMaxPos } from "./brush-size.ts";

const POPUP_FRAME = 64;
const LONGPRESS_MS = 600;

export interface LeftDialOpts {
  getSize(): number;
  getOpacity(): number;
  getSizeMax(): number;
  getBrushName(): string;
  getCanDraw(): boolean;
  getZoom(): number;              // board.viewport.scale，popup 圆按屏 px 画
  onSize(px: number): void;
  onOpacity(frac: number): void;
  onBrushTap(): void;
  onBrushLongpress(): void;
}
export interface LeftDialHandle {
  flashSize(): void;              // 外部 [ ] 键盘调粗后闪 popup
  unmount(): void;
}

export function mountLeftDial(el: HTMLElement, opts: LeftDialOpts): LeftDialHandle {
  const flashSignal = ref(0);    // 外部触发 size popup 闪（[ ] 键盘）

  const Comp = defineComponent({
    setup() {
      const size = computed(() => opts.getSize());
      const opacity = computed(() => opts.getOpacity());
      const sizeMax = computed(() => opts.getSizeMax());
      const brushName = computed(() => opts.getBrushName());
      const canDraw = computed(() => opts.getCanDraw());
      const sizePos = computed(() => sizeToSliderPos(size.value, sizeMax.value));
      const sizePosMax = computed(() => sliderMaxPos(sizeMax.value));
      const opaPct = computed(() => Math.round(opacity.value * 100));

      const sizeSlider = ref<HTMLInputElement | null>(null);
      const opaSlider = ref<HTMLInputElement | null>(null);
      const popup = reactive({ visible: false, left: 0, top: 0, dia: 8, opacity: 1, text: "" });
      let popupTimer: ReturnType<typeof setTimeout> | null = null;

      function flash(kind: "size" | "opacity") {
        const sliderEl = kind === "size" ? sizeSlider.value : opaSlider.value;
        if (!sliderEl) return;
        const sidebar = sliderEl.closest(".left-sidebar");
        const aRect = sliderEl.getBoundingClientRect();
        const right = sidebar ? sidebar.getBoundingClientRect().right : aRect.right;
        const px = size.value, op = opacity.value;
        popup.dia = Math.max(4, px * opts.getZoom());   // 屏 px = 文档 px × zoom
        popup.opacity = op;
        popup.text = `${px | 0} px · ${Math.round(op * 100)}%`;
        popup.left = right + 12;
        popup.top = aRect.top + aRect.height / 2 - POPUP_FRAME / 2;
        popup.visible = true;
        if (popupTimer) clearTimeout(popupTimer);
        popupTimer = setTimeout(() => { popup.visible = false; }, 1500);
      }
      watch(flashSignal, () => flash("size"));   // 外部 [ ] 键盘

      function onSizeInput(e: Event) {
        opts.onSize(sliderPosToSize(parseFloat((e.target as HTMLInputElement).value), sizeMax.value));
        flash("size");
      }
      function onOpaInput(e: Event) {
        opts.onOpacity(parseFloat((e.target as HTMLInputElement).value) / 100);
        flash("opacity");
      }

      // 笔指示：tap=rack，长按 600ms=settings（长按后吞 click）
      let lpTimer: ReturnType<typeof setTimeout> | null = null;
      let lpFired = false;
      function brushDown() {
        lpFired = false;
        lpTimer = setTimeout(() => { lpTimer = null; lpFired = true; opts.onBrushLongpress(); }, LONGPRESS_MS);
      }
      function brushUp() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
      function brushClick() { if (lpFired) { lpFired = false; return; } opts.onBrushTap(); }

      return {
        size, opacity, sizePos, sizePosMax, opaPct, brushName, canDraw, popup,
        sizeSlider, opaSlider, onSizeInput, onOpaInput, brushDown, brushUp, brushClick,
      };
    },
    template: `
      <button class="left-sidebar-brush" type="button" title="当前笔刷（tap 切换 / 长按编辑）"
        @pointerdown="brushDown" @pointerup="brushUp" @pointerleave="brushUp" @pointercancel="brushUp" @click="brushClick">
        <span class="left-sidebar-brush-name">{{ brushName }}</span>
      </button>
      <input ref="sizeSlider" id="sizeSlider" class="left-sidebar-slider" type="range" min="0" :max="sizePosMax" step="1"
        :value="sizePos" :disabled="!canDraw" orient="vertical" aria-label="笔粗" @input="onSizeInput" />
      <span class="left-sidebar-label" title="笔粗" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="12 3, 4 8, 12 13"/>
        </svg>
      </span>
      <div class="size-popup" :class="{ hidden: !popup.visible }" :style="{ left: popup.left + 'px', top: popup.top + 'px' }" aria-hidden="true">
        <div class="size-popup-circle-frame">
          <div class="size-popup-circle" :style="{ width: popup.dia + 'px', height: popup.dia + 'px', opacity: popup.opacity }"></div>
        </div>
        <span class="size-popup-text">{{ popup.text }}</span>
      </div>
      <input ref="opaSlider" id="opacitySlider" class="left-sidebar-slider" type="range" min="1" max="100" step="1"
        :value="opaPct" :disabled="!canDraw" orient="vertical" aria-label="不透明度" @input="onOpaInput" />
      <span class="left-sidebar-label" title="不透明度" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <defs><clipPath id="opaCircleClip"><circle cx="8" cy="8" r="6.5"/></clipPath></defs>
          <g clip-path="url(#opaCircleClip)">
            <rect x="0" y="0" width="8" height="8" fill="currentColor"/>
            <rect x="8" y="8" width="8" height="8" fill="currentColor"/>
          </g>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </span>
    `,
  });

  const app = createApp(Comp);
  app.mount(el);
  return {
    flashSize() { flashSignal.value++; },
    unmount() { app.unmount(); },
  };
}
