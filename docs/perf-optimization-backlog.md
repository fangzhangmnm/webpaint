# WebGL 渲染性能优化 backlog（给 fresh agent）

> as-of v359 / 2026-06-29（§0 复核 + §3 已修；原 §1/§2 仍开）。**优化建议 + 起点**（会腐烂的 how 类，动手前先按 §0 量一遍）。地基已收成单一 GPU SSoT（见 docs/canvas-render-audit.md：全库无 CPU display 路径）——优化只针对 GPU 合成/warp 热路径，别去碰离屏 CPU（吸管/导出/缩略图/滤镜计算）。
> 现状帧率：用户真机报「clip 多层 40-50fps（目标稳 60）」「组变换 clip 拖动帧率有点低」。WebGL 重构 #1-#3（架构）+ #5（GPU warp）已完成。本 doc = 原 #4（性能）+ #5 引入的新热点。

---

## §0 先量后优（铁律，别猜）
动任何优化前先定位真瓶颈，否则白干：
1. 加帧计时（board 已有 `_fps`，board.ts `_tickFps`）——先确认掉帧场景（空层描边？clip？组变换？大笔？）。
2. **v359 起 HUD 已有每帧归因第二行**（开 FPS 即显）：`Np f Nf s Ns` = blend pass 数 / 浮层 warp pass 数 / overlay stamp 数。
   - `Np`（passes）直读 **§2 layer-count 假说**：clip 多层掉帧时 Np 应≈可见层数，确认「pass 数 ∝ 层数」是瓶颈。
   - `Nf`（floatPasses）= §3/§4 浮层 pass 数（组变换 N 源层 = N）。`Ns`（stamps）= §1 长描边二次爆炸的直读（描边越长 Ns 越大）。
   - 来源：`gl-compositor.ts stats{passes,floatPasses}`（composite() 入口清零）→ renderer/board.stats → board `_tickFps`。
3. GPU 计时（可选，更细）：`EXT_disjoint_timer_query_webgl2`（iPad Safari 历史上禁，未必有）或 `performance.now()` 包 `glBoard.render`。分清 **CPU 提交** vs **GPU 执行** vs **readback 阻塞**。
4. 按场景归因到下面某一条，再动手。math/手感类禁止猜测式调试（家族规则）。

### §0.1 从零复核结论（fresh agent v359 / 2026-06-29，已逐文件验证非 AI 猜测）
独立追了一遍每帧路径（gl-board→gl-doc-renderer→gl-compositor→blend-glsl），**与原 backlog 归因收敛**，且补了量化与一处新发现：
- **瓶颈 = passes × doc 像素 × 每片 tile-index 间接采样**。clip 多层 40-50fps 的成本结构：每帧 composite **全层重合**（livePreview 门控只挡 syncAll，不挡重合成），L 个全屏 f16 pass。2048²×~10 pass ≈ 数千万片/帧，正落 40-50fps 区——**§2「活动层下方缓存」是层数维度的第一杠杆，已验证对**。
- §1 已确认真：`brush.collectStamps()` 每帧 walk `0..count-1` **整条** stroke → `_glStampOverlay` 每帧喂全量 → 栅格器重栅格整条。长描边二次。
- §3 已确认真且 **v359 已修**（`WARP_FRAG` 加 `&& s.a>0.0` 早退，跳 quad 外基底 16-tap bicubic；golden `clip:*`/`warpclip:` 全过，像素零变化）。
- **新发现（CPU 侧，非 GPU）**：`gl-compositor._pass`/`_floatPass` 每 pass 每帧调 ~20 次 `getUniformLocation`（uniform location 未缓存）。L 层 → ~200 次/帧。2048² 下 GPU 片元仍占主导（故不是首杠杆），但 location 缓存是**零行为变化、golden 可证**的纯 CPU 省，可与 §2 顺带做。**注意**：context-restore 会重编 program → 缓存须随 `onRestored` 失效，否则句柄陈旧。

**下一步推荐顺序（待 HUD 真机数定夺）**：先开 FPS 真机读 clip 场景的 `Np`/`Ns` → 若 Np 随层数线性涨即坐实 §2 → 做 §2 sandwich（最大杠杆，但 clip 链/pass-through 组正确性须靠 smoke golden 守）；§1 frozen/tail 是独立的「长描边×大笔」维度（spec 在 ARCHIVE/old-brush-cpu-raster.ts）；getUniformLocation 缓存顺带清。

---

