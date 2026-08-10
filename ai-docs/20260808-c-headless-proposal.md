# C 骑士 · 前后端分域施工提案（grill 后终版契约）

> as-of v0.8.23 / 2026-08-09（初稿 2026-08-08，经五轮 grill **全面改写**——初稿里 kernel 词、
> WebGL2RenderingContext 直注、「核心逻辑域才可 node 跑」等提法全部作废，以本版为准）
> 性质：**pin 住的目标契约**（重构策划：现状 .h = `api/`，提案 .h = 本文；实现中形状变了要回写）。
> 拍板出处：`20260809-c-backend-grill.md`（五轮收敛记录）；why = `ai-docs/adr/0009-gl2port-and-determinism.md`；
> 施工序 = `20260809-c-backend-handoff.md`。勘探事实上游：`20260802-v08-recon-c-headless-browser-deps.md`。

## 0. 目标与胜利条件

正式分域词 = **frontend / backend**（kernel 词退役）。backend = 算法 + 合成 + codec + workpiece；
frontend = UX 资产（交互模型、工具状态机、UI）；分域目标 = **把前端 UX 的技术债和后端的简洁隔离开**。

胜利条件：

1. backend DOM 零依赖：node（dom-shim）下 `WebPaintBackend.open(ora bytes)` → 指令 → undo/redo →
   `encodeOra()` 全链路测试通过，**栅格域由 SoftGl2Port 兜底也能跑**（MCP server 成立）。
2. 前端壳能被替换：backend interface 纯接口文件（全标量）是唯一契约——同一份接口 = 进程内调用面 =
   postMessage 面（webcomponent+Worker embedding）= MCP 面 = multiplayer 序列化面。
3. 边界防退化：目录依赖格律 + 禁浏览器词 lint 挂 build.sh，名单只增不减。
4. B2 store 窄接口在 backend 装配片一并裁；B 剩余批排 C 之后另立。

非目标：multiplayer transport（只留序列化+标记位）、用户 runtime 的 CPU 渲染（无 GL2 照旧响亮
失败）、folder tree 全面重排（F 骑士）、UX 抽象层系统 grill（排 UI 骑士侧）、bodypaint（远期，
机制备忘见 grill 记录 §七.4——对 backend 只是多一个映射函数）。

## 1. 目录格律（五目录 + 单向依赖）

```
src/common/    纯类型 + 纯几何/纯数学（tile-geometry、rect/matrix、Selection 值对象、
               ResolvedBrush/PaintingData 类型、色距）。import 任何人 = lint 报错。
src/backend/   算法、合成、codec、workpiece、Gl2Port 消费侧。只准 import common。
  └ algorithms/   窄 I/O「小论文」全进来：flat-coloring(原 lineart)/rotsprite/bspline/
                  pixel-conic/EDT/magic-wand(泛洪+相似色)/color-cluster…+ 注册清单一张。
src/frontend/  UX 资产。可 import common + backend（读面/指令）。
  └ toolkit/      DOM-free UX 数学深模块（gizmo、蚂蚁线、手势→终值编排、transform 交互
                  状态机）——可移植器官，但不进 backend interface。
src/shell/     platform 胶水（store 接缝、editor-session、分享/剪贴板/PWA、Port 装配、
               decoder/encoder 注入）。可 import 全部。capability 契约：只有
               「unavailable / 承诺托底」两态，exception 壳内消化，app 只见 failure+reason。
src/gallery/   本轮检疫堆场：gallery 相关文件物理挪入（行为不变），**每个文件夹 = 一个 component
               或一个背景进程**（user 2026-08-09 更正：粒度是文件夹不是文件）；双向依赖
               （gallery↔session 10 处）文件头记账不动刀（E 骑士开工清单）。
```

搬家纪律：新代码即日按目录落；存量随切片搬（C0 改名表 = 搬家地图）；不搞一次性大爆炸。

## 2. Gl2Port 契约（ADR-0009）

