// 笔设置编辑器（UI 深化 candidate 1 · 第二个 Vue 子系统）。
//
// 取代 app.js 的 _renderBrushSettings（~165 行命令式 form builder，每次改 shape kind 都 innerHTML
// 全量重建）。现在 draft 是 reactive，条件 row 走 v-if，数值走 v-model —— 全量重建消失。
//
// **leaf-by-value + local-reactive-draft**（不是全局 reactive-SSoT）：编辑器只改一个 draft（app 传进来的
// preset 深拷贝），改动经 reactive 代理写回该对象；app 的 header 保存键读同一对象落 rack（_closeBrushSettings）。
// 组件唯一对外 emit = delete / export（这俩按钮在 body 里，但要 app 编排 confirm/落 trash/下载文件）。
// 保存/取消是 view header 的事（仍在 app），不经组件。
//
// 工具链同色轮：vendor vue.esm-browser.prod + template 字符串 + esbuild bundle。

import { createApp, defineComponent, ref } from "../../vendor/vue/vue.esm-browser.prod.js";
import { quantizeSize } from "./brush-size.ts";
import { ensureBrushDraftDefaults } from "./brush-settings-model.ts";
import type { BrushDraft } from "./brush-settings-model.ts";

const SECTION = "brush-settings-section";
const TITLE = "brush-settings-section-title";
const ROW = "brush-settings-row";
const ROW_FULL = "brush-settings-row brush-settings-row-full";
const VAL = "brush-settings-val";

