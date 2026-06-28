# 性能 / 内存 / clip — WebGL2 + tiling 全量重写（工程主文档）

> as-of v326 / 2026-06-27。**决策 + 架构 + 路线图**（why 类，耐老化）。前身是 v276 的同名 doc（真机实测 + 三明治/clip缓存权衡，已并入「历史权衡」节）。
> 定调：**全 WebGL2 重写合成器 + 笔刷栅格化 + tiling 图层存储**，greenfield，不留 Canvas2D 回退尸体。旧 2D code 走 git 备份 + 冻成 golden fixture，重写完即删。

---

## 0. 真机现状（v276 用户 iPad mini 实测，仍是出发点）
- pan = 60fps ✓（board 1:1 合成缓存）。plain 描边 = 60fps ✓。**clip 蒙版描边 ≈ 30fps ✗**（本工程核心痛点之一）。
- 11 个 plain 图层仍 60fps → 多图层本身不掉帧，partial-render 没必要（v275 已删）。
- 内存偏紧：iPad mini 2K ~11 层已紧。每满幅层 ≈ 2048²×4 ≈ 16.8MB；11 层 ≈ 184MB。

## 1. 为什么是 11 层 vs Procreate 的 124 层（已查清，含上一轮乐观说法的修正）
`computeMaxLayers = clamp(deviceMemory×0.15, 64, 192) / (W·H·4)`。iPad Safari `navigator.deviceMemory` 缺失→回退 4GB→预算被 **clamp 到 192MB** / 16.78MB ≈ **11**。
Procreate iPad mini 6（4GB RAM）2048² → **124 层**：反推 ≈ 2GB 预算 / 16.78MB ≈ 124（**此 2GB 是反推 Procreate 原生 app 的预算，不是任何文档数，更不是 PWA 数**）。

**真正的差距是 web ↔ native 的内存待遇，不是每层公式（两边都≈满幅 16.78MB 最坏）：**
- **PWA/Safari tab 的真上限 = iOS jetsam 每-tab 限额**（已查）：多数设备 ~300–450MB，高 RAM 新 iPad 才报到 ~1–2GB；WebKit MemoryPressureHandler 与 jetsam 取小者，过半即开始施压。web 内容被杀得比原生狠 → 我们拿的远比 Procreate 原生的 ~2GB 少。
- **修正上一轮的乐观说法**：我说过「WebGL 纹理不计入 Canvas2D 池 → 直接抬预算」。半对：WebGL **确实**绕开 Canvas2D backing 那个 ~384MB 子池，但**统一内存下纹理仍算进同一个 jetsam 每-tab 总预算**。低端 iPad mini 上 384MB 子池≈整个 tab 预算 → 绕开它并不凭空多给一大块；高 RAM iPad 上 tab 预算大得多，WebGL+tiling 才真能解锁更多层。**绕池不是银弹。**

→ 抬层数的真杠杆排序：① **tiling**（让实占 << 预算，是稳健主力，任何设备都吃到）；② WebGL 砍掉 ~50–100MB 辅助 2D canvas + 绕 384MB 子池（高 RAM 设备收益大）；③ Stage 0 在目标 iPad **实测真预算**再定 cap。别再把「绕池」当主力。

## 2. clip 为何贵（live 描边路径）
描边走 live 直接合成，每帧重合**所有**层。clip 层每帧 = `clearRect(tmp)+drawImage(clip→tmp)+drawImage(base→tmp,destination-in)+drawImage(tmp→screen)` ≈ 4× plain。**关键浪费**：描边期间**静态** clip 层（clip 和 base 都没在画）也每帧重算 60×/s，结果每帧相同。
→ WebGL 原生解：fragment shader 里 clip = 采基底 alpha 一次过，无 tmp canvas、无 dst-in dance；静态层 tile 已在 GPU，重合成只是重采样。

---

## 3. 目标架构（全 WebGL2，7 个深模块）

**定调**：iPad/桌面都有 WebGL2（iOS 15+ / 2021，**远早于任何 Apple Pencil 设备**——初代 Pencil 的 iPad Pro 2015 也能跑 iPadOS 16）→ **不留 Canvas2D 回退**。古董纯指绘设备给「需要 WebGL2」提示。选 WebGL2 不选 WebGPU：iPad 是手感裁判，WebGL2 有 MAX blend / TEXTURE_2D_ARRAY / FBO 全部所需且铁稳；WebGPU 留未来，本工程不 re-litigate。