```ts
// src/common/gl2-port.ts —— 手写最小 interface：把「WebGL2 对我们的承诺」钉死。
// 不是通用 device abstraction；将来接其他 API = 实现这份承诺。动词面（核实过的全仓用量）：
export interface Gl2Port {
  readonly caps: Gl2Caps;                  // 壳填好的数据（maxTextureSize/floatColorBuffer/…）
  readonly generation: number;             // 结构自愈纪元：loss→重建→generation++
  onInvalidated(cb: () => void): void;     // 失效广播（全部驻留/映射作废，backend 惰性重传）
  // 纹理/FBO/绘制动词：上传、借还 FBO、blend 状态、按名 shader 画 quad、instanced quad 批、readPixels
  // （签名细化随 C1 落地回写；shader 按名注册：{ program 名 → GLSL 源, CPU 等价函数 }——
  //   注册表即 GPU/CPU 对表，新 shader 不配 CPU 版必须显式 GPU-only 登记）
  // GPU tile arena（纹理仓）归 Port 所有：多 tab 公共资源，租户配额记账。
}
```

- **`BrowserGl2Port`**（shell 侧）：getContext 唯一创建点从 gl-context.ts:68 翻入；context-loss
  检测/program·FBO·VAO 重建/generation++ 全在此（现 GLContext 改造为其实现体）；WebGL2 quirk
  一律不出壳。**`SoftGl2Port`**（backend 可见的测试/MCP 兜底）：迂腐语义模拟——照 GL 规范公式
  实现我们用的子集（premult blend 方程、所用 blendFunc 枚举、NEAREST/LINEAR、scissor/viewport、
  instanced 展开成循环），不复刻硬件数值与 instancing 机制，golden ±ε 锚。
- 数据自愈归 backend：bridge（cpuId→gpuId）+ 重传逻辑留 backend 侧（CPU 池恒 SSoT 现状不动）。
- 多 tab 一等需求：N 个 backend 共享一个 Port；node 测试含多 backend 并发用例；UX 后做。

## 3. WebPaintBackend 契约

```ts
// src/backend/webpaint-backend-interface.ts —— 纯接口文件（类 .h）：契约与实现分离。
// 【硬纪律】本文件全部方法只收/吐 标量 | JSON-able 对象 | TypedArray/bytes——
//   它同时是进程内 api、postMessage 协议、MCP tool schema、multiplayer 序列化面（同一把刀）。
export interface WebPaintBackendInterface {
  // —— 生命周期：born-loaded，无空态无 load 方法（liminal space 结构性不存在）——
  //   换画 = 弃旧建新；load/new 的舒服语义住壳层 tab 管理器（tabs.open/tabs.new）。
  dispose(): void;                          // 显式释放（GPU 驻留/内存配额退租）
  // —— 字节面：吐包好的 binary（加密等外包装壳再开一次包）——
  encodeOra(): Promise<Uint8Array>;         // 内部：exportData → 纯函数 codec（独立模块，门面只转发）
  exportImage(fmt: "png" | "jpg", opts?): Promise<Uint8Array>;   // 合成→字节；jpg 经注入编码器
  // —— 指令面：只收终值 verb（setTransform(matrix) 类）；交互/手柄/多步输入 backend 绝不碰 ——
  //   结构/像素/选区/浮层 verbs = workpiece v2 现有面（ADR-0008 令牌流），此处 api 化逐条过
  // —— 多步事务：句柄 ≈ 令牌（WriteToken 远程化身）；同时最多一个 open transaction ——
  strokeBegin(leafId: number, brush: ResolvedBrushSnapshot): StrokeId;  // 快照锁定一笔（画一半动笔=下一笔生效）
  strokeAppend(id: StrokeId, points: Float32Array): void;   // (x,y,p,t)×N，stride 版本化留扩展位
  strokeEnd(id: StrokeId): boolean;         // 平滑+栅格+bake+记账全在 backend（preview==commit 同管线）
  strokeCancel(id: StrokeId): void;
  // filter/transform 等 transaction 档口：C4 普查后定形（见 §6 留白）
  undo(): void; redo(): void;
  onChange(cb: (ev: ChangeEvent) => void): void;   // dirty/结构变更事件（壳/embedding 消费）
}
// 静态工厂（路由归 backend）：
//   WebPaintBackend.blank(meta)                    // 新画布：宽高/DPI/底色
//   WebPaintBackend.open(bytes, hint?, inject?)    // 魔数嗅探：zip→ora、8BPS→psd、png/jpg→单图成层
// 注入清单（node 拿不到的才注入；node 里近乎无参）：
//   { gl?: Gl2Port /*缺省→SoftGl2Port*/, imageDecoder?, jpgEncoder?, clock?, uuid? }
// workpiece/history/组件 = backend 自建，不注入。
```

