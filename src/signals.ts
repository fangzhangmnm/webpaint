// 职责（单一）= 跨切面反应式信号 —— doc/图层结构变更，UI watch 之；取代命令式 renderLayersPanel 通知。
// 发射方只 bumpDoc()，不再 reference 图层面板；<LayersPanel> 等消费方读 docVersion.value 自动重算。

import { ref } from "../vendor/vue/vue.esm-browser.prod.js";

export const docVersion = ref(0);
export function bumpDoc() { docVersion.value++; }
