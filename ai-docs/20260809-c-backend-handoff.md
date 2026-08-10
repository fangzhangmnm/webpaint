# C 骑士（前后端分域）施工 handoff

> as-of v0.8.23 / 2026-08-09（**策划收口，施工未开始**）。读者 = 接棒的下一个 AI session。
> 契约（what，pin 住）= `20260808-c-headless-proposal.md`（grill 后终版，形状变了要回写它）；
> why = `ai-docs/adr/0009-gl2port-and-determinism.md` + ADR-0008；
> 拍板出处 = `20260809-c-backend-grill.md`（五轮 grill，引 user 原话前先查它）。
> 施工模式 = v2 同款马拉松接力（user：「写好之后handoff，然后就可以和上一次一样handoff接力做了」）。

## 0. 进场必读

- **push 纪律**：新 session 第一批默认不 push；user 本 session 口头授权后可自动推 dev；prod 永远必问。
  worktree 铁律：改完 merge/ff 回**本地** main（出过 remote 领先 local）。
- **版本**：每片 `./bump.sh v0.8.N-日期` patch 递增（doc-only 片不 bump）；**骑士做完前不 bump 0.9**
  （user 2026-08-08：「现在只是 0.8 的前 1/3」）；bump minor 必须 user 显式说版本号。
- **测试基线**：1232 node 绿 + tsc 0 + `bash scripts/build.sh` 全 lint + `npm run smoke` GL smoke
  PASSED。`test/run.mjs` 是显式清单，新测试必须注册。
- **中间态纪律**（v2 同款，user 拍板沿用）：不推 dev 不等真机直接接力施工；「写完了才算数，一口气
  写不完可以接力。中间怕错可以模块化测试」；过渡态自己裁不上呈，上呈只有终态契约偏离/undo 白黑
  名单/数据安全。**测试分级从 C8 起生效前，先维持全量 npm test**；C8 落地后中间棒可只跑相关模块+tsc。