领域核心：**文档 = 图层栈；每层 = 稀疏 256² tile 集合的 RGBA8 像素；一切产像素的(笔/填充/变换/滤镜)写 tile，一切耗像素的(板显/导出/缩略图/吸管)读合成后的 tile。**

| # | 深模块 | 窄接口 | 藏住的行为 / deletion test |
|---|---|---|---|
| 1 | **GLContext** | `gl()`,`program(name)`,`borrowFBO/return`,能力位,`onLost/onRestored` | 单持久 context、shader 编译缓存、FBO 池、quad VAO、**context-loss 生命周期**。删→每个 GL 调用方重搓 |
| 2 | **TileStore**（内存杠杆） | `layer.tileAt(tx,ty,{create})`,`forEachTile`,`allocatedTileCount`,`freeTile` | 稀疏分配(空 tile=0 内存)、全透明 tile 回收、`TEXTURE_2D_ARRAY` slice 自由表、内存核算。**突破层数上限的核心**。删→每读写方自管 slice+稀疏 |
| 3 | **TileResidency**（安全/恢复，本轮新增） | `pin/unpin(layer)`,`evictColdTiles()`,`recoverAll()`,`autosaveTick()` | 压缩备份(RAM)+autosave 到 OPFS；`webglcontextlost→restored` 从备份重上传；**lazy 驻留/分页**(不一次物化整个重文件)+**冷层逐出压缩/磁盘**。**这是「不崩、不毁文件」的模块** |
| 4 | **Compositor**（替代 layer-composite.ts） | `composite(tree, target, {viewport, overlayFor, floatFor})` | ping-pong 16F 累积、12 可分离 blend + clip(shader 采基底 alpha)、组隔离(子累积器)、pass-through。**真 seam**：target=屏 vs 离屏 readback（两 adapter）。删→合成又在 板/导出/缩略图/吸管 漂移 |
| 5 | **StrokeRasterizer**（GL 笔刷栅格化） | `begin(brush,p0)`,`extend(p)→dirtyRect`,`previewTexture()`,`commit()` | 实例化 stamp quad、fragment 内 `1−u²(3−2u)` falloff、Build-Up(source-over 累积) vs Wash(`blendEquation MAX`)、**flow 在 Π 内/opacity 在 Π 外**、taper。删→笔刷数学四散。**消费 StrokeSmoother 中心线**(不重写平滑) |
| 6 | **Board** | 现有 requestRender/pan/zoom 大致不变 | 视口+rAF 调度；pan/zoom=换 viewport transform 重合成（GPU 便宜，可能砍掉 composite cache） |
| 7 | **PixelReadback adapter** | `readLayer/readComposite → ImageData/blob` | .ora/PNG/PSD/undo/吸管 统一从 GPU readback；非实时路径，低频 |

**刻意不动 / 不抽的边界**：
- **StrokeSmoother（CPU，保留不动）**：二阶临界阻尼 SmoothDamp + 动量弧 tail，把 raw 指针流平滑成中心线 `cx/cy/cp[] + tail`。这是**顺序状态化的矢量平滑**，本就不是并行像素活，塞 shader 荒谬。「WebGL 重写笔刷」= 栅格化(stamp→像素)进 GPU，**平滑留 CPU**——正确模块边界，不是恋旧。
- **PixelEdit（保留，重指向 tile）**：undo 事务深模块(begin 拍 before / commit 拍 after+压 PNG / abort 还原)，stroke·liquify·filterBrush·shapes 复用。接口不变，底下 `Layer.snapshot()/restoreFromSnapshot()` 从「bbox ImageData」改成「变更 tile 集」。GL 笔刷照样 `PixelEdit.begin()…commit()` 插进去。
- **GLContext 单实例**：一个 adapter → 不做「渲染后端可换」抽象（否则得养 2D 尸体）。

**手感钉死的数学是移植目标 spec，不是要保的旧 code**：falloff `1−u²(3−2u)`、Wash=max、flow·opacity 分离、streamline tau、taper、压感 gamma。实现全 GL 重写，用 golden 对拍卡住数学。

---

## 4. 本轮硬问题的设计答复（并入架构，避免文档即刻过期）

