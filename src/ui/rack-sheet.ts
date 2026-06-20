// 笔架 sheet 的 folder tabs + 笔刷 grid（UI 深化 candidate 1 · 第四个 Vue 子系统）。
//
// 取代 app.js 的 _renderRackSheet（命令式重建 folder 按钮 + tile）。数据驱动：folders/tiles/活动高亮
// 全是 computed（读反应式 dialReactive.rackVersion + rackUi + toolStates → 笔架内容/工具/文件夹/选中变即自动重渲）。
// 各处 _renderRackSheet() 手动刷新调用全删（reactivity 替代）。
//
// 边界：sheet head 的动作工具条（导入/导出/云推/新建/重置/关闭 + 云图标态机）留 app 命令式（chrome + 绑 rackStore）。
// 本组件只管「显示哪些 folder/笔 + 点了谁」，emit 回 app 编排（选笔=改 per-doc toolState、编辑=开设置、重置=造默认架）。
//
// 纯派生（collectFolders/brushesInFolder/smoothstepRadialGradient）在 brush-rack-view.js（node 可测）。

import { createApp, defineComponent, computed } from "../../vendor/vue/vue.esm-browser.prod.js";
import { collectFolders, brushesInFolder, smoothstepRadialGradient } from "../brush-rack-view.ts";
import type { Brush } from "../brush-types.ts";

export interface RackSheetOpts {
  defaultFolder: string;
  getBrushes(): Brush[];      // 当前工具的笔（读 _brushRack，gated rackVersion）
  getRackEmpty(): boolean;    // 整个笔架空（显「恢复默认」）
  getFolder(): string;        // rackUi.folder
  getActiveId(): string | null;
  onSelectFolder(f: string): void;
  onSelectBrush(id: string): void;
  onEditBrush(id: string): void;
  onReset(): void;
}
export interface RackSheetHandle { unmount(): void; }

export function mountRackSheet(el: HTMLElement, opts: RackSheetOpts): RackSheetHandle {
  const Comp = defineComponent({
    setup() {
      const brushes = computed(() => opts.getBrushes());
      const rackEmpty = computed(() => opts.getRackEmpty());
      const folders = computed(() => collectFolders(brushes.value, opts.defaultFolder));
      // 有效 folder：当前 folder 不在集合里则回退第一个（纯派生，不写状态——切工具的归位在 app 的 _showRackSheet 做）。
      const effectiveFolder = computed(() => {
        const f = opts.getFolder();
        return folders.value.includes(f) ? f : folders.value[0];
      });
      const tiles = computed(() => brushesInFolder(brushes.value, effectiveFolder.value, opts.defaultFolder));
      const activeId = computed(() => opts.getActiveId());

      function tileStyle(b: Brush) {
        const s: Record<string, string> = { background: smoothstepRadialGradient(b.shape?.hardness ?? 1) };
        if (b.shape?.kind === "ellipse") s.transform = `rotate(${b.shape.rotation}deg) scaleY(${b.shape.aspect})`;
        return s;
      }
      // 直接调注入回调（闭包）——比 $emit→root-prop 映射简单可靠。
      return {
        brushes, rackEmpty, folders, effectiveFolder, tiles, activeId, tileStyle,
        selectFolder: opts.onSelectFolder, selectBrush: opts.onSelectBrush,
        editBrush: opts.onEditBrush, reset: opts.onReset,
      };
    },
    template: `
      <div v-if="rackEmpty" class="brush-rack-grid">
        <div style="padding:20px;text-align:center;color:var(--ink-soft);">
          笔架是空的。<br><br>
          <button class="brush-rack-action" @click="reset()">恢复默认笔架（8 个）</button>
        </div>
      </div>
      <template v-else-if="!brushes.length">
        <div class="brush-rack-folders"></div>
        <div class="brush-rack-grid">
          <div style="padding:20px;text-align:center;color:var(--ink-soft);">此工具暂无笔刷。点「+ 新建」加一个。</div>
        </div>
      </template>
      <template v-else>
        <div class="brush-rack-folders">
          <button v-for="f in folders" :key="f" type="button" class="brush-rack-folder"
            :aria-pressed="f === effectiveFolder" @click="selectFolder(f)">{{ f }}</button>
        </div>
        <div class="brush-rack-grid">
          <div v-for="b in tiles" :key="b.id" class="brush-rack-tile" role="button" :tabindex="0"
            :aria-pressed="b.id === activeId" @click="selectBrush(b.id)">
            <div class="brush-rack-tile-preview" :style="tileStyle(b)"></div>
            <span class="brush-rack-tile-name">{{ b.name }}</span>
            <button type="button" class="brush-rack-tile-edit" title="编辑" @click.stop="editBrush(b.id)">⋯</button>
          </div>
        </div>
      </template>
    `,
  });

  const app = createApp(Comp);
  app.mount(el);
  return { unmount() { app.unmount(); } };
}
