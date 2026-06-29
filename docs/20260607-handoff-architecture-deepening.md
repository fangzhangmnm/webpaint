# Handoff — 架构深化线程（2026-06-06/07）→ 重跑 /improve-codebase-architecture

给下一个 agent：本线程在「还三天 vibe-coding 债」的背景下，对 WebPaint 做了一轮架构深化 +
一个深模块抽象的设计原型。你将**重跑 `/improve-codebase-architecture`**。下面是已做、已定、未决。

> 纪律提醒（沿用本仓）：结论对回**源码行号**，别信任另一个 AI（含上一个我）的总结；lasso 是历轮幻觉重灾区（见下 K4）。`/improve-codebase-architecture` 报告按用户要求落 `docs/reports/`（gitignored），**不开浏览器**。

## 0. 背景与那个决定
用户在权衡两个重构方向：**A. 拆 app.js god file** vs **B. 迁 Vue+TS（esbuild，不用 vite）**。
首轮 fresh 勘探报告结论：**A/B 是假二选一**，真轴=把被困的深域逻辑抽成深模块（A、B 共同前置）。
- 报告全文（**起点，先读**）：`docs/reports/20260606-fresh-geological-survey.html`（gitignored，在磁盘上）。
- 领域词表：`CONTEXT.md`。同步/存储模型的账本：`../20260601 MyPWAPatterns/docs/MASTER.md` + `docs/adr/0001-0017`（**只是 ADR=决策账本；WebPaint 的 `src/store` 才是 SSoT 实现**）。

## 1. 已落地（全在 dev/main，v179→v183，行为保持，全套 138 tests passed）
报告里的候选编号 K* / A*。详情看 commit message，别在这复述：
- **K1**（`2f76017`，v179）：引擎 dispatch「统一节律」原是假接缝 → 收成数据表 `src/engine-registry.js`（+11 测）。
- **K2**（`605a303`，v179）：`doc.mergeDownLayer()` + `doc.adoptState()` + `doc.layerSpec()` 下沉 PaintDoc。adoptLoadedDoc 余 ~95 行**刻意留 app**（referenceWindow/palette/viewport 是编排非模型）。
- **K3 安全切片**（`2770086`，v181）：纯手势数学 → `src/pointer-gesture.js`（pinch/snap/tap，anchor 不变量测试，+13 测）。**live 指针派发没动**（设备态机，留真机）。
- **v182**（`0b7fe8a`）：参考窗 pinch/wheel 复用 K3 共享 kernel（dedup；+2 测）。
- **A 三连**（`3364b9d`，v183）：`src/crop-geometry.js` / `src/gallery-path.js` + `src/gallery-model.js` / `src/brush-rack-view.js`（+27 测）。
- **K4 = 幻觉，已关闭**：fresh explorer 又幻觉「lasso 该把 mask 代数搬回 selection」——`lasso.js:30` 注明 2026-05 早搬完，lasso 只构造 Selection + 委托。CONTEXT.md Selection 条目已加守卫止幻觉。**别再提**。
- **K5（TS-at-seams + Vue）= 用户明确缓做**，但见 §3 的深模块抽象设计。
- 顺手 bugfix：橡皮放开色板（`eraser.allowsColor:true`，v180）。

**抽取纪律（沿用）**：只下沉**纯逻辑**（几何/合并/态机/派生），DOM/IDB/cloud 编排留 app.js。删除测试不通过的不动。canvas-bound 模块（doc.js/engine）node 测不了 → 桌面/真机验。

## 2. 待验（累积，未回归）
- iPad：K1 笔刷手感、K3 双指手势、v182 参考窗 pinch/wheel（数学测过等价，手感未验）。
- 桌面：A 三连（裁切框拖拽/扩张、图库文件夹导航、笔架 sheet）。