export const BrushSettings = defineComponent({
  name: "BrushSettings",
  props: {
    draft: { type: Object, required: true },
    blendModes: { type: Object, default: () => ({}) },   // { mode: 中文label }
  },
  emits: ["delete", "export"],
  setup() {
    // quantizeSize 暴露给 template（size base/max 的 fmt + onInput 都用它）
    return { quantizeSize };
  },
  template: `
  <div>
    <!-- 基本 -->
    <div class="${SECTION}">
      <div class="${TITLE}">基本</div>
      <div class="${ROW_FULL}"><label>名字</label><input type="text" v-model="draft.name"></div>
      <div class="${ROW_FULL}"><label>工具</label>
        <select v-model="draft.tool">
          <option value="brush">笔刷</option><option value="eraser">橡皮</option>
        </select>
      </div>
      <div class="${ROW_FULL}"><label>混合模式</label>
        <select v-model="draft.blendMode">
          <option v-for="(label,val) in blendModes" :key="val" :value="val">{{ label }}</option>
        </select>
      </div>
      <div class="${ROW_FULL}"><label>文件夹</label><input type="text" v-model="draft.folder"></div>
    </div>

    <!-- 形状 -->
    <div class="${SECTION}">
      <div class="${TITLE}">形状</div>
      <div class="${ROW_FULL}"><label>类型</label>
        <select v-model="draft.shape.kind">
          <option value="round">圆</option><option value="ellipse">椭圆</option><option value="texture">纹理</option>
        </select>
      </div>
      <template v-if="draft.shape.kind === 'ellipse'">
        <div class="${ROW}"><label>长短轴</label><input type="range" min="0.1" max="1" step="0.05" v-model.number="draft.shape.aspect"><span class="${VAL}">{{ draft.shape.aspect.toFixed(2) }}</span></div>
        <div class="${ROW}"><label>旋转°</label><input type="range" min="0" max="180" step="1" v-model.number="draft.shape.rotation"><span class="${VAL}">{{ Math.round(draft.shape.rotation) }}°</span></div>
      </template>
      <div class="${ROW}"><label>硬度</label><input type="range" min="0" max="1" step="0.05" v-model.number="draft.shape.hardness"><span class="${VAL}">{{ draft.shape.hardness.toFixed(2) }}</span></div>
    </div>

    <!-- 粗细 -->
    <div class="${SECTION}">
      <div class="${TITLE}">粗细 (size)</div>
      <div class="${ROW}"><label>基础</label><input type="range" min="1" :max="draft.size.max || 200" step="1" :value="draft.size.base" @input="e => draft.size.base = quantizeSize(+e.target.value)"><span class="${VAL}">{{ draft.size.base }} px</span></div>
      <div class="${ROW}"><label>最大</label><input type="range" min="10" max="1000" step="1" :value="draft.size.max" @input="e => draft.size.max = quantizeSize(+e.target.value)"><span class="${VAL}">{{ draft.size.max }} px</span></div>
    </div>

    <!-- 压感 dynamics -->
    <div class="${SECTION}">
      <div class="${TITLE}">压感 (−1..1，0 = 不响应、负数 = 反向)</div>
      <div class="${ROW}"><label>size</label><input type="range" min="-1" max="1" step="0.05" v-model.number="draft.sizeCoeff"><span class="${VAL}">{{ draft.sizeCoeff.toFixed(2) }}</span></div>
      <div class="${ROW}"><label>opacity</label><input type="range" min="-1" max="1" step="0.05" v-model.number="draft.opaCoeff"><span class="${VAL}">{{ draft.opaCoeff.toFixed(2) }}</span></div>
      <div class="${ROW}"><label>flow</label><input type="range" min="-1" max="1" step="0.05" v-model.number="draft.flowCoeff"><span class="${VAL}">{{ draft.flowCoeff.toFixed(2) }}</span></div>
    </div>

    <!-- 默认值 -->
    <div class="${SECTION}">
      <div class="${TITLE}">默认值（选笔时拷给 opacity 滑块）</div>
      <div class="${ROW}"><label>默认 opacity</label><input type="range" min="0" max="1" step="0.05" v-model.number="draft.defaultOpa"><span class="${VAL}">{{ Math.round(draft.defaultOpa*100) }}%</span></div>
    </div>

    <!-- 笔画平滑 -->
    <div class="${SECTION}">
      <div class="${TITLE}">笔画平滑</div>
      <div class="${ROW}"><label>streamline</label><input type="range" min="0" max="1" step="0.05" v-model.number="draft.smooth.streamline"><span class="${VAL}">{{ draft.smooth.streamline.toFixed(2) }}</span></div>
      <div class="${ROW}"><label>stabilization</label><input type="range" min="0" max="1" step="0.05" v-model.number="draft.smooth.stabilization"><span class="${VAL}">{{ draft.smooth.stabilization.toFixed(2) }}</span></div>
      <div class="${ROW}"><label>pressure LPF</label><input type="range" min="0" max="200" step="5" v-model.number="draft.pressureLPF"><span class="${VAL}">{{ Math.round(draft.pressureLPF) }} ms</span></div>
    </div>

    <!-- 高级 -->
    <div class="${SECTION}">
      <div class="${TITLE}">高级</div>
      <div class="${ROW_FULL}"><label>重叠模式 compositeMode</label>
        <select v-model="draft.compositeMode">
          <option value="wash">Wash（max；自交不变深，有上限）</option>
          <option value="buildup">Build-Up（累积；可达 100%，喷枪 feel）</option>
        </select>
      </div>
      <div class="${ROW}"><label>pressureGamma</label><input type="range" min="0.2" max="3" step="0.05" v-model.number="draft.pressureGamma"><span class="${VAL}">{{ draft.pressureGamma.toFixed(2) }}</span></div>
      <div class="${ROW_FULL}">
        <label>pixelMode<br><span style="font-size:11px;color:var(--ink-soft);">开 = 整数 snap + fillRect 无 AA（像素艺术）</span></label>
        <button type="button" class="brush-rack-action" style="justify-self:end;" :aria-pressed="draft.pixelMode" @click="draft.pixelMode = !draft.pixelMode">{{ draft.pixelMode ? '开' : '关' }}</button>
      </div>
    </div>

    <!-- 间距 -->
    <div class="${SECTION}">
      <div class="${TITLE}">间距 (% 直径)</div>
      <div class="${ROW}"><label>间距</label><input type="range" min="1" max="200" step="1" :value="Math.round(draft.spacing*100)" @input="e => draft.spacing = (+e.target.value)/100"><span class="${VAL}">{{ Math.round(draft.spacing*100) }}%</span></div>
    </div>

    <!-- 收尾 taper -->
    <div class="${SECTION}">
      <div class="${TITLE}">收尾</div>
      <div class="${ROW}"><label>入端</label><input type="range" min="0" max="5" step="0.1" v-model.number="draft.taper.in"><span class="${VAL}">{{ draft.taper.in.toFixed(1) }}</span></div>
      <div class="${ROW}"><label>出端</label><input type="range" min="0" max="5" step="0.1" v-model.number="draft.taper.out"><span class="${VAL}">{{ draft.taper.out.toFixed(1) }}</span></div>
    </div>

    <!-- 导出 / 删除（编排在 app：confirm / 落 trash / 下载文件） -->
    <div class="${SECTION}">
      <button type="button" class="brush-rack-action" @click="$emit('export')">导出此笔为 JSON 文件</button>
    </div>
    <div class="${SECTION}">
      <button type="button" class="brush-rack-action" style="background:rgba(220,38,38,0.1);color:#dc2626;border-color:#dc2626;" @click="$emit('delete')">删除此笔</button>
    </div>
  </div>
  `,
});

export interface BrushSettingsHandle {
  open(draft: object): void;   // draft = app 拥有的 preset 深拷贝；组件原地编辑它
  close(): void;
}

export function mountBrushSettings(
  el: HTMLElement,
  opts: { blendModes: Record<string, string>; onDelete: () => void; onExport: () => void },
): BrushSettingsHandle {
  const draft = ref<object | null>(null);
  const app = createApp(defineComponent({
    components: { BrushSettings },
    setup() {
      return { draft, blendModes: opts.blendModes, onDelete: opts.onDelete, onExport: opts.onExport };
    },
    // :key=draft.id → 换笔时整块 form remount（等价旧 _renderBrushSettings 重建，但只在换笔时）
    template: `<BrushSettings v-if="draft" :key="draft.id" :draft="draft" :blend-modes="blendModes" @delete="onDelete" @export="onExport" />`,
  }));
  app.mount(el);
  return {
    open(d: object) { ensureBrushDraftDefaults(d as BrushDraft); draft.value = d; },
    close() { draft.value = null; },
  };
}
