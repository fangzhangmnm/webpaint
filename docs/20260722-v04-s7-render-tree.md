# 0.4 batch 2 · S7 —— render-tree + gpu-tile-pool + cpu-gpu-tile-bridge（轻量 plan → 施工报告）

> as-of v0.4.7 起工 / 2026-07-22。上游：`docs/20260722-v04-batch1-handoff.md` §4-S7、
> spec `journal/20260721 Architecture.md`（render-tree :123-159、gpu-tile-pool :160-177、bridge :178-186、
> gpu 细节 :245-247）。分支 `worktree-v04-s7-render-tree`（基 main=e2bd316）。
> 本文先当 handoff 要求的「开工前轻量 plan」（钉实现级数据结构），施工完补成报告。

## 0. 轻量 plan（实现级决策，对 spec 需求逐条落地）

### 施工次序（对 handoff 7a/7b/7c 的重排，动机=每步独立 smoke 可验）

1. **7a**：`gl/gpu-tile-pool.ts` + `gl/tile-bridge.ts`，上传路径切 bridge；
   `tile-backend-gl.ts`/`tile-store.ts`/`tile-index.ts` 死（index 纹理类并入 gpu-tile-pool）。
2. **7c-前半**：blend-glsl 累积器预乘 f16 → **straight rgba8**（spec:246-247）。放在 7b 前：
   小 diff、smoke 2D-diff 直接验；让 7b 的 segment 缓存（tile 存 straight）落在干净底座上，
   免得先写预乘↔straight 双轨再拆。
3. **7b**：`render/render-plan.ts`（纯规划）+ `gl/render-tree-gl.ts`（执行器）；
   `gl-doc-renderer.ts` 死；`gl-board.ts` 变薄壳；三个 ad-hoc 注入口统一成 pseudoLayers。
4. **7c-后半**：export 一次性合成路径、SwiftShader golden hash、build.sh 防复活 lint。
   （context-loss/evict 自愈不是独立步——pool/bridge 生来就按「gpu tile missing 是日常」设计。）

### gpu-tile-pool（spec:160-177 逐条）

- 存储 = 单张 `TEXTURE_2D_ARRAY`（RGBA8 straight，NEAREST/CLAMP，同旧 backend）。
  **gpu tile = {id, slice}**：id 全局单调不复用；slice 是易主的物理位。
- **句柄失效协议**：evict/recreate → id 死；`slotOf(id)` 对死 id 立刻 throw（leaky-GPU 红线，
  spec:163）；`isAlive(id)` 给使用者做自愈判定（不 throw 的探测口）。
- **batch-only 创建**（spec:184）：`allocBatch(n): id[]`；无单个创建入口。
  上传/FBO 拷贝走 `uploadBatch(items)` / `copyFromFramebufferBatch(...)`（后者 = copyTexSubImage3D，
  segment 缓存零 readback 入池）。
- **惰性容量**（spec:170）：初始小（64 slices=16MiB），不够时在 quota 内翻倍
  **recreate**（先删旧纹理 → glFlush → 新建，不留 cpu tmp，spec:175）→ 全部 id 作废，
  使用者靠 CPU SSoT 自愈重传。绘制中不产生新 tile（commit 才建）→ 感知成本可接受（spec:176）。
- **pin 回调**（spec:171-174）：使用者 `registerPinProvider(() => ({required, preferred}))`（两档）。
  `frameMaintain()` 每帧：先 evict 孤儿（两档都不在），空间不够 allocBatch 时先扔 preferred，
  required 不扔；还不够 → quota 内 grow；到顶 → allocBatch 抛 `GPU_POOL_EXHAUSTED`
  （调用方降级：segment 缓存不建、直接现算）。
- **纯记账/GL 分离**：pool 核心（free-list、id 表、evict/grow 决策）不碰 gl.*，GL 侧注入
  backend（fake backend 即 node 全测，抄 `test/tile-store.test.mjs` 形）。
- IndexTexture（tile 坐标→slice 的 R32F 小纹理）从 tile-index.ts 并入本模块：值 = pool slice，
  按「源」一张（叶层一张、segment 一张），每帧按映射重建脏了的。