## 3. 本线程的大头：深模块抽象设计（为「怎么抽 store 深模块」服务）
用户的终极构想：**一个统一 local+云的 `repo`，app 当本地写，云=内部状态机，只以一小撮闭集「云表面」冒头**。
做了个**抛弃型 Vue + mock API 原型**验证（gitignored）：
- `tmp/gallery-vue-proto/index.html`（Vue + mock repo，三消费方 gallery/editor/rack；浏览器打开）。
- `tmp/gallery-vue-proto/NOTES.md` ← **设计答案全文，必读**。含：
  - repo facade 签名（open/edit/save(smart-save 多态)/refresh/pin/rename/delete/onException）。
  - 内部状态机（20260604-state-machine.md / ADR-0014 徽章集）。
  - **「云表面非 0」**：app owns「consent+显示」7 项（status / consent 手势 / freshness(newer 锁屏 ADR-0017) / pin / onException 闭集 / quota-full / 批量·离线 list），深模块 owns「机制」（etag/.backup/权威/合并/push-serialize）。**这条线是防 AI 幻觉/忽略的关键**。
  - 形状决定异常多少：Work-file 会 conflict；Folder(笔架) 确定性合并→永不 conflict。
  - 浅 Vue 四层 + 「flow 能 call flow 吗」答案（高层 flow 可调低层；同层深模块 flow 靠内部原语组合）。

**结论**：抽象成立、但云表面是闭集（~7 项）。下一步落地序：把现有 `src/store` 收成此 facade（status 派生 + freshness + onException 收口 + pin）→ 抽 L3 `gallery-flow.js` → card view 照 API 写（浅 Vue）。

## 4. 未决 / 给你的注意点
- ~~**gallery merge name→GUID 分歧**~~ **已解决（非 bug）—— 2026-06-07 晚 GUID 身份方案回滚，身份 = path/name，见 [20260607-sync-identity-decision.md](20260607-sync-identity-decision.md)。** `src/gallery-model.js` 的 `mergeLocalCloud` 按 **name** 配对 local⊕cloud **就是终局 canonical 实现**，不需要修。原记的「偏离 ADR-0011 GUID 身份」是当天上午的旧判断；当天用户拍板 ADR-0011 的 in-file-GUID 对格式无关共享 store 是 over-reach 并回滚。唯一软肋（多设备改名裂卡 E）是**接受不修**的 UX 疣。
- app.js 6809→6683 行（净降不大——价值在「困住的逻辑隔离+可测+可复用」，不在行数）。还有可抽的：gallery cloud-thumb 编排 / batch 选择、brush-preset draft 生命周期、sync-gate 决策树。
- input.js live-dispatch 重构（K3 剩下的真活）= 最高风险（gesture/pen 热路径、iPad-only 验）—— 别 blind 大改。

## 5. Suggested skills
- **`/improve-codebase-architecture`**（主任务）：start fresh 钻探，但**别再 propose**：K1（引擎 registry 已做）、K4（lasso mask 代数=幻觉，已在 selection.js）、已下沉的 doc/crop/gallery/rack 模块。可深挖：store→repo facade 落地、L3 gallery-flow、剩余 god-file cluster。报告落 `docs/reports/`，不开浏览器。
- **`/grill-with-docs`**：若要把 repo facade / 「7 项云表面」定稿成 ADR / CONTEXT 词条前，拿来对着 MASTER.md+ADR 磨术语。
- 真机/桌面回归用 `/verify` 或 `/run`（注意 canvas/手感只能设备验）。

## 6. 关键路径速查
- 新模块：`src/{engine-registry,pointer-gesture,crop-geometry,gallery-path,gallery-model,brush-rack-view}.js`；`src/doc.js`（+mergeDownLayer/adoptState/layerSpec）。
- 测试：`test/{engine-registry,pointer-gesture,crop-geometry,gallery-model,brush-rack-view}.test.mjs`（`npm test` / `node test/run.mjs`）。
- 设计原型：`tmp/gallery-vue-proto/`（gitignored）。
- Memories：`project_webpaint_arch_deepening_k1k2`、`project_webpaint_gallery_guid_divergence`。
- 构建：`bash scripts/build.sh` → bump 版本 `./bump.sh vN-YYYY-MM-DD` → commit+push main（=dev，norm；prod 要问）。
