# C 骑士 · 前后端分域 grill 收敛记录（五轮）

> as-of v0.8.23 / 2026-08-09
> 性质：**grill 收敛记录**——2026-08-08/09 五轮拷问（51+24+10+3+1+1 条）的拍板存档，供提案/ADR/施工引用。
> 本文只记收敛终点与关键推理链；引号内为 user 原话。file:line 会漂——信代码不信本文。
> 上游：`20260808-c-headless-proposal.md`（初版提案=被拷对象，已按本文全面改写）、
> `20260802-v08-gpu-determinism-grill.md`（GPU 终态，本轮修订其 node 条目）。
> 落地：ADR-0009（Gl2Port/determinism）+ 改写后的提案 doc（契约）+ `20260809-c-backend-handoff.md`（施工序）。

## 一、词汇与总刀法（user 拍板）

1. **kernel 词退役，正式分域词 = frontend / backend**。linux kernel 比喻被 user 否（「前端后端这个比喻才对」）；
   门面类名 = **`WebPaintBackend`**（WebPaint=ThisApp 语义，改名跟着改）。
2. **手感 = 后端资产（数学），UX = 前端资产（交互模型）**——两个词分开用（user：「手感和UX也是两个不同的概念」）。
3. **放弃「高中生无资产纯胶水」原则**（user：「交互做前端。放弃高中生（无资产纯胶水）原则」）：
   前端有自己的 UX 资产；分域目标 = 「把前端UX的grill和各个工具直接状态机的技术债和后端的简洁隔离开来。
   后端就是算法，合成」。win condition 降级为「接 backend 出画面出笔画 effortless」。
4. 两把正交的刀：**归属刀**（前端资产/后端资产，设计裁定——蚂蚁线 DOM-free 也是前端资产）；
   **注入刀**（node 拿不到的才注入，只回答后端内部怎么拿环境能力）。user 专门敲打「确定你不飘：
   前端后端要刀号，不是只有依赖dom的才是前端」。
5. **backend 指令面只收终值 verb**（setTransform(matrix) 类）；交互/手柄/多步输入 backend 绝不碰
   （user：「kernel就是MCP，就是http server，就是后端」）。「交互 immortal」靠前端 toolkit（DOM-free
   UX 数学深模块），不靠 backend 背 UX。

## 二、目录格律（user 拍板「文件夹理一下」+「三个大文件夹」讨论收敛）

- 五目录：`src/common/`（纯类型+纯几何，零依赖）、`src/backend/`（算法/合成/codec/workpiece，
  含 `backend/algorithms/`）、`src/frontend/`（UX 资产，含 `frontend/toolkit/`）、`src/shell/`
  （platform 胶水）、`src/gallery/`（**本轮检疫堆场**——「所有的gallery屎本轮先堆过去，未来慢慢理」）。
  **粒度语义（user 2026-08-09 二次更正）**：「src目录的五个是webcomponent或者背景进程或者代码库」
  ——组织规则到五个顶层目录为止，目录内部「不用分的那么细，除非你觉得定义控件类有价值，
  不过我觉得一般」。
- 依赖格律单向：common 不 import 任何人；backend 只 import common；frontend 可 import
  common+backend；shell 都可；lint 按目录钉死。紧耦合共享物（几何/类型/Selection 值对象）进 common
  ——「紧耦合的方便的代价可能就是后来不敢动->屎山」，反屎山靠单向格律不靠消灭共享。
- 大规模改名：**全文件对照表**（现名·实际做什么·提案名，打 timestamp 可过期）；「lasso屎山本轮拆，
  这次一定要拆彻底，验收标准：每个文件，模块能解释清楚做什么，而不是『有关部门』」；
  「所有看上去像一个有比较窄的i/o，比较复杂的小论文都拆」→ algorithms/；lineart 改名对齐论文
  《A Fast and Efficient Semi-guided Algorithm for Flat Coloring Line-arts》→ flat-coloring
  （「不要把lineart放第一个词，误导」）。folder tree 全面重排是 F 封建骑士的活，本轮只做力所能及改名。

## 三、Gl2Port（GL 注入）拍板

1. 名字：**`Gl2Port` / `BrowserGl2Port` / `SoftGl2Port`**（user：「明白叫GL……叫GL2，这样agent一看就懂」
   「不要叫GPU，因为我们用的不是webgpu不是cuda，而是受限的GL。诚实一点」；Browser 前缀「突出他是
   依赖浏览器的」）。**手写最小 interface**（user 拍板，否 WebGL2RenderingContext 全类型）。
   接口目的头注写明：不是通用抽象，是「把GL2对我们的承诺钉死，以后接别的通用graphics api……
   实现这个承诺就行」。
2. GL 调用面核实：全仓只有「按名 shader 画 quad + stamp 一次 drawArraysInstanced + FBO 借还 +
   blend 状态 + 纹理上传 + readPixels」——Gl2Port 就这几个动词。
