// WebPaint 专属测试入口（store/cloud-sync/provider 契约在 lib 的 test/，这里只留 WebPaint vendored adapter）。
import "./dom-shim-first.mjs";   // **必须第一**：在任何 import-Vue 之前装 DOM shim（见该文件头注释）。
import { run } from "./runner.mjs";
import "./onedrive-provider.contract.test.mjs";
import "./crypto-container.test.mjs";
import "./store-crypt.test.mjs";
import "./substrate.test.mjs";
import "./store-flow.test.mjs";
import "./store-adopt-validation.test.mjs";
import "./store-lost-response-claim.test.mjs";
import "./store-p0-batch.test.mjs";
import "./store-coalescer.test.mjs";
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./folder-store.test.mjs";
import "./brush-rack-migrate.test.mjs";
import "./engine-registry.test.mjs";
import "./registry.test.mjs";
import "./resolved-brush.test.mjs";
import "./pointer-gesture.test.mjs";
import "./crop-geometry.test.mjs";
import "./gallery-model.test.mjs";
import "./gallery-view-model.test.mjs";
import "./color-model.test.mjs";
import "./brush-size.test.mjs";
import "./brush-settings-model.test.mjs";
import "./brush-rack-view.test.mjs";
import "./pointer-route.test.mjs";
import "./stroke-input-smooth.test.mjs";
import "./stroke-smoother.test.mjs";
import "./selection-morph.test.mjs";
import "./floating-transform.test.mjs";     // Slice 1/3：浮层变换深模块（free/uniform/distort/旋转/平移/投影 + 多 source 映射）
import "./editable-leaf.test.mjs";          // Slice 4：requireEditableLeaf 单谓词（组/隐藏 gate）
import "./doc-rotate.test.mjs";             // v258 逆时针旋转 90°（bbox 公式 + 4 次恒等 + 方向）
import "./doc-offset.test.mjs";             // 偏移接缝（环绕）：像素环绕映射 + 恒等性 + selection bbox
import "./doc-mergedown-clip.test.mjs";     // v258 剪裁层向下合并（dst-in 裁基底 + 链内保剪裁 + 拒绝反向）
import "./layer-cap-budget.test.mjs";        // v339 动态字节预算图层上限（预算内放硬顶 / 达预算冻结 / 模式档 countMat）
import "./brush-collect-stamps.test.mjs";    // Stage 3：brush.collectStamps GPU stamp-list 出栈（复用手感数学 / 椭圆透传 / pixelMode null）
import "./layer-composite.test.mjs";        // deep module A：clip 基底解析（同级/链共基底/基底隐显/组作基底）
import "./tile-store.test.mjs";             // WebGL2+tiling Stage 1：tile 几何 + 稀疏存储簿记（fake backend round-trip）
import "./tile-pixels.test.mjs";          
import "./blend-glsl.test.mjs";             // WebGL2+tiling Stage 2：12 blend GLSL 生成（像素 parity 在 npm run smoke）
import "./gl-compose-plan.test.mjs";        // WebGL2+tiling Stage 2：clip 基底解析 + 组隔离判定（与 layer-composite 对齐）
import "./gl-doc-bridge.test.mjs";       // WebGL2+tiling 接 board：doc 树→CompNode 翻译 + safeMode
import "./layer-tree.test.mjs";             // batch 2：图层树模型（嵌套树 op + activeId + 组 op + snapshotAll 往返）
import "./ora-tree.test.mjs";               // batch 2 step3：ORA 嵌套组序列化（buildStackXml↔parseStackXml + id + active 往返）
// app-boot 必须是套件里**第一个**触发 Vue 求值的测试：Vue（vue.esm-browser）在 module-eval 时把
// document 缓存成 module 级 const（createText 等用它）。boot-smoke 装了 DOM shim 后才 import app.js，
// 故 Vue 求值时 document 有效（=shim doc）；若让别的 import-Vue 的测试先跑（node 无 document），
// Vue 缓存 doc=null，boot-smoke 里 Vue mount 即 `null.createTextNode` 炸。current-brush 故排其后。
import "./app-boot.test.mjs";   // 组合根 boot smoke（接线零覆盖缺口，见该文件头注释）。包了 global timer。
import "./current-brush.test.mjs";   // 当前笔反应式接线（守 boot-smoke 抓不到的依赖断裂）。不 mount DOM，无 shim 也跑。
import "./dial-controls.test.mjs";   // dial 写入 setSize/setOpacity + 键盘 [ ] 段量化调粗。
import "./editor-state-restore.test.mjs";   // adoptLoadedDoc 的 toolStates 反序列化下沉（v98 兼容）。

console.log("\n  WebPaint —— vendored OneDriveProvider 适配验收（lib 契约在 sync-store/test/）\n");
await run();