### cpu-gpu-tile-bridge（spec:178-186 逐条）

- `Map<cpuTileId, gpuTileId>` 单向；**禁反查**（spec:186 无 gpu→cpu 查询口）；映射只防重复劳动。
- `ensureUploaded(entries: {cpuId, bytes}[]): gpuId[]`：命中且 alive → 复用（**CoW 身份即内容**：
  cpu tile 不可变，id 相同=内容相同→跳上传。这是 S7 的第一性能收益：commit 后只传变更 tile，
  杀掉「每 commit 全层重传」）；miss/dead → 收集成批 allocBatch+upload。
- `purgeDead(cpuAlive, gpuAlive)`（spec:182）：双向扫，掉队条目清）。
- 大 FBO+bbox 批量口（spec:185）：`readbackTiles(fbo, bboxRect)` 一次 readPixels 切成 cpu tile
  （S8 brush commit 用，本轮交付+测试）；`copyOutTiles(fboTex→slices)` segment 缓存用。

### render-plan（spec:123-159；纯模块，node 全测，zero GL import）

输入：`PlanNode` 树（id/opacity/mode/clip/visible/hasContent + 叶挂 pseudo 标志
{surrogate/overlay/float}——三个 ad-hoc 注入口的统一替身，spec:127-129）+
`updated: Set<id>`（pseudo 锚点自动并入，spec:132）+ `required: Set<id>|null`（null=根，spec:136-141）。

输出（= 钉死的 pass 列表形状）：
```ts
type SegKey = string;                       // "p<parentId>:<firstChildId>-<lastChildId>:pre|iso"
type PlanStep =
  | { t:"leaf"; id; mode; opacity; clipBaseId: number|null; overlay: boolean; surrogate: boolean }
  | { t:"float"; id; clipBaseFloatId: number|null }          // 源层 z 上方独立 pass（现行为不变）
  | { t:"seg"; key: SegKey; mode; opacity; clipBaseId: number|null }   // 画一段缓存
  | { t:"group"; id; mode; opacity; clipBaseId; body: PlanStep[] }     // 含 updated 的隔离组，现算
interface SegBuild { key: SegKey; steps: PlanStep[]; withBg: boolean; memberLeaves: number[] }
interface Plan {
  rootSteps: PlanStep[]; rootBg: boolean;
  builds: SegBuild[];                        // 本帧缺的段怎么现算（执行器只在 cache miss 时跑）
  cacheKeys: Set<SegKey>;                    // 本分区想要的全部段（孤儿段 evict 依据）
  pinLeaves: Set<number>;                    // 必驻显存的叶（updated + live 步的叶 + clip 基底，spec:152）
  liveLeaves: Set<number>;                   // 本帧要直接采样的叶（要 sync 的最小集）
}
```
分区算法（spec:144-155 的「建议跨帧缓存」落地）：
- 每层兄弟数组先按现行 `resolveClipBases` 语义解析 clip；pass-through 组**就地展开**进父序列
  （合成语义本来就是续同一累积器），clip 解析仍按原级做。
- 含 updated 的层级：最低 updated 之下的兄弟 → **prefix 段**（= 累积器前缀态，任意 mode 都能并，
  根级含 bg）；之上的静止兄弟 → 贪心并**连续 source-over 段**（iso 段，含带 clip 的，spec:153-154）；
  静止非 source-over 叶单 pass 直采（无缓存收益）；静止非 source-over 隔离组 → 自成 iso 段。
- 被上方 updated 层当 clip 基底的层：**draw 可以并进段，tile 驻留必须单独 pin**（进 pinLeaves，
  spec:152——clip 采样走基底叶自己的 index，与段无关）。
- 多 updated 兄弟自然支持（live2D 前瞻，spec:130-131/155）。
- `updated=∅`（干净帧）→ 整树并成一个 prefix 段 = 今天 GLBoard._cache 的 plan 化。
- export/吸管：`transient` 模式 → 不产 builds/cacheKeys（合成完即弃，spec:157）。

### 段缓存的物理形态（spec:135/143/165-166 的取舍钉死）