### 4.1 不上传纹理 ⇒ RAM 不存图层？——半对，且这是 context-loss 的命门
图层像素驻 GPU 纹理后，**显示/合成/绘画不需要 CPU 常驻副本**（iPad 统一内存下 GPU 纹理与 RAM 同一物理池，省的是「第二份副本」；PC 独显下真省系统 RAM）。但 **save/undo/吸管/缩略图需要 CPU 像素 → readback-on-demand**（非常驻）。**致命点**：context 一丢纹理全没 → **不能纯 GPU 驻留无备份** → TileResidency 持一份**压缩备份**(RAM 压缩 tile + autosave 到 OPFS)，掉 context/被杀后从备份重建。
**「双份内存」的修正**：备份是**压缩 tile**（PNG/zlib ≈ 1–4MB/满幅层），不是 raw 16.78MB → 额外只 ~1.1×，不是 2×。所以「GPU+RAM 双份」不是主要因素，主要因素是 web↔native 待遇（§1）。
**Procreate 不付这份税**：原生 Metal **后台不丢 GPU 资源**（无 WebGL 那种 context lost 事件），统一内存里就一份 tiled 副本、冷 tile 分页到磁盘；被整个杀才从存盘重载。我们这点 ~1.1× 是 web 端「context 可丢」的固有税。

### 4.2 不设层数上限会 OOM/闪退/毁文件？——会，所以要软上限（不是硬上限）
不设任何限 + 用户堆层堆到 OOM：iOS jetsam 杀 tab/PWA → 未存丢失；更糟，**磁盘文件编码的 tile 多到载入即 OOM → 打开就闪退的毒文件**。
**但上限必须软（resize 时的 hint + 警告），绝不能硬（拒绝操作/拒绝打开）**——因为高 cap 设备（iPad Pro 8–16GB）存的 60 层 .ora 必须能在 iPad mini 上**打开**（分页降速，不是拒开/损坏）。硬 cap = 跨设备毒文件。
对策（TileResidency 负责）：**实占内存感知的软上限 + 临界前警告**；**lazy tile 驻留**(载入不一次物化所有 tile，按可视/活跃流式上)+**冷层逐出压缩/磁盘** → 重文件**退化(变慢)而非崩溃**，文件永远可开。这正是 Procreate 的分页模型。
**保守估算（待 Stage 0 实测校准）**：满幅层 GPU 16.78MB + 压缩备份 ~1–4MB ≈ ~18–21MB/层；按 iPad mini PWA tab 预算保守取（§1，~300–450MB 偏低端）→ 最坏满幅 ~15–25 层、配 tiling 稀疏典型可达 30–50+。**30–50 对二次元工作流 good enough**；真数 Stage 0 在目标机测。

### 4.3 undo 用高压省内存？——真杠杆是 tiling 的 per-tile delta，不是更高压缩比
undo 必须**无损**(有损快照=静默改像素=数据红线)，PNG/zlib 已够，调高压缩级别只是边际。真省内存的是：tiling 后一笔只碰几个 tile → undo 快照 = **只存变更的 tile**(per-tile delta)，不再是整个 layer bbox。PixelEdit 的 before/after 快照天然映射成 tile 集 → 典型描边 undo 内存大降，免费。

### 4.4 旁边跑大游戏抢显存 / 切出去玩回来 → GL context 怎样？（PC+iOS，browser+PWA）
**已查实**：iOS Safari/PWA 后台**会丢 WebGL context**（尤其旁边大游戏逼近显存上限时，iOS 16.7/17 已知行为；Safari 17.1.x 缓解部分误丢但根本机制还在）。PC(独显)旁边跑游戏 → 显存争用可触发 context lost / TDR GPU reset，纹理失效。
- **PWA(standalone) 比 Safari tab 更易被后台杀**（iOS 历史如此）→ 全杀场景必须靠 autosave 重载恢复。
- 统一对策(TileResidency)：①必接 `webglcontextlost`(preventDefault)+`restored`(从压缩备份重上传所有 tile/重编 shader/重建 FBO)；②**autosave 到 OPFS** 兜「整 tab/PWA 被杀」；③主动**降显存压力**(逐冷层、空 tile 不占)让丢的概率更低。
- 同屏开原神参考：可行但显存共享，本就该靠 ①②③ 兜——这恰好是 TileResidency 存在的理由，不是额外负担。

---