3. **自愈进核心承诺**：结构自愈（loss 检测/program·FBO·VAO 重建/generation++ 失效广播）= Port 承诺；
   数据自愈（从 CPU SSoT 重传）= backend 责任。**GPU tile arena 在 Port 侧**（多 tab 公共资源），
   **bridge（cpuId→gpuId）+重传逻辑在 backend 侧**。
4. **多 tab 提上需求**：N 个 WebPaintBackend 共享一个 Gl2Port（租户配额记账）；「设计gl context的
   时候一开始就按照多tab来，然后node端测试也加多tab的。虽然UX上面先不做，但是后端做好」。
5. 壳造 BrowserGl2Port 递进来（「定」）；caps/quota/version 等 meta 壳准备好，「后端不碰gl provider
   quirk」；「exception必须壳处理……app只能看到failure和reason，不接环境的exception」（pwashell 契约）。

## 四、SoftGl2Port 与测试（第 3/4/38/39 轮收敛）

1. **CPU fallback 采纳**（修订 20260802 grill 的「node 支持=非目标」——理由变了：不是洁癖，是
   MCP/QA/少真机的收益）。形态：「只是对gpu的一个翻译，用gpu的接口做，然后新功能只能写gpu，
   需要新shader再写cpu fallback」。**用户 runtime 不变**：无 GL2 照旧响亮失败（「CPU 性能不可接受」
   维持原判）。
2. **迂腐语义模拟**（user 终态：「既然是测试路径，那么还是迂腐一点走尽量软模拟路线吧」「好，那么
   SoftGl2，迂腐点也行」）：照 GL 规范公式逐条实现我们用到的子集，不做创造性简化；不复刻的只是
   硬件数值与 instancing 机制（golden ±ε）。
3. **GPU/CPU 对表 = shader 注册表本身**：每 program 名 → {GLSL 源, CPU 等价函数}，同处登记，
   测试查每名两份齐（或显式 GPU-only 进 todo）。
4. 真 GL2 注入测试并存：node 里无真 WebGL2（headless-gl 只有 WebGL1，已否）；全量层经 Playwright
   headless Chrome（SwiftShader，dev-only 依赖）做**三方对拍：真 GPU vs SwiftShader vs SoftGl2Port ±ε**。
5. **测试分级**（user：「test ritual也许可以考虑不同的级别」）：`npm test` 快层每 build；
   `test:full` 全量层只在 QA 收尾棒（全量画作 round-trip、三方 golden、多 backend 并发、
   mock multiplayer）；马拉松纪律=中间棒相关模块+tsc，最后一棒全量+（optionally）真机。
6. **防 AI 私写 CPU 像素路径 = 纪律不是语言**（「你总能拿到pixel总能写一个raw for over array」）：
   热路径栅格只准走 Gl2Port；新独立 CPU 像素算法 = user consent + `algorithms/` 落户 + 注册清单
   （容器的不官僚版：「文件夹+一张表」，静态类被弃）。

## 五、WebPaintBackend 形状拍板

1. **born-loaded**（user：「好，born-loaded」）：ctor 即带数据出生，无空态无 load 方法，liminal
   space 结构性不存在（「早期有很多bug都是进入这样的liminal space」）；换画=弃旧建新+显式 dispose()；
   load/new 舒服语义住壳层 tab 管理器。权衡记录：多 tab 需求已替 born-loaded 付掉换引用的账。
2. **静态工厂+嗅探路由归 backend**：`blank(meta)` / `open(bytes, hint?)`（zip→ora、8BPS→psd、
   图片→单图成层）；「import picture, import psd一大堆杂七杂八，路由放到后端里面」。
3. **encode/decode 归 backend，挂门面吐包好的 binary**（「kernel吐binary也可以是包好的……宁愿开
   一次包也不要因小失大」——加密壳再开一次包）；内部 codec 仍是独立纯模块。
4. workpiece/history 等核心 = backend 自建不注入（「还是那个node mindset。node拿不到的才注入，
   node里面可能就是一个几乎无参的ctor」）；注入清单：Gl2Port（可缺省）、图片解码器 fallback
   （「作为手写png解码的fallback，可不注入」）、时钟/uuid 等设备源。
5. **纯接口文件**（user 提案：「写一个类似h文件的纯接口……契约和代码屎山分离，指令序列化的时候
   只要机械过一遍接口就行」）：backend interface 全标量/JSON-able/TypedArray——**这一份接口同时是
   MCP 面、postMessage 面、multiplayer 序列化面（同一把刀）**。.h 两份：backend interface（必需）
   + frontend toolkit（可选器官）。
6. **brush rack 全库失踪 backend 能跑**；strokeBegin 传 ResolvedBrush **快照并锁定一笔**
   （治「画一半动笔」；「反正就令牌的时候传」，带宽可忽略不做 diff）。点元组 **(x,y,p,t) 保持
   4 元（全仓无 tilt 消费者），协议留 stride/版本位**（「keep it minimal」）。
