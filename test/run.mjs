// WebPaint 专属测试入口（store/cloud-sync/provider 契约在 lib 的 test/，这里只留 WebPaint vendored adapter）。
import "./dom-shim-first.mjs";   // **必须第一**：在任何 import-Vue 之前装 DOM shim（见该文件头注释）。
import { run } from "./runner.mjs";
import "./onedrive-provider.contract.test.mjs";
import "./crypto-container.test.mjs";
import "./substrate.test.mjs";
import "./editor-session.test.mjs";   // 家族共享模块 editor-session 生命周期编排（mock store+editor）
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./brush-rack-migrate.test.mjs";
import "./engine-registry.test.mjs";
import "./registry.test.mjs";
import "./resolved-brush.test.mjs";
import "./pointer-gesture.test.mjs";
import "./crop-geometry.test.mjs";
import "./sw-strategy.test.mjs";
import "./liquify-bbox.test.mjs";
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
import "./tile-residency.test.mjs";         // TileResidency Slice A：无损压缩备份 + dirty-never-evict 门 + contentVersion          
import "./blend-glsl.test.mjs";             // WebGL2+tiling Stage 2：12 blend GLSL 生成（像素 parity 在 npm run smoke）
import "./gl-compose-plan.test.mjs";        // WebGL2+tiling Stage 2：clip 基底解析 + 组隔离判定（与 layer-composite 对齐）
import "./gl-doc-bridge.test.mjs";       // WebGL2+tiling 接 board：doc 树→CompNode 翻译 + safeMode
import "./layer-tree.test.mjs";             // batch 2：图层树模型（嵌套树 op + activeId + 组 op + snapshotAll 往返）
import "./ora-tree.test.mjs";               // batch 2 step3：ORA 嵌套组序列化（buildStackXml↔parseStackXml + id + active 往返）
// app-boot 必须是套件里**第一个**触发 Vue 求值的测试：Vue（vue.esm-browser）在 module-eval 时把
// document 缓存成 module 级 const（createText 等用它）。boot-smoke 装了 DOM shim 后才 import app.js，
// 故 Vue 求值时 document 有效（=shim doc）；若让别的 import-Vue 的测试先跑（node 无 document），
// Vue 缓存 doc=null，boot-smoke 里 Vue mount 即 `null.createTextNode` 炸。current-brush 故排其后。
import "./dial-controls.test.mjs";   // dial 写入 setSize/setOpacity + 键盘 [ ] 段量化调粗。
import "./editor-state-restore.test.mjs";   // adoptLoadedDoc 的 toolStates 反序列化下沉（v98 兼容）。

console.log("\n  WebPaint —— vendored OneDriveProvider 适配验收（lib 契约在 sync-store/test/）\n");
await run();