段结果存 **gpu-tile-pool 的稀疏 tile + IndexTexture**（不是 doc-size FBO）：
- 内容 = straight rgba8（7c 之后累积器即 straight → copyTexSubImage3D 直接切片入池，零转换零 readback）；
- 覆盖 = memberLeaves 的 tile 并集（prefix 含 bg 时=全 doc tiles）；
- 画一段 = 与叶同一条 `sampleTiled` shader 路径（段≈一张合成层）；
- 缓存失效：`invalidateAll()`（undo/redo/commit → board markContentDirty 现有信号，spec:134）
  + 分区变化时孤儿 key 随 frameMaintain 的孤儿 evict 自然回收；
- 组有 gpu-tile 无 cpu-tile、段内孩子有 cpu SSoT 无 gpu 缓存——正是 spec:166 的解耦形。

### 7c-前半：straight rgba8 累积器（spec:246-247）

- blend-glsl：`u_dst` 读直值（去掉解预乘）、输出 `o = vec4(Csb 合成后直值, ao)`
  （除 ao，ao=0 出 0）；group 源同理；warp live pass 同理；present 不再解预乘
  （PRESENT_FRAG 留 `u_unpremult` 开关给 stamp 栅格器的预乘中间 FBO 用）。
- 借 FBO 全部 "u8"（f16 路径保留在 GLContext 不删，栅格器不动——**手感红线零接触**，
  gl-stamp 本来就 u8）。
- 风险（handoff 点名）：预乘→straight 可能移动混合视觉。安全网 = smoke 现成的
  vs-compositeLayers 逐像素 diff（maxΔ≤4）+ 新增 golden hash；真机批再兜。
  注：Canvas2D 内部是预乘 u8，straight u8 精度只会更高不会更低。

### render-tree-gl（执行器）+ 接缝

- `GLBoard` 保留为 board.ts 的唯一接缝（签名不动），内部 `GLDocRenderer` → `RenderTreeGL`。
- RenderTreeGL 持有：pool、bridge、slim 后的 GLCompositor（只剩 pass 原语）、栅格器、
  per-叶 sync 态、段缓存表、float/overlay/surrogate 物化（从 gl-doc-renderer 原样搬）。
- 帧流：算 updated/pseudo → plan（结构+updated 没变可复用上帧 plan）→ bridge sync liveLeaves
  （逐 tile 身份跳传）→ cache miss 的段现算入池 → rootSteps 合成 → presentAffine。
  完全干净帧（无 dirty 无 live）继续走「只 present 上帧结果」的现有 early-out。
- 自愈：每帧对用到的 gpu id `isAlive` 校验，死了就地重建（叶→bridge 重传；段→重算）；
  context-loss = pool.recreate + bridge/段全清 + 下帧全量重建（现 syncAll 语义的 plan 化）。
- `LAYER_NOT_SYNCED` throw 死（test-charter H2 的病根）：sync 不再是前置契约而是帧内保证。

### 测试

- `test/gpu-tile-pool.test.mjs`：fake backend；分配/批次/UAF throw/双档 pin/孤儿 evict/
  grow-recreate 全失效/quota 顶到抛；**leaky-GPU 对抗模拟**（随机 evict，使用者必须自愈，charter (c)）。
- `test/tile-bridge.test.mjs`：身份跳传/批量/purgeDead/禁反查（无这个 API 即为证）。
- `test/render-plan.test.mjs`：分区 golden（prefix/iso 并段矩阵、clip 基底 pin、pass-through 展开、
  多 updated、required 剪枝、transient、干净帧=单段、key 稳定性）。
- smoke harness 改接新管线，原有 vs-compositeLayers diff 全保 + **首次 golden 图像 hash**。
- 现有 803 node 测试全绿不回退（tile-store.test.mjs 死，等价覆盖并入 gpu-tile-pool 测试）。

### 不做（诚实边界）

- brush ready/commit 改走 bridge 的 doc-FBO 方案、液化 doc-space mask、吸管 GPU read —— S8。
- layer-composite.ts 日落、Canvas2D 残余收缩 —— S9。
- 段缓存跨 doc 尺寸变化的保留 —— 不做（doc 尺寸变=全清，现行为）。

