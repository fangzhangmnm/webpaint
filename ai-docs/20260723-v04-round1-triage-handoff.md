# 0.4 真机首轮 · 分诊 + 修复批 + handoff（第七棒 → 后续各轮）

> created 20260723。as-of v0.4.11。输入 = 用户 2026-07-22 iPad 真机首轮（对 v0.4.10）+ 12 条拍板答复。
> 首轮结论（用户原话）：**几乎所有 bug 都是历史遗留而非 0.4 重构引入**——人类 spec 架构 + 本轮
> 施工的鲁棒性得到验证。分批法（用户拍板）：批一 = 0.4 自留地；批二 = 历史止血；其余在此路由。

## 0. v0.4.11 修了什么（本批，全绿：842 node + tsc + smoke）

批一（0.4 自留地）：
1. **clip 层实时跟随 live 描边**（1.1）——live 中 clip-above 改采 merged(base⊕stroke) 整幅
   alpha（commit 同配方，smoke draw/erase 两条 maxΔ=0）。不是「贵」，是旧结构缺口。
2. **autosave 改「停笔 30 秒」**（2.1 拍板）——bg-jobs register 新 minIdleMs 档；3min 墙钟 gate 退役。
   确认：autosave `tryPush:false` **绝不推云**（store save 在 push 之前早退，无旁路）；落点定名 =
   IDB 库 `webpaint.defaultStore` → object store `blobs` → key `files/<名>.ora`（store 本地缓存
   files 分区）；revert checkpoint 在另一个库（app 自有 `webpaint`.checkpoints）。
3. **吸管在调整预览中取替身**（拍板#8）——WYSIWYG；顺手修 compositeOnce 读旧段缓存的陈旧类。
4. buildup 考古注记入 brush-architecture 文档（无回归；详 §2 0.5 era）。

批二（历史止血）：
1. **busy 盖冲突面/「云端有新版本」被盖**（0.2）——z-band gate 抬到 busy 之上（一刀治两现象）。
   退化考古：store 收敛后 push 在 busy 内 surface 冲突，gate<busy + _assertNotBusy 豁免假设失效。
   附：弹窗被盖时强退再开 = 安全（本地 dirty 保住、不静默拉云；下次 save 再弹）。
2. **图层面板 softlock**（1.1）——拖动/回灌 top 出血区地板（iPad hidden title bar 拦截贴顶拖动）；
   color-panel/reference 同公式一并补；**⋯菜单** Teleport 到 body + positionPopup 锚定（旧 bug =
   backdrop-filter 包含块把 fixed 扭成面板相对）。
3. **后台切回弹键盘**（2.2）——进后台 blur 当前焦点（iOS 回前台还焦点给文本框）。
4. **图库密码 sentinel**（2.3 拍板：跟账号走）——verifier 存 synced collection；创建流程变
   「输入并校验」；未验证密码不再被坐实；三错 → 唯一重置出口。零 store 契约改动。
5. **同步错误 banner 插桩**——`[err.name]` 前缀（如 `[NotFoundError]`），给 store 轮留证据。

### 真机复验最小集（下次顺手，~10 分钟）
clip 基底上画笔/擦除时上方 clip 层实时跟随；停笔 30s 自动落盘（HUD 或保存状态）；同步冲突时
弹窗**可点**；图层面板拖不进顶部手势区、⋯菜单贴按钮弹出；切后台回来无键盘；重装后加密流程是
「输入图库密码」而非「设置」、故意输错 3 次见重置出口；调整预览中吸管=所见色；同步错误 banner
若再现，**抄下 [方括号] 里的错误名**。

## 1. store 轮（下一轮，用户点名用 fable 专门做）

- **「总是同步错误弹窗，重装后好」**（真机 high）：病根假说按可能性排序——
  ① `store/idb-store.ts` `indexedDB.open(dbName, 1)` **版本永远钉死 1** + onupgradeneeded 只建
  `blobs`：旧 origin 上同名 DB 结构不同则永不升级 → 每次同步 `NotFoundError`；重装删库即好。
  ② 陈旧 localStorage 持久态（local-head etag/parent、upload-queue 旧格式）→ 反复 412。
  ③ 2026-07-12/13 命名空间改名搁浅的旧键。`migration.ts MIGRATIONS = []`（prealpha 清空）对
  这些残留零清理。**v0.4.11 的 banner 插桩会把 err.name 打出来——修之前先收集一次真机读数。**