- **brush rack 全库失踪 backend 照跑**：backend 只认 ResolvedBrush 快照；rack/设置/云同步 =
  frontend+store 的事。（笔刷试笔 = blank + 固定点序列 + stroke + readback，零新机制。）
- **手感在 backend**：StrokeSmoother/压感 LPF 随 StrokeSession 迁入（壁钟 dt→事件 t 顺手账同片）；
  壳只喂 raw (x,y,p,t)。**bake preview 在 backend**：三面预览旗（overlay/surrogate/float）语义
  维持 ADR-0008 §8；**compose 归 backend，present（上屏 blit/rAF/DPR）归 frontend 壳**。
- **sidecar 注入槽**：backend 编码器只写永恒 ora spec；壳保存时递 opaque「UI 状态 bytes+壳版本号」，
  backend 原样携带不解释——UI 时钟与 ora 时钟解耦（industry practice：可忽略的 app 私有扩展块）。
- **frontend toolkit .h**（第二份接口，可选器官清单）：toolkit 模块的纯签名——高中生接新平台时
  输入映射自己写，难的 UX 数学从这里搬。
- multiplayer 只切两刀（本纪元不实现 transport）：接口可序列化（本文件天生）+ UndoStep op 分类
  标记位（CPU 可重放/携带结果）；回放/同步格式存 stamp 不存 brushId。

## 4. canvas 债收账表（目标：backend 零 canvas；canvas 只活在壳的屏显域）

| # | 债 | 收法 | 验收判据 |
|---|---|---|---|
| a | `resample.ts` 整文件 | 重采样消费者迁 resample-bytes；decodeImageFile 抽 shell 注入槽 | resample.ts 物理不存在 |
| b | tile-layer canvas 三件套（materialize/editPixels 2d-ctx/replacePixels(srcCanvas)） | fn(ctx) 写者迁 editRegionBytes；doc.ts canvas facade 随拆 | 无 canvas facade |
| c | selection.toCanvas() 桥 | 消费者逐个清（filters tiles 直读/浮层 lift 字节/剪贴板壳包装） | selection 无 toCanvas |
| d | session.renderDocToImageBlob 三合一 + ora mergedimage 占位 | §3 exportImage；encodePngFromCanvas 后门消灭或缩壳域 | backend 导出纯字节 |
| — | 剪贴板、任意格式解码、jpg 编码、屏显 overlay（蚂蚁线/栅格线 2d canvas） | **壳域合法名单**，写进 lint 注释防误清 | — |

## 5. 切片表（commit/版本粒度；验收 = 物理不存在/锚测试过）

