# C·无头骑士 · 施工提案（纯策划批交付）

> as-of v0.8.23 / 2026-08-08
> 性质：**重构策划**（家族 API ritual：现状 .h + 提案 .h 两份）——现状 .h = `api/`（本批已 `gen-api.sh`
> 重打、与 v0.8.23 零 drift，不另拷贝）；本文 = 提案 .h（目标契约，**pin 住的接口**，实现中形状变了要回写）
> + 切片表 + ADR-0009 草案 + grill 议程。**未 grill、未开工**——grill 通过后才动第一刀。
> 上游：`20260802-v08-recon-c-headless-browser-deps.md`（勘探事实）、
> `20260802-v08-gpu-determinism-grill.md`（GPU 终态，收敛已毕）、
> `20260807-workpiece-v2-handoff.md` §3（遗留坑）。
> 本批新拍板（user 2026-08-08）：下一棒 = C；ADR 讨论完再立；**B 剩余排在无头化之后做（「这样更彻底」）**。

## 0. 目标与胜利条件

user 蓝图（recon-index 原话）：「webpaint.headless = 指令驱动纯 TS 内核……browser-agnostic，
byte in byte out，mental model ≈ MCP over http」。

胜利条件（提案，待 grill 确认）：

1. **DOM 零依赖是硬承诺**（grill 终态）：kernel 域文件不 import / 不引用任何 DOM API；
   Worker 里 `new OffscreenCanvas(w,h).getContext('webgl2')` 造 GL 由**宿主**做，kernel 只收注入。
2. **GPU 缺席时核心逻辑域可跑**：node（dom-shim）下 load(ora 字节) → 令牌 verbs → undo/redo →
   encode(ora 字节) 全链路测试通过，逐字节锚。栅格域（笔刷烤定/合成/导出像素）GPU-only 照旧，
   无 CPU 回退（user 拍板不变；reference-2d 留测试域当 golden，不转正）。
3. **边界防退化**：build.sh 挂「kernel 域禁浏览器词」lint（现成挂点 = v0.4/B 分层 lint 同段），
   名单随切片只增不减。
4. B2 store 窄接口收敛在 kernel 装配片一并裁（20260801-v08-epoch-handoff §9 的既定挂点）。

非目标（grill 终态已钉，防重新捡起）：node 跑 GPU（「洁癖假需求」）、device abstraction 多后端、
定点纲领、CPU 参照转正、WebGPU（将来独立纪元）。

## 1. 终态分层（三域）

