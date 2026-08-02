# v0.8 recon C · 无头骑士 browser 依赖普查（易过期）

> as-of v0.8.0 / 2026-08-02
> 性质：Explore agent 勘探快照原样 dump + 拷问中断点记录。file:line 会漂——信代码不信本文。
> 索引：`20260802-v08-recon-index-six-knights.md`

## 拷问中断点（2026-08-02，未拍板——接手先读这节）

**唯一真正未定的大架构题 = GPU 抉择**。已知约束：
- user：「CPU 性能不可接受」（实时路径必须 GPU）——CPU 参照转正为 runtime 路径的选项已被否。
- user：此题需要长聊，还有未说完的顾虑（session 在此中断）。

AI 当时提出的候选切法（**未获接受，仅供下轮参考起点，别当拍板引用**）：
1. 刀口不在「GPU vs CPU」而在「GL API 面 vs DOM」——`WebGL2RenderingContext` 对象本身不是 DOM，DOM 只出现在造 context 那一步（canvas.getContext）；而全仓 GL context 唯一创建点已是 gl-context.ts:68。把「创建」翻到宿主、headless ctor 收注入的 GL 对象 = user「centralized 注入 browser 依赖」构想的严格实现。
2. headless 硬承诺 =「DOM 零依赖」而非「GPU 零依赖」；GPU 缺席时只有核心逻辑域可跑（测试/批处理够用）。
3. 多人协作同步 op-log（headless 指令流），每端各自栅格化，不承诺 bit-exact（不是共识系统）；真需要 bit-exact 的只有云权威渲染 → 服务端钉死软件 GL（SwiftShader 一族，同版本=同字节）。
4. CPU 参照（reference-2d golden）不转正不删——职责 = 语义真相 + 测试锚；「GPU 管性能、CPU 参照管语义、golden 对拍锁漂移」三角现状已在跑。
5. node 纯度诚实答案分域：核心逻辑域 100% node 可跑（现状已近）；栅格域 node 里 = CPU（已否）/headless-gl（生态弱不押注）/软件 GL（云后端现实路径）。WebGPU 迁移（Dawn/wgpu 原生服务器）是长线解，列未来独立纪元、不进本轮。
6. 无争议顺手账：brush.ts:117,139 压感 LPF 壁钟 dt → 事件 t（op-log 回放前提，便宜）。

---

## 以下为勘探原文（2026-08-02）

### 总体结论先行

这一刀比想象中好切：v0.6.38–46 去 canvas 战役已把像素管线大部分迁到 typed-array 字节口（LayerPixels.getRegion/putRegion），PNG 编解码已收口成深模块，render/render-plan.ts 零 GL 且有 build.sh lint 守卫，test/dom-shim.mjs 证明大半模块已能 node 跑。**真正的硬骨头只有一个：渲染合成与笔刷栅格化是 GPU-only、刻意不留 CPU 回退**（user 拍板架构）。

### 1. canvas/2d 使用点普查

**(a) 纯 UI 显示用（合法留前端）**：board.ts:236（GL display canvas）、board.ts:1105（栅格线 overlay 2d ctx）、palette.ts:51,105,202,218（调色盘小窗）、reference.ts:110,167,216,430,500（参考图小窗）、ui/color-wheel.ts:40、plugins/curves.ts:117-122,163-225（曲线编辑器 UI）。

**(b) 算法借 canvas（无头化的债，按严重度）**：
1. **src/resample.ts 整文件**——老 canvas 版重采样（:39-40 makeBitmap、:58-68 step-halving drawImage、:106-107、:111-114 canvasToBlob）。已有字节版继任者 **src/resample-bytes.ts**（v0.6.46，面积平均/bicubic/bilinear/nearest 全 typed-array、全 node 直测）；resample.ts 残余消费者主要是导入路径。
2. **src/tiles/tile-layer.ts:322-365**——canvas 残留三件套：materialize()（tiles→canvas 物化视图）、editPixels()（editRegion 的 2d ctx 回调面，putImageData→fn(ctx)→getImageData 往返）、replacePixels(srcCanvas)。LayerPixels 本体纯字节，这三个 facade 是 doc.ts editRegion/replaceFromCanvas/canvas getter（doc.ts:172-190）的地基。**editRegion 的 2d-ctx 写口是最大一笔债**（brush pixelMode、形状工具等 fn(ctx) 写者在上面；v0.6.41 已加 editRegionBytes 字节版，doc.ts:191-194）。
3. **src/selection.ts:64-65,222,398-404**——本体已 gray8 tile mask，保留 toCanvas() 桥给「剩余 Canvas2D 消费者（filters/浮层 lift/剪贴板）」（:390 自供）。
4. **src/selection-ops.ts:41-46,120-126**——剪贴板：getImageData→canvas→toBlob（剪贴板 API 要 Blob，半个 c 类）。
5. **src/session.ts:92-126 renderDocToImageBlob**——分享/导出 PNG/JPG：GL 合成 drawImage 到 canvas 再 toBlob（premult 往返仍在；画作持久化 ora 已不走这条）。
6. **src/ora.ts:116,144**——mergedimage 兜底占位 makeBitmap + encodePngFromCanvas；层数据本体已走 encodePngFromBytes（:138）。
7. gl/render-tree-gl.ts:391-395、gl/gl-compositor.ts:510-511——GL readback 字节→canvas 包装胶水。