## 5. 分阶段（深模块构建序；旧 2D 输出冻成 golden fixture 当对拍基准，重写完删）
1. **GLContext + TileStore + TileResidency 骨架** — 地基。TileStore 靠 readPixels round-trip 测稀疏/回收，不依赖显示。TileResidency 先做 context-loss 重建 + autosave round-trip 测。
2. **Compositor** vs TileStore — golden 对拍：12 模式+clip+组 像素匹配冻结的旧 2D 输出。Board 切 GL；载入/commit 时把现有像素桥接进 tile（**唯一过渡桥**，phase 3 删；用户已认可中途 iPad 测一次）。**交付：clip 60fps + tiling 内存 + 抬层数上限 + 验证 WebGL 是否逃出 Canvas2D 池。真机批 #1。**
3. **StrokeRasterizer** — GL stamp→stroke FBO→tile commit，删 CPU 栅格化 + 过渡桥。golden 对拍现笔刷(Wash/Buildup/falloff/flow·opacity)。**交付：全 GL 管线 + 16F 去 banding(bonus)。真机批 #2(手感裁判)。**
4. **收尾** — 删 layer-composite.ts/ensureBbox/composite cache/erase·clip temp；导出·缩略图·吸管走 GL readback；`computeMaxLayers` 改 tile 实占软预算 + 警告；内存 HUD。

风险集中在 **②Compositor blend 对拍** 和 **③笔刷手感对拍**，两处都 golden 卡死、不靠真机兜底。worktree 上做，WIP commit 防丢，coherent 后真机批量验、merge 回 main。

## 5.5 落地进度（as-of 2026-06-27，worktree 分支 worktree-webgl-tiling，未 push/未接 board）
**验证栈三层**：`npm test`（node 纯逻辑 453）→ `npm run smoke`（真 Chromium WebGL2/SwiftShader 48 项，
  Playwright 无头）→ iPad 批（手感/fps/内存，**尚未做**）。Chromium≠iPad GPU，故 smoke 不当像素美学真相；
  但 blend/合成是确定性数学 → 同引擎 2D-vs-GL 自 diff 对 iPad 也有效。

**Stage 1 地基（完成+验证）**：
- `gl/tile-geometry.ts` `gl/tile-store.ts`（TilePool 自由表+LayerTileMap 稀疏 map）— node 测。
- `gl/gl-context.ts`（WebGL2 封装/能力探测/program 缓存/FBO 池 u8·f16·f32/context-loss 生命周期）。
- `gl/tile-backend-gl.ts`（TEXTURE_2D_ARRAY 稀疏池；**texStorage3D 预分配=承诺显存**，capacity=预算）。
  — Chromium smoke 验真 GPU 上传→读回 round-trip。

**Stage 2 合成器（特性完整+验证）**：`gl/gl-compositor.ts` `gl/blend-glsl.ts` `gl/tile-index.ts` `gl/gl-compose-plan.ts`。
  ping-pong 预乘累积，一层一 pass，多 tile 走 tile-index(R32F) 查找。对**真 layer-composite.ts compositeLayers** 自 diff：
  12 blend Δ2 / clip Δ2 / 多 tile 稀疏 Δ1 / 组(隔离·pass-through·嵌套·组内clip) Δ1-2 / overlay(normal/erase) Δ1-2。

**验证中查清的事实（写给下个 session，免重踩）**：
- **color-dodge/burn**：opaqueProbe 证 B() 对全 256²(Cb,Cs) 与 Canvas2D 逐位 Δ0；仅「半透叠半透」Δ~10
  （Skia 预乘域 vs 我们 W3C 直值域，≤4% 不可辨，真实绘画精确）。要逐位精确就把这 2 模式改 Skia 预乘域分量式。
- **f32+LINEAR 需 OES_texture_float_linear**，iPad/SwiftShader 不保证 → 累积器/中间 FBO 一律 1:1 NEAREST。
- **未用 sampler 未被编译器消除时默认落单元0**（与 sampler2DArray 撞类型 → 0x502）→ 每 sampler 固定单元+占位纹理。
- **递归 composite 不能碰 VAO 绑定**（末尾解绑会废掉外层后续 pass）→ public composite 绑一次，递归走 _composeFresh。
- **16F 累积器**是默认（省一半 transient + banding bonus）；f32 仅精度验证/陡模式可选（仅累积器一张，不乘层数）。