- open 路径 `fresh.open` 未接 `onNewer`（create-store.ts）：云端新版只在 save/push 冲突时才
  surface。现状安全（不静默拉云）但被动——要不要 open 时提示，store 轮定。
- 「重置本地缓存」按钮（等价重装不丢云端）：**必须带 dirty 未推护栏**（数据安全词典序：
  云端不丢画 >> 当前操作不丢）。
- autosave 契约讨论（拍板#1 归属的一部分）：用户新契约意向 =「workbench/workpiece 与 store
  无关，只有 save 才走 store」→ autosave 是否应改落 app 自有 IDB（checkpoint 模块）而非
  store 本地缓存？与 checkpoint-autosave/workbench-session 归属一起设计。
- 密码模型长期化：sentinel 现在是 app 层（synced collection）；store 级归宿（或维持现状）store 轮定。

## 2. 0.5 era todo（用户拍板：0.5 时代批量清 WP feedback / WP feedback arch 历史遗留 + QOL 中小功能）

- **airbrush 无上限模式复活**（真机 1.1 拍板）：pre-v98 direct-layer airbrush（per-dab
  opacity 进 Π、无单笔天花板）作为第三种 compositeMode 重新引入。手感红线：需要用户真机来回。
  考古注记已入 ai-docs/20260529-brush-architecture.md 尾部。
- WP feedback / WP feedback arch 各种历史遗留问题批量清理 + 拖欠的 QOL。

## 3. 下轮重构讨论清单（设计题，别当 bug 修）

1. checkpoint-autosave / workbench-session 归属（拍板#1：下一轮重构讨论；含 §1 的 autosave 落点）。
2. reference-gallery 归属（拍板#5：下一轮）。
3. **reject byte-identical**（拍板#3）：用户意向 = 还是要 byte identical ⇒ 需要缓存 lift 时的
   源 tile（与 spec:224「不要缓存」相反，用户已改主意要 discuss）。设计点：缓存所有权/配额/
   与 stamp 交互（stamp 过的区域怎么算）。
4. undo 到保存点清 isDirty（真机 2.4）：需要 undo system 契约 + isDirty 机制联合设计
   （save 点标记 = undo 栈上的水位？跨 checkpoint 驱逐怎么算？）。
5. active-layer 切换不入栈（拍板#4）：维持现状，与 Procreate 对齐；定性为 editor-session 的
   UI 状态而非文档编辑——workbench-state 重组时一并想。
6. **窗口深模块 + 菜单深模块**（用户建议，真机 1.1）：拖动+clamp+safe-area+persist 至少 5 份
   拷贝（reference/layers/color/palette/blender-sync），v0.4.11 只统一了 top 地板；菜单定位
   已有 anchored-popup 种子（图层⋯菜单本批已接）。收口成 float-panel 深模块。
7. 参考窗镜像 300ms 节流（拍板#10：先这样；用户不大喜欢但看不出来——留观察）。

## 4. 功能欠账（中小件，排期自便）

- 合并图层组命令（真机 1.3）：新 operator（组拍平成叶），入 undo。
- crop × 画布旋转错位（真机 1.7 旧 bug）：建议 crop 支持旋转跟随 + 画布上方向指示 UI（淡三角）。
- 导出「仅选区」选项（用户：这轮不做；要动 render-tree requiredNodes/裁剪面）。
- clip 重场景性能：12 层 11 clip ≈30fps（20 层无 clip 60fps）→ #4 frozen/tail GPU 缓存
  （S7 遗留 spec，目标稳 60）。

## 5. 拍板归档（2026-07-23 答复，防 re-litigate）

- #2 accept 后清选区：维持 ✓。#9 液化 undo 标签 = "stroke"：同意 ✓。#10 镜像节流：先这样 ✓。
- #7 encode 冻结快照（替代「阻塞锁写」）：已向用户解释（编码瞬间拍 tile 句柄照片、编码读照片、
  全程可画、存档=按保存那刻）——无异议视为追认。
- #11 体重合同：**转长期健康指标**——「目的不是为了减肥而减肥，而是为了健康而减肥」，重构时
  慢慢减，不设硬线。
- #12 liveSyncProvider：已解释（原地引擎的活层信号，喂执行器 updated 集）；S7 handoff 称其
  冗余是误判，保留。