## 1. 施工记录（v0.4.8 / 2026-07-22 完工；分支 worktree-v04-s7-render-tree，未 merge 未真机）

> 824 node 测试 + tsc + esbuild + smoke（SwiftShader 真 WebGL2）全绿。四个源 commit：
> 2dadf0a(7a) → 8db507c(7c-前半 straight) → d5fb643(7b) → c5127d8+958d893(v0.4.8+bundle)。

### 落了什么（按 §0 计划次序，全部按计划落地）

1. **7a**：`gl/gpu-tile-pool.ts`（纯记账核+GL backend+IndexTexture 并入）+ `gl/tile-bridge.ts`。
   §0 计划全部成立，施工中追加的点：
   - `reserve()` 语义改为**绝对目标**（调用方给「本帧工作集 tile 总数」），比「增量 n」精确。
   - 池加**「本帧 touch 过的 tile 不驱逐」不变式**——压力驱逐若帧内易主 slice，已 rebuild 的
     index 纹理会采到别人的像素（一帧视觉污染）。帧间驱逐无此问题（每帧先 isAlive 校验）。
   - 叶 sync 快路径 = (LayerPixels 实例身份, contentVersion, pool 代) 三元组；bridge 惰性取
     bytes → 压缩驻留的 tile 在 GPU 副本活着时**连解压都不发生**。
2. **7c-前半**：累积器 straight rgba8（blend-glsl 主 shader / warp live / group 源 / present 全链；
   present 留 `unpremult` 开关给 stamp 栅格器的预乘中间 FBO）。smoke 增 u8 精度 12 blend parity：
   ⚠ **color-dodge/color-burn maxΔ=10**（阈 ≤10 过；误差放大器模式，真机批留意观感，
   不行就把累积器精度参数拨回 "f16"——参数留着，一行换）。
3. **7b**：`render/render-plan.ts` + `gl/render-tree-gl.ts`，`gl-doc-renderer.ts` 死，
   `gl-board.ts` 薄壳化。计划外的收获：**livePreview/forceSync 门控整个消亡**——旧门控存在
   是因为 syncAll 全量重传太贵；增量 sync 后「lift 挖洞要 forceSync」「liquify 要 live-sync 例外」
   全变成 contentVersion 快路径的自然路径。板级参数保留（board.ts 不用改调用），执行器忽略。
4. **7c-后半**：`compositeOnce()` export 一次性路径（不建缓存不失效；本轮交付+smoke，S9 接线
   导出/缩略图时消费）；golden 基线机制；build.sh 防复活 lint（S7 四死模块）+ render/ 层次 lint
   （**当场抓到 preview.ts 一处死 import** 并移植——lint 值回票价）。

### 与 handoff §4-S7 的两处偏差（诚实交代）

- **7c 拆两半夹在 7a/7b 两侧**（straight 切换先行）：让 7b 的段缓存生在干净底座上，
  免写预乘↔straight 双轨。每步独立 smoke 可验，风险更低。
- **golden 用 16×16 平均池化快照（tol=6）而非图像 hash**：SwiftShader 版本间 LSB 抖动会让
  精确 hash 假红；池化快照抓的正是「预乘→straight 视觉移位」这个量级的回归，且现有
  vs-compositeLayers 逐像素 diff（maxΔ≤4）本来就比 hash 强。基线 `test/gl-smoke/goldens.json`
  已录（缺文件自动首录；`SMOKE_UPDATE_GOLDEN=1` 重录）。

### 测试落点