**doc→GL 渲染路径（完成+验证，不碰生产 board）**：
- `gl/gl-doc-bridge.ts`：uploadLayerToTiles（Layer Canvas2D bbox 像素 → 稀疏 tile，带偏移切分/空 tile 跳过/池满软上限）
  + docTreeToComp（doc 树→CompNode 纯翻译，safeMode 未知模式回退）。结构化类型，gl/ 与 doc.ts 解耦。7 node 测。
- `gl/gl-doc-renderer.ts`：GLDocRenderer 编排（syncLayer/syncAll/renderToScreen/composite/dropLayer + memory 核算）。
- `gl/gl-compositor.ts`：presentToScreen（默认 framebuffer + Y-flip；readback 不翻）。
- smoke 端到端：bbox 裁剪层(含偏移)+隔离组+组内clip → 真桥 → GL vs compositeLayers **Δ1**。
- `test/gl-smoke/preview.{html,ts}`（`npm run preview:build`）：demo 文档(含2 clip+multiply 组)每帧整树重合成。
  **SwiftShader(CPU 模拟 GL) 实测 1024²/6 层 57fps、仅 67 tile/16.8MB**（真 iPad GPU 更快）→ clip 层=纹理采样
  无 dst-in dance，clip-60fps 痛点已解；稀疏生效。**iPad 可开 preview.html 肉眼看 + 量真机 fps。**

**接生产 board（完成 + iPad 实景验证，v335-v336）**：`gl/gl-board.ts` GLBoard 委托，`?glboard=1` 开关（默认 2D 不变）。
GL canvas 垫 #board 下渲 doc（void+背景+图层+live overlay，视口仿射）；2D #board(alpha) 在前画 lasso/边框。
- v335：接通，iPad 实景画出来了（正确性 OK：doc/描边/视口/blend/clip 都对）。
- v336 perf：合成缓存(pan/zoom 只 present 不重合成→pan 60fps)+bbox overlay(描边只传 bbox 不传 doc 尺寸→draw 17→30fps)
  +LINEAR present(缩小抗锯齿，修狗牙)。preserveDrawingBuffer:true(按需渲染须保空闲帧)。
- **现状（用户 iPad 实测 v336）**：pan 60fps ✓，draw 30fps（够用，待优化），狗牙修了。

---

## 5.6 待办 backlog（按部就班，别忘；优先级见「主轨」）

**A. perf（draw fps / 重合成）**——correctness OK，不急：
- draw 30fps：描边时仍**每帧重合成所有层**。优化：active 层上/下夹缓存（**三明治当年因 above 多 blend 被否，得想别的**，如：只缓存 below-active，above 单独）；或 per-layer 脏只重合脏层。
- syncAll：内容变就全层重传（commit/undo）。优化：**per-layer 脏跟踪**（board 知道 active 层，只 syncLayer(脏层)），消除多层文档抬笔卡顿。
- overlay 仍每帧 setOverlay（bbox 小，但可只在 sm.seq 变时传）。

**A2. 视口狗牙 = 已解决（v336，用户真机确认不狗牙，stick to this）**：present 缩小(scale<1)用 LINEAR、
  放大(scale>1)用 NEAREST，对齐 2D `_renderFull`（scale>1 关 imageSmoothing、scale≤1 平滑）。原狗牙是早期全 NEAREST 造成。

**B. grid 重做（用户提，用 shader 更舒服）**：
- 现状：像素栅格 = 独立 #boardGrid 2D canvas，仅视口变时重画（_drawGrid，scale≥4 渐显，device-px 对齐 fillRect）。GL 模式下仍工作。
- 重做：grid 进 **present shader**（或一个 GL pass）——按视口直接在片元算网格线，省掉独立 canvas + 每次视口变的 CPU 重画。阈值/渐隐/device 对齐照搬 PIXEL_GRID_FADE_LO=4/FULL=7/ALPHA=0.4。

**C. GL board 功能缺口（correctness，用户当前工作流没卡，低优先）**：
- lasso 自由变换的**内容预览**（floatFor）GL 下不显示；棋盘背景显 void；blendMode-overlay(非常规笔 live 预览)按 normal。
- 吸管：GL 模式现仍按需建 2D 合成缓存取色（对但冗余）→ 可改读 GL 合成 readback。