| 片 | 内容 | 验收 |
|---|---|---|
| **C0** | **全文件改名对照表**（现名·实际做什么·提案名，timestamp 可过期）+ 力所能及改名（flat-coloring 等）；**顺手修 color window 退化**（fill 切入时全局色窗未跟 pending 色） | 表落 ai-docs；退化修复真机锚记入真机批 |
| **C1** | **Gl2Port + BrowserGl2Port**：接口落 common、getContext 翻壳、GLContext 改造、结构自愈契约（generation/onInvalidated）；行为不变 | src/gl 零 getContext；gl-smoke+全测试绿 |
| **C2** | **目录格律落地**：五目录立起 + 依赖 lint + 禁浏览器词 lint（起步名单=已达标模块）；gallery 屎堆场搬家+双向依赖记账 | build.sh 新 lint 绿且防退化 |
| **C3** | **canvas 债收账（§4）+ lasso 拆彻底 + algorithms/ 立户**（magic-wand 析出、相似色独立、注册清单） | §4 判据；每文件一句话说清职责，无「有关部门」 |
| **C4** | **多步操作普查**（doc 产物）：stroke/transform/curve/液化/魔棒拖选/形状笔/persp/fill 按本质分类（一次终值/参数重算/累积真改）→ transaction 协议定形 + EditMode 归属裁定 | 普查 doc + 协议节回写本提案 |
| **C5** | **StrokeSession**：笔画事务从 input.ts 抽出（手感数学随迁 backend、壁钟 dt→事件 t）；令牌句柄协议落地 | 事务代码物理迁出 input.ts；node 笔画测试（SoftGl2）；手感 golden 不变 |
| **C6** | **预览违规户迁移试点**：液化 surrogate 化（第一户），魔棒拖选、形状笔 pixelMode 跟上 | 三户走 transaction 协议；「预览是引擎自持物」成立 |
| **C7** | **WebPaintBackend 装配**：born-loaded 工厂/open() 路由/dispose/多 tab 租户/接口文件两份/sidecar 槽/**B2 store 窄接口一并裁** | node 无 GL：open→指令→undo→encode 逐字节 round-trip；多 backend 并发测试 |
| **C8** | **SoftGl2Port + MCP server + 测试分级**：迂腐软模拟、shader 注册表对表、npm test/test:full 分层、Playwright 三方 golden ±ε、mock multiplayer 双 backend、MCP 红队全量画作 | MCP 里 create/draw/crop/undo/redo/export 跑通 |
| **C9** | **reference window web component 试点**：家族组件约定模板（vendor .mjs/属性事件/宿主解耦） | 组件独立可挂；约定 doc 化 |
| 尾挂 | B 剩余批（password/单 .html/wizard/三兄弟）另立 handoff；UX 抽象层 grill（UI 骑士侧）；gallery/editor 组件（E/embedding 骑士）；bodypaint 投影服务（远期） | — |

## 6. 留白（显式未定，等切片产出，不许提前固化）

- transaction 协议细节（filter/transform 档口签名、互斥拒绝语义）——等 C4 普查。
- EditMode 归属（倾向：backend 令牌互斥 + frontend 交互仲裁）——等 C4。
- Gl2Port 动词面精确签名——等 C1 落地回写。
- backend interface 的 verbs 全清单——等 C7 逐条过（workpiece v2 现有面 api 化）。

## 7. 测试与纪律

- **分级**：`npm test` 快层（每 build；含 SoftGl2 单测）；`npm run test:full` 全量层（QA 收尾棒：
  全量画作 round-trip、真 GPU vs SwiftShader vs SoftGl2 三方 golden ±ε、多 backend 并发、
  mock multiplayer）；gl-smoke 照旧。马拉松纪律：中间棒相关模块+tsc，最后一棒全量+（可选）真机。
- **CPU 像素纪律**：热路径栅格只准走 Gl2Port；新独立 CPU 像素算法 = user consent +
  `backend/algorithms/` 落户 + 注册清单。语言堵不死，靠纪律+review+测试（CLAUDE.md 条款随
  C2 落地）。
- 行为锚先迁后拆；worktree 改完 merge 回本地 main；test/run.mjs 显式注册；过渡态自己裁不上呈
  （上呈只有：终态契约偏离、undo 白/黑名单变动、数据安全）。