7. stroke 句柄 ≈ **令牌**（WriteToken 远程化身）；互斥模型=同时最多一个 open transaction；
   细节等多步操作普查（「做一个普查看一下他们的本质再想办法设计抽象，而不是纸上谈兵」）。
8. 笔刷 preview 思想实验验证刀口：procreate 试笔 = blank backend + 固定 (x,y,p,t) + stroke 指令
   + readback，零新机制。

## 六、preview/合成/导出拍板

1. **bake preview 是 backend 的事**（user 判据：「小学生把webpaintkernel接vrchat里面，肯定写不来
   stroke preview。顶多传一下tuple array」）。三面预览旗正名：overlay=笔画进行中 stamp 预览、
   surrogate=filter 替身、float=浮层（recorded 组件非预览）。预览与 commit 同管线同 shader（现状
   SSOT 维持）。
2. **compose（合成）= backend；present（上屏 blit/rAF/DPR）= frontend 壳**——「屏显是壳的事」
   指后半段。蚂蚁线/栅格线 = 壳侧 2d overlay canvas，合法（「字节进出不走 canvas」禁数据路径，
   不禁屏显叠加）。
3. 导出终态（user：「导出应该很简单」）：合成→每格式一个小 codec ts 同文件夹→ora/psd 组装；
   png 纯字节内置、jpg 经注入编码器（浏览器边界）；**ora 捞 UI 状态的治法 = opaque sidecar 注入槽**
   ——backend 只写永恒 ora spec，壳保存时递「UI 状态 bytes+壳自己的版本号」，backend 原样携带
   不解释（industry practice：可忽略的 app 私有扩展块；UI 时钟与 ora 时钟解耦）。
4. **液化三户（就地写预览）本批治**：考古结论=非 AI 违令，是 ADR-0008「已记名未排期」的显式 defer；
   排在普查后，液化当 transaction 协议第一个迁移试点（魔棒拖选、形状笔 pixelMode 跟上）。
   「预览是引擎自持物不进 workpiece」（ADR-0008 §8）维持。

## 七、multiplayer / embedding（幻想层，本纪元只切刀不实现）

1. multiplayer 刀口 = **UndoStep/token 整点**（「一个鬼在帮你按一个不存在的Redo」）；本纪元只切
   两件：指令面可序列化（接口文件）+ UndoStep op 分类标记位（CPU 可重放/携带结果）。transport
   不做（「现在技术做不了」），**测试 mock 双 backend 喂 op 流**。sidecar/工具/rack 不同步=语义
   本义（「老师的工具也不需要同步——或者说不应该！」）；rack 黑天鹅被「commit 载荷带平滑后
   stamp/发结果」消解，回放格式钉死存 stamp 不存 brushId。
2. embedding：**iframe 手势稀烂（user webui 调研）→ 路线改为 web component 壳 + Worker backend**
   （postMessage 协议=同一份接口文件；OffscreenCanvas GL2 in Worker 可行）；iframe 降级为
   完全不信任第三方场景。「multiplayer一刀，webcomponent一刀」= 同一把刀（接口序列化）。
   单文件发行仍 = 单 .html 非 mhtml（资源 base64 内联，可出单文件+目录两个产物）。
3. **reference window 本轮抽 web component 试点**（「如果这轮抽反而帮助逼出来接口就这轮」）——
   逼出家族组件约定模板；gallery 组件留 E 骑士（「语义上就是一个webcomponent……这个是抽卡骑士轮
   的事情」；gallery 家族定义=tree 模式+card 模式）；webpaint-editor 组件=终态但排 C+D 之后。
   gallery-iframe 独立项目幻想否决（耦合最重隔离收益最小）。
4. bodypaint 前瞻（user 2026-08-09 更正记法，之后再说）：**texture 空间 full-quad blit，每 texel
   反算 screen 坐标**（UV→3D→screen 映射），采样 screen 空间的 stroke buffer，**delta-z screening**
   剔除遮挡——「这样永远 pixel accurate。所以其实反而就是多了一个映射函数，反而好算」。对 backend
   = 多一个映射函数进管线（非 raycast/逆投影 stamps 方案）；Gl2Port 面预计存活。

## 八、随批 todo（user 点名）

- **color window 退化**：「切到fill的时候填色没有立刻反应全局颜色的颜色」——随 C 批顺便修
  （UX 抽象层的系统性 grill 另排：「也许放到UI骑士后面？或者被UI骑士逼出来」）。
- B 剩余批（password/单 .html/wizard/三兄弟）排无头化之后（「这样更彻底」）；B2 store 窄接口
  在 backend 装配片一并裁；「最理想的是把B的webpaint域一起做，之后就可以随便并行做其他几个
  兄弟项目以及做npm」。
- GL 多 stroke 的 CPU 端优化不值得深做（「反正看上去差不多就行了」——SoftGl2 语义忠实优先）。