- **kernel 域（headless，DOM 零依赖）**：workpiece/**（令牌流+History 编排器=指令 choke point）、
  render/（纯规划，已 lint）、tiles/**（CPU 池，已无 gl）、selection/marching-ants（已 lint）、
  lasso、lineart/**、resample-bytes、rotsprite、bspline、pixel-conic、shape-geometry、
  perspective-frame、plugins 引擎族、filters-adjust 算法半、color-*、crop-geometry、
  floating-transform（CPU 快路；GPU bakeFn 是注入的函数指针）、ora/ora-stack-xml、psd、
  png-codec（canvas 安全网见 §6 议程 4）、editor-session（已是 byte in byte out 壳）、
  **gl/**（GL 对象注入后整族 DOM-free**：`WebGL2RenderingContext` 本身不是 DOM，DOM 只出现在
  造 context 那一步——recon 候选切法 1，grill 终态第 1 条采纳）。
- **宿主域（浏览器，合法留前端）**：board 屏显/present、input pointer 手势路由、UI 全家
  （panel/toolbar/浮窗/gallery/色轮/curves 对话框）、造 canvas + getContext、剪贴板、
  分享/文件系统、createImageBitmap 任意格式导入解码、jpg 编码、store 的 IndexedDB/MSAL。
- **边界（记名不清，浏览器 API 本性）**：剪贴板 Blob、导入吃任意格式（浏览器解码器是特性）、
  toBlob(jpg)、SW/PWA。

## 2. 提案 .h（目标契约）

### 2.1 GL 注入翻转（C1）

现状：全仓 GL context 唯一创建点 = `gl-context.ts:68`（ctor 内 `canvas.getContext("webgl2")`）；
唯一调用 = `gl-board.ts:35`（`new GLContext(canvas)`）。

```ts
// src/gl/gl-context.ts —— ctor 改收现成的 gl；造 context 翻进宿主装配
export class GLContext {
  constructor(gl: WebGL2RenderingContext);            // ← 唯一形状变化
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;  // = gl.canvas（规范属性；present/loss 监听用）
  // caps 探测 / program 缓存 / FBO 池 / context-loss 自愈：形状全部不变
}
// src/gl/gl-board.ts（宿主装配）：canvas.getContext("webgl2", attrs) 移入此处 → new GLContext(gl)
// attrs（premultipliedAlpha 等）随迁宿主；「无 WebGL2 → 响亮失败」的 throw 语义不变。
```

注入粒度【提案，议程 3】：直接用 `WebGL2RenderingContext` 类型当契约（TS lib 自带、零维护成本），
「最小子集」体现为 lint + 用法自律，不手写 wrapper interface（非必要不加接口）。

### 2.2 StrokeSession——笔画事务从 input.ts 抽出（C5）

现状：input.ts 1567 行 = pointer 手势状态机（宿主）× 笔画事务编排（kernel：_endStroke 里
bake commit、选区 finalize、undo 记账，input.ts:918-940 一带）同居——recon Top-5 第 1 难。
引擎侧本就吃标量（`brush.beginStroke(layer, settings, x, y, pressure, mode, smooth, t)`），
事实解耦已成，缺的是把事务生命周期收进一个 kernel 对象：

```ts
// src/stroke-session.ts（新，kernel 域）【提案，形状待 grill】
// 一次笔画 = 一个事务：喂标量点 → 收尾烤定 + 令牌记账。pointer 路由（宿主）只做手势判定与喂点。
export class StrokeSession {
  begin(leafId: number, brush: ResolvedBrush, opts: StrokeOpts): void;
  move(x: number, y: number, pressure: number, t: number): void;  // t = 事件时间戳（顺手账落此片：
                                                                  // brush.ts:117,139 壁钟 dt → 事件 t）
  end(): boolean;      // collectStamps → RasterService.bakeStamps → history.withPoint 记账；
                       // GL lost 返 false = 笔画按未提交丢弃（现语义不变）
  cancel(): void;
}
```

选区笔/fill 笔等既有 per-tool commit 路径挂同一事务面；EditMode transient 并发守卫机制不动
（tool state 全局类仍是独立记名坑，不进本纪元）。

### 2.3 导出拆三合一（C3d）

现状：`session.ts:92-126 renderDocToImageBlob` = GL 合成 + drawImage + toBlob 三合一。

```ts
// kernel 侧（RasterService 现有面已够——T6 预埋）：
//   raster.compositeOnceToBytes(...) → RGBA 字节；png = png-codec.encodePngFromBytes（纯字节，node 可跑）
// 宿主侧（session.ts 残留薄壳）：jpg 编码 + Blob 化 + 分享（toBlob 是浏览器边界，记名不清）
```

ora mergedimage 占位（ora.ts:116,144 encodePngFromCanvas）同批改走字节路，
`encodePngFromCanvas` 残留后门消灭或缩进宿主域。

### 2.4 kernel 装配（C6）

现状：`app-context.ts` 39 键装配契约（组合根 app.ts 一次构造）。提案 = headless 瘦版：

```ts
// src/kernel.ts（新）【提案，两个形态待 grill——议程 1】
export interface KernelGpu { gl: WebGL2RenderingContext }   // 最小 WebGL2 注入，单后端
export interface PaintKernel {
  readonly wp: PaintingWorkpiece;        // 指令 choke point：doc mutation 只此一门（ADR-0008 令牌流）
  readonly history: History;             // withPoint / undo / redo / 不可恢复协议
  readonly layers: LayersFace;           // 结构 verbs 门面
  readonly view: PaintingView;           // 读面端口
  readonly raster: RasterService | null; // gpu 注入才有；null = 核心逻辑域 only（测试/批处理够用）
  load(bytes: Uint8Array | Blob, kind: "ora"): Promise<void>;   // 解码 → wp.load 令牌灌入 + 清栈
  encode(kind: "ora"): Promise<Blob>;                            // wp.exportData → 编码器（冻结语义现状）
}
export function createPaintKernel(opts?: { gpu?: KernelGpu }): PaintKernel;
```

形态 A（上）= 薄装配函数，只做「new + 接线」，零新机制；形态 B = 不建门面，
「kernel = 现有面 + 装配约定 + lint」。倾向 A（boot smoke / 未来 Worker 宿主 / MCP 面都要一个
可 new 的入口），但接口纪律要求先问：**指令序列化（wire 格式）本纪元不做**【提案，议程 2】——
「MCP over http」的 mental model 落在「verbs 即指令集」，wire 层等 multiplayer 期再立。

### 2.5 边界 lint（C2）

```bash
# scripts/build.sh 追加（与 v0.4/B 分层 lint 同段）：C 分层 lint——kernel 域禁浏览器词
# 名单起步 = §1 kernel 域中现已达标的文件；每片收账后扩容，只增不减。
# 禁词（值级）：document\. window\. getElementById createElement HTMLCanvasElement
#              createImageBitmap new Image( navigator\. requestAnimationFrame
```

## 3. canvas 债收账表（C3；顺序即依赖序，素材=recon §1b 普查）

| # | 债 | 收法 | 验收判据 |
|---|---|---|---|
| a | `resample.ts` 整文件（老 canvas 重采样 + decodeImageFile 同居） | 重采样消费者全迁 `resample-bytes.ts`（v0.6.46 继任者已在）；decodeImageFile（浏览器解码特性）抽到宿主域新文件 `image-decode.ts` | **resample.ts 物理不存在** |
| b | `tile-layer.ts:322-365` canvas 三件套（materialize / editPixels 2d-ctx 回调 / replacePixels(srcCanvas)）——最大一笔 | fn(ctx) 写者（brush pixelMode、形状工具等）迁 `editRegionBytes`（v0.6.41 字节版已在）；doc.ts 的 canvas/ctx getter、replaceFromCanvas 随拆 | tile-layer/doc 无 canvas facade；`doc.ts` 头部 canvas import 消失 |
| c | `selection.ts` toCanvas() 桥（:390 自供「剩余 Canvas2D 消费者」） | 消费者逐个清：filters 走 tiles 直读、浮层 lift 走字节、剪贴板走宿主域包装 | selection.ts 无 toCanvas |
| d | `session.ts renderDocToImageBlob` 三合一 + ora mergedimage 占位 | §2.3 | kernel 侧导出纯字节；encodePngFromCanvas 后门消灭或缩宿主域 |
| — | 剪贴板（selection-ops toBlob）、任意格式导入解码、jpg 编码 | **记名不清**（浏览器 API 边界，§1 第三域） | 名单写进 lint 注释防误清 |

## 4. 切片表（commit/版本粒度，按序；验收判据 = user 2026-08-07 语义「物理不存在/锚测试过」）

| 片 | 内容 | 验收 |
|---|---|---|
| **C1** | GL 注入翻转（§2.1）——最小割第一刀 | `src/gl/**` 零 `getContext("webgl2")`（宿主装配除外）；gl-smoke + 1232 测试绿；行为不变 |
| **C2** | 边界 lint 落地（§2.5），起步名单=已达标模块 | build.sh 绿；名单防退化（故意加违规 import 会红） |
| **C3** | canvas 债收账 a→d（§3；可拆多 commit） | 表内逐条判据 |
| **C4** | 顺手账：brush.ts:117,139 壁钟 dt → 事件 t（回放/timelapse 质量项；便宜，随 C5 前置落） | stroke 平滑 node 测试注入 t 序列可复现 |
| **C5** | input.ts 肢解：StrokeSession 抽出（§2.2） | 事务代码物理迁出 input.ts；kernel 侧笔画事务 node 测试（mock raster）；手感锚不变（golden 对拍） |
| **C6** | kernel 装配 + boot smoke（§2.4）；**B2 store 窄接口在此一并裁**（epoch-handoff §9 挂点） | node(dom-shim) 无 GPU：load(ora)→verbs→undo→encode 逐字节 round-trip 锚 |
| **C7** | filters.ts / plugins/curves.ts 框架层拆 UI（算法注册表纯化进 kernel；对话框归属见议程 5） | 算法注册表文件零 DOM；lint 名单收编 |
| 尾挂 | **B 剩余批（user 2026-08-08：排无头化之后，更彻底）**：password 契约拷问、单 .html 发行（非 mhtml，grill 技术备忘已钉）、pwa wizard、三兄弟对齐（JRP/小黑屋/RealHome） | 另立 handoff，不进本表 |

地雷（从 v2 施工继承的纪律）：行为锚先迁后拆；worktree 改完 merge 回本地 main；
test/run.mjs 显式注册；「不要留念旧东西，只防新伤疤」——桥/兼容层自裁不上呈，
要上呈的只有终态契约偏离/undo 白名单/数据安全。

## 5. ADR-0009 草案（照抄 grill 收敛记录，未加新货；**user 点头后才落 `ai-docs/adr/0009-*.md`**）

> 拟名：`0009-c-gpu-injection-and-determinism.md` · 状态草案

- **决定 1**：headless 的 GPU 契约 = ctor 注入最小 WebGL2 子集；单后端，不做 device abstraction；
  node 支持 = 非目标（user 原话「洁癖假需求」）；DOM 零依赖是硬承诺。
- **决定 2**：stamp 累积走 fixed-function blend（user：「走1，不增加复杂性」）——float blend 管线照旧，
  不做定点累积、不做 per-stamp ping-pong。
- **决定 3**（由 2 连锁）：定点纲领整体蒸发——全管线照旧 float、一套 shader、preview==commit 同管线、
  硬件 filter 保留；定点降级为将来 per-op 工具箱备件。
- **决定 4**：determinism 预算存活为 per-op 同步路由（multiplayer 地基，现在只留分类标记位）：
  CPU/JS op 免费重放（commit 载荷带平滑后 stamp 列表，绕开超越函数漂移）；GPU 写真相 op 发结果
  （笔画发累积 coverage、transform 发 tile）；乐观并发不需要 bit 一致；漂移不累积（每像素最多一个 op 的校正）。
- **决定 5**：preview 零保证，commit 才保证。
- **决定 6**：阈值算子蝴蝶掐在判定层（判定 CPU + 结果随 op 发）。
- **决定 7**：带宽降档阀（模码/发低位，Slepian–Wolf 界）备而不用——默认整 tile 压缩发，疼了再上。
- **明知弱点**（记录在案）：GPU 真相 op 永付载荷带宽（仅 multiplayer）；op-log 跨设备回放不保证
  bit 还原；「云端权威渲染 hash 校验」玩法不可用。解药 = 将来局部定点（技术备忘见 grill doc）。

## 6. grill 议程（待 user 裁决，按重要度）

1. **kernel 入口形态**：A 薄装配函数 `createPaintKernel`（倾向）vs B 纯约定+lint 不建门面。
2. **指令序列化本纪元不做**（verbs 即指令集，wire/MCP 层等 multiplayer 期）——确认？
3. **GL 注入粒度**：直接用 `WebGL2RenderingContext` 类型（倾向，零维护）vs 手写最小子集 interface。
4. **png-codec 的 canvas 回退安全网**（头注「永不删——数据安全>>纯度」）：kernel 域里怎么处置——
   提案 = 保留但改成宿主注入的 fallback 函数指针（缺席时纯字节路硬失败），红线不动只换接线。
5. **filters/curves 框架拆的归属**：对话框 UI 重建是 D 骑士（UI 框架）领地——C7 只拆到「算法注册表
   零 DOM」，对话框壳留给 D？还是 C 顺手重建？
6. **EditMode（并发写守卫）**进 kernel 还是留宿主编排。
7. **B 剩余批清单**确认（password / 单 .html / wizard / 三兄弟对齐——已拍板排 C 后）。
8. ADR-0009 文本（§5）确认后落编号。
9. 真机批口径 24 条（12+2+10，handoff §4 本批已修）——跑批时点这个数。
