// WebPaint 专属测试入口（store/cloud-sync/provider 契约在 lib 的 test/，这里只留 WebPaint vendored adapter）。
import "./dom-shim-first.mjs";   // **必须第一**：在任何 import-Vue 之前装 DOM shim（见该文件头注释）。
import { run } from "./runner.mjs";
import "./onedrive-provider.contract.test.mjs";
import "./crypto-container.test.mjs";
import "./substrate.test.mjs";
import "./editor-session.test.mjs";   // 家族共享模块 editor-session 生命周期编排（mock store+editor）
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./collection.test.mjs";
import "./checkpoint-policy.test.mjs";
import "./brush-rack-migrate.test.mjs";
import "./engine-registry.test.mjs";
import "./registry.test.mjs";
import "./resolved-brush.test.mjs";
import "./pointer-gesture.test.mjs";
import "./crop-geometry.test.mjs";
import "./app-version.test.mjs";
import "./cpu-tile-pool.test.mjs";
import "./background-sync-jobs.test.mjs";
import "./undo-history.test.mjs";
import "./operators.test.mjs";
import "./float-ops.test.mjs";     // S6：float 入 workpiece（lift/transform/reject/accept 整链 + 所有权/驱逐）
import "./sw-strategy.test.mjs";
import "./liquify-bbox.test.mjs";
import "./liquify-docspace-mask.test.mjs";
import "./liquify-bilinear.test.mjs";
import "./gallery-model.test.mjs";
import "./store-folder-listing.test.mjs";   // 2026-07-11 网盘模型：per-folder listFolder/reconcileFolder/watchFolder + 数据安全 guardrail
import "./store-cloud-naming.test.ts";       // 2026-07-12 回归：裸 session name ↔ 云端 X.ora/X.zip 往返（cutover 漏 fileName + listing 按 path 归一 → 0B/打开空白）
import "./zip-peek.test.mjs";                // 2026-07-13 getPeek slice：库内 zip 尾片解析（硬扫末尾 PNG + 尾内 CD fallback）
// ── 新引擎红线对抗 battery（2026-07-12 从 JRP 按模块测试移植；旧 store-flow/store-p0-batch 等 import 已删的
//    monolithic store.ts、早成孤儿不跑 → 这批直接验新模块的红线：If-Match/parentBase/conflict→backup/move-aside/… ）──
import "./push.test.ts";             // If-Match=parentBase、412 surface、0 字节占位仍 dirty、撞名不覆盖
import "./safe-resolve.test.ts";     // 冲突 choke point：keepMine/takeCloud、败者→.backup、同 ms 两份不覆盖
import "./delete.test.ts";           // 删=move-aside→.trash、null-base 不误删别设备同名、离线排队
import "./trash.test.ts";            // 回收站 restore/purge/empty、本地云端同层 + emptyBackup + 加密件 restore 落 encFileName
import "./trash-merge.test.ts";      // 回收站/备份箱本地↔云聚合：mergeTrash 配对（local/cloud/both）+ conflictLive + 加密解析
import "./upload-queue.test.ts";     // ADR-0018 离线新上传回线补推（auto|ask|manual）
import "./seal.test.ts";             // 加密封装：无密码 LockedError 绝不落明文
import "./freshness.test.ts";        // 刷新/快进：clean 快进 vs dirty 不覆盖
import "./local-head.test.ts";       // 本地权威态机（dirty/clean/parentBase 记账）
import "./offload.test.ts";          // offload 合法性：世界唯一副本 offload 非法抛错
import "./identity.test.ts";         // saveAs/rename/move 身份换（含撞名、离线 move）
import "./cloud-write-ifmatch.test.ts";   // P1: 非 upload 的云写(move/rename/purge)也必须带 If-Match
import "./name-normalization.test.ts";   // P4: 身份在赋值处归一化（非单射的 sessionFileName）
import "./boot-restore.test.ts";        // P5: 冷启动恢复的失败路径（幽灵路径纪律 + 不清 currentFile）
import "./reconcile.test.ts";        // cloud-gone 收敛去抖：首次标 candidate、跨 GRACE send trash、重现/编辑自愈
import "./pending-gone.test.ts";     // 云端防抖 candidate-gone 深模块 + classifySyncState pendingGone 分支
import "./cloud-sync.test.ts";       // provider↔本地缓存低层同步 + memKv
import "./folder-delete.test.ts";    // deleteEmptyFolderVia 护栏四态（deleted/already-gone/non-empty/list-failed）+ If-Match 透传
import "./store-lost-response-claim.test.mjs";   // N6 认领尾部校验：同名同大小异内容 → 不认作我方 push（防 lost-response 静默丢失）
import "./migration.test.mjs";       // ADR-0019 迁移**框架**：版本戳/命名空间/编排机制（单调·幂等·崩溃安全，合成迁移注入）。V001/V002 tax 已清（2026-07-13）
import "./store-narrow-waist.test.ts";   // 2026-07-13 窄腰重构：命名空间根 appId.databaseId + kv 前缀 + isHidden + collection 名/保留名 + 两实例 etag 隔离 + settings 散键 + backupFolder .backup
import "./app-state.test.mjs";            // 2026-07-14 app-state struct 门面：冷字段直读写 collection（不落 RAM）+ push/pull
import "./editor-state.test.mjs";         // 2026-07-14 editorState struct：默认/setDirtyFlag/Serialize 往返/Unserialize 容错/reset
import "./gallery-view-model.test.mjs";
import "./color-model.test.mjs";
import "./brush-size.test.mjs";
import "./brush-settings-model.test.mjs";
import "./brush-rack-view.test.mjs";
import "./brush-rack-reactive.test.mjs";   // ★笔架↔collection 绑定回归（v415 漏接过）
import "./pointer-route.test.mjs";
import "./stroke-input-smooth.test.mjs";
import "./stroke-smoother.test.mjs";
import "./selection-morph.test.mjs";
import "./selection-tiles.test.mjs";       // S5：gray8 tile 选区底座（布尔/所有权/ants/SwapSelectionOp）
import "./floating-transform.test.mjs";     // Slice 1/3：浮层变换深模块（free/uniform/distort/旋转/平移/投影 + 多 source 映射）
import "./editable-leaf.test.mjs";          // Slice 4：requireEditableLeaf 单谓词（组/隐藏 gate）
import "./doc-rotate.test.mjs";             // v258 逆时针旋转 90°（bbox 公式 + 4 次恒等 + 方向）
import "./doc-offset.test.mjs";             // 偏移接缝（环绕）：像素环绕映射 + 恒等性 + selection bbox
import "./doc-mergedown-clip.test.mjs";     // v258 剪裁层向下合并（dst-in 裁基底 + 链内保剪裁 + 拒绝反向）
import "./layer-cap-budget.test.mjs";        // v339 动态字节预算图层上限（预算内放硬顶 / 达预算冻结 / 模式档 countMat）
import "./brush-collect-stamps.test.mjs";    // Stage 3：brush.collectStamps GPU stamp-list 出栈（复用手感数学 / 椭圆透传 / pixelMode null）
import "./layer-composite.test.mjs";        // deep module A：clip 基底解析（同级/链共基底/基底隐显/组作基底）
import "./tile-geometry.test.mjs";          // tile 几何纯函数（自 tile-store.test 迁出）
import "./gpu-tile-pool.test.mjs";          // S7：GPU tile 池（fake backend；pin 两档/批次/grow/leaky-GPU 对抗）
import "./tile-bridge.test.mjs";            // S7：cpu-gpu-tile-bridge（身份去重/purgeDead/FBO 切片）
import "./render-plan.test.mjs";            // S7b：render-plan 分区 golden（prefix/iso 并段/clip pin/pass-through 展开）
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
// app-boot 于 v417 **重新注册**（v415 查明它从没跑过）。当时的阻塞：boot 装的全局 `wp:adjsize` 监听
//   拆不掉 → dial-controls 派发的键盘事件被处理两次（12→14 而非 13）。dom-shim 是套件级单例、二次
//   install 是 no-op，所以 uninstallDomShim 救不了。
//   止血修法：app.ts 把 bindSizeKeyboard 的 disposer 收进 globalThis.__wpBootTeardown，
//   app-boot.test.mjs 的 finally 里调掉。它**必须排在 dial-controls 之前**（上面 Vue 求值顺序那条约束）。
//   ⚠ 这不等于 boot 可拆卸：全 app 还有 20 个模块 57 处 addEventListener 没有 disposer。将来若又出现
//   "注册 app-boot 就有别的测试挂"，先怀疑又一条没拆的全局监听，别直接把 app-boot 摘掉了事。
//   完整方案（子进程 vs 全面 disposer 化）见 docs/reports/20260718-boot-disposability-and-test-infra.html。
import "./app-boot.test.mjs";        // 组合根 boot smoke：22×initX + 5×Vue mount + reactive flush 全程不抛。
import "./i18n-localize-dom.test.mjs";  // v421：data-i18n 桥不得冲掉内联 <svg><use> 图标（v419 出过）。
import "./editor-session-safety.test.mjs";   // v417 止血：开文件事务性 / 保存失败不宣布干净 / create 标记 per-name。全是曾会丢画的路径。
import "./dial-controls.test.mjs";   // dial 写入 setSize/setOpacity + 键盘 [ ] 段量化调粗。
import "./current-brush.test.mjs";   // currentBrush 反应式接线 + 纯度。v415 发现它一直**没被注册**=从没跑过。
import "./editor-state-restore.test.mjs";   // adoptLoadedDoc 的 toolStates 反序列化下沉（v98 兼容）。

console.log("\n  WebPaint —— vendored OneDriveProvider 适配验收（lib 契约在 sync-store/test/）\n");
await run();