**(c) 导入导出**：decodeImageFile（resample.ts:83-107，createImageBitmap + Image objectURL 双路回退）——浏览器解码器在此是特性（吃任意格式），headless 需替换或留前端；blender-sync.ts:235,329 createImageBitmap；PSD 导出已干净（psd.ts:273-274 分层字节直读，:380-388 merged 走 renderNodesToBytes，:382 的 OffscreenCanvas 是建了没用的残留）；session-state.ts:120 参考图 blob→createImageBitmap（UI 侧）。

**「png 压缩越狱」现状——已收监**：src/png-codec.ts 头注释原话（:1-11）「全库唯一接缝——user 2026-07-29：『把 canvas 封成伪装的 png 库，下次不会再越狱 canvas』…【硬原则（user）】：库外任何地方不许再为 PNG 编解码创建 canvas / createImageBitmap」。编码主路 vendored UPNG+fflate 纯字节 node 可跑（encodePngFromBytes :72-78，手写 CRC32/pHYs :19-51）；解码主路 UPNG 全格式（:100-110）；canvas 回退安全网（:113-122，iCCP/解码失败，注释「永不删——数据安全>>纯度」）；残留后门 encodePngFromCanvas（:82-94）服务 mergedimage/缩略图。

**离「字节进出不走 canvas」的距离**：画作数据面（层像素 ora/psd/undo/filters/transform commit）≈ 已达标；缺口 = ①分享导出 toBlob ②缩略图/mergedimage ③导入解码 ④editRegion 2d-ctx 写口 ⑤剪贴板。①②④可清，③⑤是浏览器 API 边界。

### 2. WebGL/GPU 依赖