## §1 大喷枪/长描边二次爆炸（最可能的描边掉帧源）
**症状**：大 size + 长 stroke 时描边中掉帧；成本 ∝ stroke 长度 × size²（每帧重栅格整条）。
**根因**：`gl-doc-renderer.ts setStampOverlay` 每帧把 `collectStamps` 出的**整条 stroke** 重新 GPU 栅格（`gl-stamp.ts GLStampRasterizer.rasterize`）。stroke 越长每帧越贵 = 二次。
**修**：GPU **frozen/tail 缓存**（port 旧 CPU 双 buffer 思路，spec 在 `ARCHIVE/old-brush-cpu-raster.ts` 的 `_renderTail`/`_composeOverlay`）：
- 持久 frozen overlay FBO，累积**已定**（frozen）stamp，只在新 stamp 冻结时增量画上去（用 smoother `frozenIndex()` 切 frozen/tail）。
- 每帧只把 **tail**（前沿→笔尖那一小段）画到一张小 tail FBO，frozen ⊕ tail 合成。
- `GLStampRasterizer.rasterize` 加「累积进给定 target FBO」模式（现在每次新建/全画）。
- 起点：`src/gl/gl-doc-renderer.ts` setStampOverlay、`src/gl/gl-stamp.ts` rasterize、`src/brush.ts` collectStamps（已有 frozen/tail 概念可复用）。

## §2 clip / 多层每帧重合成（clip 40-50fps 源）
**症状**：层多 + 有 clip 蒙版时帧率掉到 40-50。
**根因**：`gl-compositor.ts _applyNodes`/`composite` 每帧**重合成全部层**（ping-pong 一层层 blend）。描边/变换中每帧都全合一遍，与活动层无关的下方层白合。
**修**：**活动层下方合成缓存（三明治）**：
- 描边/变换开始时，把**活动层下方**所有层合成一次进缓存 FBO（视口无关，内容不变就不重合）。
- 每帧从该缓存续合：活动层 + 它的 clip 链 + live overlay + 上方层。
- 只缓存「下方」（稳定）；上方层多 blend 不预合（上方变化频繁、且要正确叠在活动层之上）。
- 注意 clip：活动层若是 clip 层，它的基底要在「下方缓存」里仍可单独取 alpha（或把 clip 链整体算进活动段）。
- 起点：`src/gl/gl-compositor.ts` composite/_applyNodes/_composeFresh；缓存失效键 = 下方层内容/结构变（参考 board `_compositeCacheDirty` 的失效时机）。

## §3 【v354 引入】clip 浮层全屏 gather 浪费（组变换 clip 帧率）
**症状**：组变换里 clip 浮层拖动帧率比无 clip 低。
**根因**：浮层 pass（`gl-compositor.ts WARP_FRAG` + `_floatPass`）是**全屏 quad**；clip 浮层时**每个 doc 像素**都跑一遍基底 `warpSample`（bicubic = 16 taps）拿 alpha，**哪怕在 quad 外**（s.a 已是 0）。
**修（便宜，先做这个）**：
- 早退：clip 分支前先判 `if (u_clip == 1 && s.a > 0.0)` 才算基底 alpha（quad 外/透明像素跳过 16-tap）。
- 或更狠：`_floatPass` 用 `gl.scissor` 把浮层 pass 限到该浮层 dst bbox（`FloatDesc` 加 bx/by/bw/bh，board `sourceWarpMatrix` 已返 bbox，现在没透传）。两个一起更好。
- 起点：`src/gl/gl-compositor.ts` WARP_FRAG main（早退）+ _floatPass（scissor）；bbox 透传链 `board._glFloatInputs`→`FloatInput`→`setFloats`→`FloatDesc`。

## §4 浮层 pass 全屏 ×N（多源组变换）
组变换 N 个源层 = N 次全屏 warp pass（每个全屏 gather + 剔除）。配合 §3 的 scissor，每个 pass 只画自己 bbox → N 个小 pass。低优先（§3 scissor 顺带解决）。

## §5 live-sync 整层重传（v350，in-place 笔）
liquify/filterBrush/pixelMode 描边中，board 每帧把**整个活动层**重传 GPU（`gl-board.ts` liveSyncLeaf → `syncLayer`）。大层偏重。可优化成**脏 tile 增量**（按 markDocDirty 的 rect 只重传命中 tile）。中优先（liquify 本就重）。起点：`src/gl/gl-board.ts` render 的 liveSyncLeaf 分支、`gl-doc-renderer.ts` syncLayer（现整层）。

## §6 其它/低优先
- commit 路径（brush rasterizeStrokeToCanvas / 变换 warpToCanvas）是**抬笔一次性** readback，不影响帧率——别优化。
- present 每帧重 present 缓存（pan/zoom 已只 present 不重合，gl-board `_cache`）——已优化，确认即可。
- 视口狗牙（present LINEAR/NEAREST 切换）= 画质项不是性能项。

---

## 不变量（优化别破）
- **手感红线**：stroke-smoother + `_walkStamps`/`_stampParams`/`collectStamps` 一字不动（间距/压感/taper）。
- **golden 对拍**：所有 GPU 改动跑 `npm run smoke`（Chromium）对拍 CPU 基准（采样器/合成公式）；node `npm test`。
- **零额外 SSoT**：别为优化引第二条渲染/warp 路径（刚收成单一 GPU，见 audit）。frozen/tail 缓存是同一 GPU 路径的缓存，不是第二实现。
- 改 store/`src/store/**` = 红线，别碰（与渲染无关）。

参考：[[perf-webgl-memory-clip]]（主文档）、[[canvas-render-audit]]、`ARCHIVE/old-brush-cpu-raster.ts`（frozen/tail spec）。