- node：`gpu-tile-pool.test.mjs`（批次/pin 两档/LRU/grow/quota/**leaky-GPU 对抗模拟**）、
  `tile-bridge.test.mjs`（身份跳传/purgeDead/FBO 切片）、`render-plan.test.mjs`（17 条分区 golden）、
  `tile-geometry.test.mjs`（自 tile-store.test 迁出）。824 总量。
- smoke：原有全部 parity 保住（含 u8 新档）+ **11 条执行器端到端**（干净帧/快路径/live 分区/
  段命中改层/markDirty 失效/context-loss 自愈/compositeOnce，全 maxΔ=1 vs compositeLayers）
  + 2 张 golden 基线。
- HUD：第二行加 `sb<建段> sh<段命中>`（`!`=quota 降级）。**描边中的理想形态 = sb0 shN**。

### 帧算法一句话（给下个读者）

markContentDirty → 段全失效；每帧 buildPlan(树+updated+bg) → 缺段现算入池（copyTexSubImage3D
零 readback）→ live 叶增量 sync（tile 身份去重）→ rootSteps 合成 → display FBO → presentAffine；
无 dirty 无动态且 plan 签名没变 → 只 present（pan/zoom 帧）。所有 gpu 侧状态可随时蒸发
（evict/grow/context-loss），下帧从 CPU SSoT 自愈。

## 2. 真机待验（并入 batch1 §3 + S5 §3 + S6 §4，同批交付）

**S7 是纯渲染重构，语义零变化**——验法 = 全功能回归 + 盯性能/显存读数：

- 描边性能（本片主收益）：多层文档（10+ 层，含 clip/组）画笔描边 fps vs v0.4.7；
  HUD 第二行 `Np` 应从 层数 掉到 个位数、`sb0 shN`（描边首帧 sbN 一次，后续全命中）。
- clip 层繁重场景（v339 动态预算的 11 层痛点）＋液化（live-sync 路径：每帧 sb0 且只重传变更 tile）。
- 混合模式观感：**color-dodge/color-burn**（u8 累积器 Δ10 处）+ 半透明多层叠、软边笔刷淡色累积
  （u8 straight 的量化最可见区）。刺眼 → 累积器拨回 f16（一行）。
- 变换整链（S6 清单重跑一遍——float pass 走了新执行器）：lift/拖动/stamp/accept/reject/undo 穿越。
- 颜色调整 live preview（surrogate 换源路径）+ 抬手恢复。
- 图层操作全家（增删/移动/显隐/透明度/模式/编组）——每一下都该 markDirty → 重建正确。
- pan/zoom 手感（快路径）+ 长 session 显存曲线（HUD tile 数有界、FBO 池有界、`!` 不常亮）。
- 切后台回来 / GPU context-loss 恢复；加密件、云同步、导出 ora/psd/png 不回归（导出仍 CPU 路径）。
- 大文档（4K²）：池惰性增长（初始 16MiB → 按需翻倍）不再一上来承诺 256MiB。

## 3. 遗留 / S8 交接

- **brush ready/commit 改 doc-FBO + bridge 批量 readback**（spec:187-205）= S8 主菜。
  消费口已备好：`sliceRegionToTiles`（bbox 一次 readPixels 切 tile，测过）+ `registerPair`。
  现 commit 仍走 rasterize→canvas→editRegion 旧径（本片未动，行为不变）。
- 吸管 `ensureCompositeCache` 仍 CPU 合成（S8 换 render-tree 单帧 GPU read——`compositeOnce`
  已能当基础）；导出/缩略图仍 layer-composite.ts（S9 日落时接 compositeOnce）。
- 选区 mask 仍 R8 bbox 平面直传（S5 注释里说的「S7 改 bridge per-tile」**没做**：一次描边一传、
  身份缓存已够，等 S8 brush ready 重做时一起收，不值得单独铺 gray8 gpu 池）。
- board.ts 的 `forceGLResyncUnderFloat`/`_wasFloatActive`/liveSync provider 机器现已冗余
  （执行器忽略这些 hint，contentVersion 自愈）——**留着无害**，S8 动 brush 接缝时顺手拆。
- GLCompositor 自己的树递归 composite() 保留：smoke harness 的规范执行器 + 对拍参照，
  生产路径不再走它（执行器直接驱动 pass 原语）。
- 段建造在极端显存压力下可能与后续建段互抢（reserve 预检大幅降低概率；抢败=该段本帧临时
  直算，不缓存，正确性无损）。真机若见 `!` 常亮 = quota 太小，调 poolCapacityForBudget 预算。