## 5.7 主轨 roadmap（最重要，按序推进）
1. **Stage 3：GL 笔刷栅格化**（StrokeRasterizer 消费 CPU StrokeSmoother 中心线 → GL stamp；Build-Up=source-over/Wash=MAX；
   flow-in/opacity-out；smoothstep falloff 照搬）。完成「改成 webgl」primary，golden 对拍现笔刷；live 描边全 GPU(去 CPU overlay)。
2. **tiling 存储**（11 层 / 内存目标 = 原始「顺便」诉求）：图层像素从 Canvas2D bbox 画布迁到稀疏 tile（去 16.8MB/层）。

   **爆炸半径已 survey（2026-06-27）**，设计 = **单一虚拟化点**：
   - **tiles = SoT**（稀疏 256² CPU 像素 + GPU 上传给 GL 合成）。
   - **`Layer.canvas` → 按需物化的 bbox 视图**（getter：无则从 tile 物化；可丢弃释放内存 → inactive 层只留稀疏 tile）。
     → 绝大多数**读者不用改**（layer-composite/ora/psd/reference/board 都读 layer.canvas 或 opts.source）。
   - **直接写 layer.ctx 的写者**（brush commit `brush.ts:507/516`、filters `:299`、filters-adjust `:178`、liquify
     `:281`、floating-transform `:235`、selection `:274/288/297`、selection-ops `:74/81`）：写进物化 canvas 后**脏区刷回 tile**。
   - **整体替换 canvas 的写者**（merge `doc.ts:608`、变换 `:934/962/996/1041/1082`、clear `:818`、import、ora 导入）：重写整个 tile 集。
   - **snapshot 货币**（`snapshot/restoreFromSnapshot` + imageData|blob|bitmap，被 pixel-edit/layer-undo/blender/duplicate 消费）：
     改成 per-tile delta（或兼容保留 imageData 路径先不动）。
   - **手感隔离**：active 层物化 canvas 常驻供笔刷描边（现状不变），commit 后脏区刷回 tile。

   **切片**：① Layer tile-SoT + 物化 canvas 写穿（**先不丢 canvas，内存中性，只换 SoT**；save/undo/全 op round-trip 守门）——
   keystone，数据完整性关键。② inactive 层丢 canvas（真省内存）+ 抬 computeMaxLayers。③ snapshot→per-tile delta（undo 内存）。
   ④ GL board 直读 tile（去每帧 re-tile）。⑤ TileResidency（GPU-only inactive 层的掉电/autosave/逐出）。
3. **TileResidency**（配 tiling 存储才有意义）：压缩备份 + OPFS autosave + context-loss 重上传 + 冷层逐出（§4.1/4.2/4.4）。
4. **抬 computeMaxLayers** 软上限（tiling 后实占 << 预算）+ 内存 HUD；GL 稳后删 2D 路径 / 去 ?glboard 开关成默认。

## 6. 历史权衡（v276 已论证，留作不 re-litigate）
| 方案 | 结论 |
|---|---|
| 三明治(缓存 active 上/下) | **否决**：active 上方多个不同 blend 时 above 无法预合成一张 source-over → 频繁回退全合。用户点破。 |
| clip 结果缓存(每静态 clip 层缓存 clip∩base) | 可行但**加内存**，内存吃紧下方向错 → WebGL 原生解之，不需要。 |
| partial-render | 11 plain 层 60fps 证明多层不掉帧，复杂度没必要(v275 已删)。 |

## 7. bonus（in-reach，不进核心范围免膨胀）
- **RGBA16F 累积关 banding**：tile 存 RGBA8(省内存)，合成/笔刷累积在 RGBA16F FBO(去 8-bit round)，present 落 8-bit。顺手修 backlog 大喷枪 banding，不翻倍图层内存。

## 引用
- 现 2D 合成器：`src/layer-composite.ts`（重写后删，先冻 golden）。
- 现笔刷：`src/brush.ts`(栅格化重写) + `src/stroke-smoother.ts`(**保留**) + `src/resolved-brush.ts`。
- undo 事务：`src/pixel-edit.ts`(保留，重指向 tile) + `src/history.ts`。
- 图层存储：`src/doc.ts`(`Layer`/`computeMaxLayers`/`ensureBbox` 改 tile)。
- board：`src/board.ts`(`ensureCompositeCache`/`render`/视口)。
- blend 列表(12 可分离)：`src/layers-panel.ts:71` `LAYER_MODE_LABEL`。