- **context 创建完全 centralized**：唯一创建点 = gl-context.ts:68（GLContext ctor，getContext("webgl2")；无 GL → throw WEBGL2_UNAVAILABLE :69）。单持久 context，context-loss 自愈（:81-92）+ FBO 池。实例化链 board.ts:236-244 → gl/gl-board.ts:34-35（薄壳）→ RenderTreeGL。
- render tree 族：gl/render-tree-gl.ts（plan 执行器/段缓存）、gl-compositor.ts（blend pass）、blend-glsl.ts（12 blend GLSL）、gl-stamp.ts（笔刷栅格）、gpu-tile-pool.ts + tile-bridge.ts。**规划面 render/render-plan.ts 零 GL**（:3，lint 实证 scripts/build.sh:93）。
- **笔刷 GPU/CPU 分界清晰刻意**（brush.ts:29-35 宣言）：手感数学全 CPU（StrokeSmoother + _walkStamps + _stampParams），栅格化全 GPU（collectStamps → gl-stamp.ts，:1-17「逐位匹配 brush.ts、golden 对拍现 CPU 笔刷」）。CPU 栅格器已归档 ARCHIVE/old-brush-cpu-raster.ts。
- **GPU-only 无 CPU fallback 的路径**：①显示合成 + 一切导出合成（doc-render.ts:1-5「GL 不可用→返 null，导出=报错」；session.ts:109 throw；board.ts:583「不回退 2D，显『需 WebGL2』」；**2D 规范合成器活在 test/gl-smoke/reference-2d.ts 当对拍参照——headless 现成种子**）②buffered 笔刷 commit（input.ts:922-929 → board.commitBrushStroke；GL lost 返 false，笔画按未提交丢弃）③自由变换 warp 采样（floating-transform.ts:418-421 bakeFn 缺省→不烤；例外：整数刚体快路纯 typed-array :425-432，rotsprite/bspline 全 CPU）④唯一双路栅格点 = 选区笔（gl-board.ts:57-64 → null → sel-pen.ts:20,31-46 CPU Bresenham 回退）。
- **CPU-only 纯算法（headless 免费拿）**：plugins 全家（liquify-engine 等）、filters-adjust（tiles 直读）、lasso（flood/魔棒 tiles 直读）、lineart/*、resample-bytes、rotsprite、bspline、pixel-conic、shape-geometry、perspective-frame、marching-ants（**蚂蚁线几何是纯的**——Selection→polyline，board 只管画）、color-cluster/color-dist、workpiece/float-ops CPU 合成核。

### 3. DOM/事件泄漏进算法层

**结论：手感数学已解耦，泄漏在编排层**。无 DOM 文件名单覆盖几乎全部算法模块（brush、stroke-smoother、stroke-input-smooth、lasso、floating-transform、workpiece/*、lineart/*、render/render-plan、editor-session/*、store/*）。
- PointerEvent 不进笔刷引擎：input.ts（1568 行手势状态机）消费事件，喂引擎的是标量 `brush.beginStroke(layer, settings, x, y, pressure, mode, smooth, t)`（input.ts:1045、brush.ts:108）；StrokeSmoother 契约 push(x,y,p,t)（stroke-smoother.ts:22）。无独立 InputFrame 类型（那是 RealHome 的）但事实等价解耦。
- 残余泄漏：filters.ts 一个文件里算法接缝（:84-85）与滤镜对话框 UI（:172,309-316 createElement）同居；plugins/curves.ts 同病；doc.ts/tile-layer.ts 的 document 引用只是 makeBitmap 回退（bitmap.ts:7）；input.ts:196-253 快捷键直接 getElementById().click()（本来就是前端）。

### 4. 非确定性源

| 位置 | 性质 | 风险 |
|---|---|---|
| **brush.ts:117,139** | lastEventTime=performance.now() + _pressureLPF 用壁钟算 dt（非注入的事件 t） | **最要紧**：位置平滑可回放、压感不可——同一输入序列重放出不同笔画 |
| stroke-smoother.ts:26-27 | dt 来自 push 的 t，缺失才 FALLBACK_DT=16 | 已可确定化 |
| brushes.ts:89-90 | 笔刷 id crypto.randomUUID/Math.random | 身份生成非像素路径 |
| brush-rack-controller.ts:451,467 | creation_time=Date.now() | 元数据 |
| gallery-model.ts:119、gallery-shell.ts:81,192 | 副本命名 Date.now/Math.random | 会进协作可见状态，需注意 |
| store/*（delete/local-cache/move-aside/crypto-container） | 时间戳/uuid/盐 | 多数已支持 now 注入 |
| tile-jobs.ts:25、cpu-tile-pool.ts:352、background-sync-jobs.ts:41 | 帧预算调度 | 非算法 |
| **GPU 浮点本身** | blend/warp/stamp 跨 GPU 不逐位一致 | byte-identical 协作需收敛到 CPU 参照或钉死软件 GL |

Math.random 不出现在任何像素/手感算法里（无 jitter/scatter 笔刷特性）。

### 5. 现有分层评估

**最接近前后端的分界线不是 board（board=显示层），而是 workpiece + UndoHistory.run(operator) 写锁线**（workpiece.ts:1-16「写 workpiece 唯一合法路径 = UndoHistory.run…workpiece 不碰 store」）——operator 同步、原子，天然是 headless 指令 choke point。外圈第二条线 = editor-session（「app-agnostic：只跟不透明字节+注入的 editor 适配器打交道」，adopt(bytes)/encode()→bytes，已是 byte in byte out 壳）。app-context.ts（39 键装配契约）是组合根接线图，headless 需要瘦版。

**几乎可直接进 headless 的文件**：workpiece/* 全部、render/render-plan、stroke-smoother、stroke-input-smooth、brush.ts（改掉 performance.now 两处）、resample-bytes、rotsprite、bspline、pixel-conic、shape-geometry、perspective-frame、lasso、lineart/*、lineart-oracle、selection.ts（剃 toCanvas 桥）、marching-ants、png-codec（剃 canvas 安全网或垫 shim）、ora/ora-stack-xml、psd、tiles/cpu-tile-pool+cpu-tile-compression、filters-adjust 算法半、全部 plugins/ 引擎、color-*、crop-geometry、floating-transform（CPU 快路已纯；GPU bakeFn 是注入函数指针）。

**Top 5 最难拆**：
1. **input.ts（1568 行）**——手势状态机（前端）×笔画事务编排（后端：_endStroke 里 PixelTx.commit、选区 finalize、undo 记账 :918-940）同居；切它=把「笔画事务生命周期」从「pointer 路由」抽出。
2. **doc.ts（1225 行）**——PaintDoc/Layer 是核心数据结构，但 Layer 长着 canvas 物化 facade（canvas/ctx getter :172-174、editRegion :185-190、replaceFromCanvas）；字节双轨已铺好（editRegionBytes/replaceFromBytes/remapPixelsBytes 都在）。
3. **board.ts（1164 行）**——名义显示层实际 GPU 服务总线：commitBrushStroke/commitFillStroke（:765-781）、warp bakeFn、doc 内存预算（:225-230）都从它走；GLBoard 薄壳的存在说明剥了一半。
4. **filters.ts + plugins/curves.ts**——滤镜框架把算法注册表和对话框 UI 焊死（filters.ts:172-316）；算法引擎本身早已独立干净，要拆的是框架层。
5. **session.ts + exporters.ts 图像导出半边**——exporter 契约（「doc→该格式字节」exporters.ts:20）很 headless，但 png/jpg exporter 实现 renderDocToImageBlob 是 canvas+toBlob+GL 三合一（session.ts:92-126），jpg 编码只有浏览器实现。

**已有 headless 基建（别重造）**：test/dom-shim.mjs（零依赖假 DOM）+ test/run.mjs（app.ts 组合根都能 boot smoke）；test/gl-smoke/reference-2d.ts（归档 2D 规范合成器=对拍参照=CPU 合成器现成起点）；workpiece/float-ops.ts:140 已为 node 铺路（无 ImageData 构造器时用普通对象）；scripts/build.sh:77-93 分层 lint（render/ 禁 import gl//store 等）= 「无头核不许摸浏览器」检查现成挂点。
