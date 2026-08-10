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
src/gallery/   本轮检疫堆场：gallery 相关文件物理挪入（行为不变），内部不细分（不定义控件类，
               除非真有价值——user 判「一般没有」）；双向依赖（gallery↔session 10 处）
               文件头记账不动刀（E 骑士开工清单）。
```

**顶层粒度语义（user 2026-08-09 二次更正）**：五个顶层目录各自是「webcomponent / 背景进程 /
代码库」之一的量级——gallery=未来 webcomponent、backend/frontend/common=代码库、shell=胶水库
+背景进程；组织规则到这一层为止，目录内部不往下套。

搬家纪律：新代码即日按目录落；存量随切片搬（C0 改名表 = 搬家地图）；不搞一次性大爆炸。

> **C2 落地回写（v0.8.26）**：五目录格律 lint 挂 build.sh（依赖单向 + 禁浏览器词，注释行豁免、
> WebGL opaque 类型不在禁词内；负测试验证会咬人）。已就位住户：common/ = gl2-port + tile-geometry
> + color-dist；shell/ = browser-gl2-port；gallery/ = 8 文件检疫搬家完成（gallery-model/-path/-shell、
> gallery.ts、gallery-view-model、cloud-auth-ui、cloud-thumbs、cloud-thumb-cache），双向依赖实数
> 记 gallery.ts 头（session.* 直调 10 处 / 反向 refresh×5+invalidateEncrypted×2——recon-e 的 7/3
> 已过期）。backend/、frontend/ 住户随 C3/C5 搬入，规则先立防退化。

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

- **C1 落地回写（v0.8.25）**：接口落 `src/common/gl2-port.ts`，实现体落 `src/shell/browser-gl2-port.ts`
  （原 GLContext 改名 BrowserGl2Port，board.ts 壳侧唯一 getContext 创建点造好递入）；src/gl 零
  getContext/零 canvas（compositeToCanvas/warpToCanvas 两个 canvas 包装面撤壳：board.ts / smoke
  harness 本地自包）。已收编动词：program 按名（restore 自动重编）/FBO 借还+clearPool/quadVAO/
  isLost/generation/onInvalidated（多播，替 onLost·onRestored 单槽）。**过渡负债（显式记账）**：
  接口暂留 `gl` 裸口 = 未收编的调用面（合成 pass uniform/纹理绑定、instanced draw、readPixels），
  随 C5/C8 收编，SoftGl2Port 进场前清零；GPU tile arena（GLGpuTileBackend）尚在 Port 外，
  归 Port 的多 tab 记账排 C7 装配片。
- **`BrowserGl2Port`**（shell 侧）：getContext 唯一创建点从 gl-context.ts:68 翻入；context-loss
  检测/program·FBO·VAO 重建/generation++ 全在此（现 GLContext 改造为其实现体）；WebGL2 quirk
  一律不出壳。**`SoftGl2Port`**（backend 可见的测试/MCP 兜底）：迂腐语义模拟——照 GL 规范公式
  实现我们用的子集（premult blend 方程、所用 blendFunc 枚举、NEAREST/LINEAR、scissor/viewport、
  instanced 展开成循环），不复刻硬件数值与 instancing 机制，golden ±ε 锚。
- 数据自愈归 backend：bridge（cpuId→gpuId）+ 重传逻辑留 backend 侧（CPU 池恒 SSoT 现状不动）。
- 多 tab 一等需求：N 个 backend 共享一个 Port；node 测试含多 backend 并发用例；UX 后做。
- **C8 第一棒落地回写（v0.8.39）**：`gl` 裸口清零达成（终态契约成立）——动词面全量收编：
  `draw`/`drawInstanced`（按名 shader 画单位 quad，spec 自带全部状态：target/viewport/clear/
  scissor/blend/uniforms/textures）+ `readPixels`/`clearFBO` + 纹理动词（rgba8|rgba16f|r8|r32f）
  + **`createTileArena`（arena 归 Port 落地）**。全句柄不透明（SoftGl2Port 自造同形对象的前提）；
  uniform 类型由实现体反射、mat3 row-major、sampler 单元+占位归实现体、blend 封闭三态。
  quadVAO 从接口删除（顶点域钉死单位 quad，不开放任意几何）。arena 的**租户配额记账**仍等
  第二真租户（C8 mock multiplayer），接口形状已定（recreate/uploadSlice/copySlice 显式源 FBO）。

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
  // filter/transform 档口：C4 已定形（§6.1——filter 档 begin/setParams/commit/cancel；transform 无档口）
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

> **C7 第一棒落地回写（v0.8.33）**：接口落 `src/backend/webpaint-backend-interface.ts`、装配根落
> `src/backend/webpaint-backend.ts`（第二组合根：headless/MCP/embedding 面；app.ts 仍自装配同套件，
> 壳迁移 = C7 后棒）。形状对本节的偏离（均已 pin 进接口文件）：① `undo()/redo()` 返 boolean（非 void）；
> ② `open(bytes, inject)` 返 `{ backend, sidecar }`——sidecar（editor-state/reference.png/wroteWith）
> 解包随 open 交壳，encodeOra(opts) 收 `editorSidecar`/`referencePng` 原样携带（§sidecar 注入槽的落地形）；
> ③ 注入清单现值 = { appVersion, jpgEncoder, imageDecoder, gl }（gl 随 C8 档口接通收编：缺省懒建
>   SoftGl2Port——headless/MCP 无参即画；clock/uuid 实勘无需求未收——backend 无时钟无随机是 ADR-0009
>   决定论的构成部分，MCP 时间戳走 strokeAppend 的 (x,y,p,t) 事件 t）；
> ④ **决定论 encode**：ora zip entry 时间戳钉死 1980 epoch——同内容 → 同字节（round-trip 锚/云 diff 友好）。
> 已验收：node 无 GL open→指令→undo→encode **逐字节** round-trip + 双 backend 并发（tile 换手观察者
> 单槽→多播 + tileset 所有权戳）+ dispose/onChange，12 锚。未接（响亮 throw 占位）：stroke/filter
> 进程内档口（C8 栅格域）、psd open 路由、per-tenant 合成注入 + GPU tile arena 归 Port（C7 后棒）。
>
> **C7 后棒落地回写（v0.8.34-38）**：①**壳迁移完成**——app.ts 消费 WebPaintBackend.blank()（组合根不再
> 自装配 history/wp2/view/layers；壳编排经 `inject.hooks`：onHistChange/onApplied/onUnrecoverable/status，
> persp host 同注入；ctx 加 backend 键，doc/history/layers/wp2/layerTiles 五键 = backend 协作面直取投影）。
> ②**psd 路由实勘改判**：全仓无 psd 解码器——psd 是**只写格式**（编码器迁 `backend/psd.ts`）；open 对
> 8BPS 响亮失败是**终态**非待接路由（导入 psd = 新功能另立项）。③**无令牌像素写硬化落地**（census §3.6）：
> 有主 substrate 令牌墙外换手 = throw；无主临时件放行；dispose/驱逐路先摘戳；测试种子写迁显式声明态。
> ④**B2 裁定落地**：AppStorePort = Pick<Store, file|files|collection|encryption>（派生窄 Port，四面实测）；
> 全量手写镜像**裁定不做**（headless=WebPaintBackend 零 store 依赖，「物理删除仍编译」无受益方，镜像=drift 源）。
> ⑤**per-tenant 合成注入落地**：backend/LayersFace 各持 `inject.compositorBytes`（缺省回落全局接缝=壳单租户）；
> **GPU tile arena 归 Port 推迟 C8**——接口形状与 SoftGl2Port 同批设计（§6.3 不提前固化；多 backend 记账
> 串账已由多播观察者+所有权戳解，arena 配额记账等第二真租户）。⑥filter 档口 wire 两条已 pin 进接口文件
> （互斥 per-backend / 超时语义），toolkit .h 落 `20260810-frontend-toolkit-h.md`。

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

## 6. transaction 协议 + EditMode 归属（C4 普查定形，v0.8.28+；证据链 = `20260810-c4-transaction-census.md`）

### 6.1 transaction 协议

**互斥模型 = workpiece 单令牌墙的接口化身**：backend 同时最多一个 open transaction。
第二个 begin、开着期间的 undo/redo、与事务冲突的 verb → **响亮拒绝（throw/错误返回）**，
不排队、不静默丢弃、不自动收口（现状锚：workpiece.ts 单令牌 assert + beforeApply throw）。
`dispose()` 时有 open transaction → cancel 后释放（interrupt=cancel 家规）；远程句柄失联兜底
（超时/FR）细节随 C7/C8 落地回写。

**三类本质 → 三种指令形态**（普查分类：一次终值 / 参数重算 / 累积真改）：

1. **一次终值 → 普通原子 verb**：内部自带令牌开合，返回即入栈一步（no-op 不占步）。
   住户：selection set（魔棒 tap/选区笔/扩缩收口）、fill commit、float 五 verb、层树/doc 几何。
2. **累积真改 → stroke 档**（§3 已定 strokeBegin/Append/End/Cancel，**全部笔类共用这一个档口**
   ——brush/eraser/液化/形状笔/选区笔的差异在 ResolvedBrush 快照与 engineKey 内部）：token
   贯穿手势，交互期允许令牌内 substrate 写（collector 记账），End 一步入栈、Cancel 回滚无痕。
3. **参数重算 → filter 档（preview session）**：
   ```ts
   filterBegin(leafId: number, filterId: string): FilterSessionId  // 冻结源（bbox 字节+选区 mask）；
                                                                   // token 挂起 = 源的互斥租约
   filterSetParams(id: FilterSessionId, params: JsonObject): void  // 纯函数重 bake 替身；不记账不占步
   filterCommit(id: FilterSessionId): boolean                      // 终值一次落层 → 一步 undo；false=no-op
   filterCancel(id: FilterSessionId): void                         // 无痕（预览期真层零写 → no-op 回滚）
   ```
   原型 = filters-adjust surrogate 模式（开面板取 token→纯函数 bake 替身→GL 显示→commit/cancel）
   逐字升格；wire 签名细化随 C7 回写。

**transform 无档口**（C4 裁定）：变换会话 = frontend UX 括号（EditMode transient + histchange
reconciler），backend 只见原子 verb 序列（lift / setFloatTransform(matrix) / stamp / accept /
reject——每 verb 一步 undo）；正因无挂起事务，会话中途 undo/redo 自由（ctrl-z 语义分叉的结构
根源：**挂了事务栈被锁、ctrl-z 只能先收口；想要中途 undo 就不能挂事务**——adjust 与 transform
是同一条互斥定律的两个投影）。

**档口选择判据**（后来者用）：交互期需要真 substrate 写或事件流不可重算 → stroke 档；预览可由
(冻结源 × 参数) 纯函数重算 → filter 档；两者都不是 → 拆原子 verbs + frontend 括号。

### 6.2 EditMode 归属

- **backend 无 EditMode**：backend 的「模式」只有一个事实——有无 open transaction；互斥由
  令牌墙强制（fail-loud）。
- **EditMode 状态机整体归 frontend**（交互仲裁：谁能起手势、点工具=apply/cancel、canDraw
  fail-safe、ctrl-z 路由）。无 DOM 依赖（唯 `_emit` 事件口），随 C5+ 迁 `src/frontend/`；
  事件口换回调后可进 toolkit。
- 两层防线各司其职、缺一不可（普查实证）：EditMode 挡「正常流不该发生的交互」（fail-safe
  不响）；令牌墙挡「任何 bug 的写坏账」（fail-loud throw）。

### 6.3 仍留白（显式未定，等切片产出，不许提前固化）

- ~~Gl2Port 动词面~~ **已收口（C8 第一棒 v0.8.39）**：全量动词化落地，`gl` 裸口删除
  （§2「C8 第一棒落地回写」）。仍留白的只剩 shader 注册表 CPU 对表的具体形（SoftGl2Port 同批）。
- backend interface 的 verbs 全清单——等 C7 逐条过（workpiece v2 现有面 api 化）。
- 魔棒拖选预览宿的迁移形态（SelectionPreviewTx api 化 vs 预览全引擎自持）——等 C6 现场定
  （两候选路见普查 doc §6.3）。
- filter 档口 wire 细节（session 超时/多 tab 租户下的互斥归属）——等 C7/C8。

## 7. 测试与纪律

- **分级**：`npm test` 快层（每 build；含 SoftGl2 单测）；`npm run test:full` 全量层（QA 收尾棒：
  全量画作 round-trip、真 GPU vs SwiftShader vs SoftGl2 三方 golden ±ε、多 backend 并发、
  mock multiplayer）；gl-smoke 照旧。马拉松纪律：中间棒相关模块+tsc，最后一棒全量+（可选）真机。
- **CPU 像素纪律**：热路径栅格只准走 Gl2Port；新独立 CPU 像素算法 = user consent +
  `backend/algorithms/` 落户 + 注册清单。语言堵不死，靠纪律+review+测试（CLAUDE.md 条款随
  C2 落地）。
- 行为锚先迁后拆；worktree 改完 merge 回本地 main；test/run.mjs 显式注册；过渡态自己裁不上呈
  （上呈只有：终态契约偏离、undo 白/黑名单变动、数据安全）。