- **红线照旧**：src/store/** 改前 escalate；doc mutation 必须持令牌（ADR-0008）；journal/ 不碰。

## 1. 施工序 = 提案 §5 切片表（C0→C9）。本节只补每片的「how 情报」

- **C0 改名表+顺手修**：全文件对照表放 `ai-docs/20260809-file-naming-survey.md`（打 timestamp 可
  过期，不承诺维护）。已核实的错位样本：`lasso.ts`（826 行 = 套索手势 + 自由变换编排 + 魔棒/泛洪/
  相似色算法本体三合一，头注释只认前两者）；`lineart/`（= Fourey–Tschumperlé–Revoy 2018 flat
  coloring 论文实现，非「勾线」）→ `backend/algorithms/flat-coloring/`。**color window 退化**：
  「切到fill的时候填色没有立刻反应全局颜色的颜色」——T4c registerColorTarget 色板 target 切换的
  UX 缺口，修复入口在 color-panel/fill-mode 接线，修完记真机锚。
- **C1 Gl2Port**：现状唯一创建点 gl-context.ts:68（ctor 内 getContext）、唯一调用 gl-board.ts:35。
  全仓 GL 动词面已核实：按名 shader 画 quad（TRIANGLES×6）+ gl-stamp 一次 drawArraysInstanced +
  FBO 借还 + blend 状态 + 纹理上传 + readPixels——接口就这几个动词，别扩。行为不变纯搬家，
  gl-smoke 是锚。
- **C2 目录格律**：lint 挂点 = scripts/build.sh 现有分层 lint 段（v0.4/B 段同款写法）。gallery 搬家
  时把 recon-e 点名的双向依赖记文件头（gallery.ts 直调 session.* 7 处、session-state 反向调
  gallery.refresh() 3 处）——E 骑士开工清单，本轮不斩。
- **C3 canvas 债+lasso 拆**：字节继任者都已在（resample-bytes v0.6.46、editRegionBytes v0.6.41、
  selection gray8 本体）；债表见提案 §4。lasso 拆的验收 = user 原话「每个文件，模块能解释清楚
  做什么，而不是『有关部门』」。
- **C4 普查**：对象=stroke/transform/curve slider/液化/魔棒拖选/形状笔 pixelMode/persp 编辑/fill
  预览。已核实的两条现状路：region filter = surrogate 模式（开面板取 token→bake 纯函数写替身
  buffer→GL 显示→commit/cancel，真层零改动，**这就是 transaction 协议的原型**）；液化/filter-brush
  = 就地写真层+live-sync 每帧重传（undo 记账正确，违的是预览语义——ADR-0008 显式记名 defer，
  非违令）。普查产物回写提案 §6 留白。
- **C5 StrokeSession**：手感数学（StrokeSmoother/压感 LPF）随迁 backend；brush.ts:117,139 壁钟
  dt→事件 t 顺手账同片落。引擎侧本就吃标量（brush.beginStroke(layer,settings,x,y,p,mode,smooth,t)），
  事实解耦已成，抽的是事务生命周期（input.ts:918-940 一带的 commit/finalize/记账编排）。
  ResolvedBrush 快照锁定一笔（画一半动笔=下一笔生效）。
- **C6 违规户迁移**：液化第一户（liquify-engine putImageData 就地写→surrogate 化），魔棒拖选、
  形状笔 pixelMode 跟上。行为锚先迁后拆。
- **C7 装配**：app-context 39 键的 backend 瘦版；B2 store 窄接口一并裁（20260801-v08-epoch-handoff
  §9 挂点）；多 tab 租户+dispose；接口文件两份（backend interface + frontend toolkit .h）；sidecar 槽
  （editor-session 的 peek 已是雏形）。
- **C8 SoftGl2Port+MCP**：迂腐语义模拟（GL 规范公式忠实，不复刻硬件数值/instancing）；现成种子
  = test/gl-smoke/reference-2d.ts（2D 规范合成器）+ ARCHIVE/old-brush-cpu-raster.ts（CPU 笔刷
  栅格器）。node 无真 WebGL2（headless-gl 只有 WebGL1 已否）；全量层用 Playwright headless
  Chrome（SwiftShader，dev-only）三方对拍。MCP 红队动词：create/crop/draw/circle/undo/redo/export
  （user：「你多红队一点」）。
- **C9 reference window 组件**：家族 web component 约定试点（vendor .mjs/属性事件/宿主 store 解耦）；
  embedding 终态 = webcomponent 壳 + Worker backend（iframe 手势稀烂已否，降级为不信任第三方场景）。

## 2. 地雷

- **别把 SoftGl2 当用户路径**：无 WebGL2 照旧响亮失败（「CPU 性能不可接受」维持原判）。
- **shader 注册表纪律**：新 shader 不配 CPU 版必须显式 GPU-only 登记——静默缺席=对表测试红。
- **热路径栅格只准走 Gl2Port**；新独立 CPU 像素算法要 user consent + algorithms/ 落户。
- 三面预览旗语义（overlay/surrogate/float，ADR-0008 §8）与 fill 的 ADR-0004 出入口语义一字不动。
- workpiece v2 令牌墙别绕：backend interface 化是给现有 verbs 穿接口衣，不是重造写路径。
- 搬目录时 import 路径大改——tsc 是审计器，一片一搬别攒大爆炸。
- 提案 §6 留白**不许提前固化**（transaction 细节/EditMode 归属等 C4 普查产出）。

## 3. 悬账（不在本纪元/等排期）

- 真机批 24 条未跑（`20260807-workpiece-v2-handoff.md` §4，12+2+10 口径）——C 批的新真机锚
  （color window 修复、C6 三户手感）往里追加，攒批一次交付。
- B 剩余批：password 契约、单 .html 发行（非 mhtml；资源 base64 内联，可出单文件+目录双产物）、
  pwa wizard、三兄弟对齐——排 C 之后另立 handoff（user：「这样更彻底」）。
- UX 抽象层系统 grill（排 UI 骑士侧）；gallery/editor 组件化（E/embedding 骑士）；bodypaint
  （远期；机制备忘 = grill 记录 §七.4：texture 空间 full-quad 反算 screen 采样 stroke buffer
  + delta-z screening，对 backend 只是多一个映射函数）。

## 4. 施工进度（接棒者按片追记）

-（空——C0 未开工。）
