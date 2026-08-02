# v0.8+ 六骑士蓝图 · 勘探索引（易过期）

> as-of v0.8.0 / 2026-08-02
> 性质：**勘探快照 + user 蓝图记录**，不是施工文档、不是拍板记录。file:line 会漂——信代码不信本文。
> 拍板记录仍在：ADR-0007（A 骑士 spec）+ `20260801-v08-epoch-handoff.md`（A 骑士施工序）。
> 本索引 + 六份 recon 由 2026-08-02 的大蓝图讨论 session 产出（6 路并行 Explore 勘探）。可视化汇总在 `ai-docs/reports/20260802-v08-six-knights-recon.html`（gitignored，仅本机）。

## user 蓝图（2026-08-02 session 原意归纳，方向性参考非承诺）

六个工作流，绰号按谥号制——**版本别名 bump minor 时回顾性追认，开工绰号只是工作代号，不当承诺**（user 2026-08-02）：

- **A · Undo 骑士**：完成 undo 对 workpiece 的监管（= ADR-0007 / handoff S1–S6，已拍板）。workpiece 强制写 undo、app 不管账；原子操作 + 用户可控 checkpoint 聚合；workpiece = composition 薄容器防 god-object；reference images 等「进 ora 不走 history」→ sidecar。
- **B · 无地骑士**：移除 app 对 store 的承重依赖（store = 插件不是地基）。胜利条件：store 缺席时 app 仍可编译运行（画画/导入导出 ora/编辑笔刷，只是不落盘）。非 store 的 idb/localStorage 收进 centralized hub 一眼可数。附带：全局 password 进 store 接口契约（家族复用）；mhtml 单文件 release 构想（prod ritual 候选）；pwa pattern wizard 化。B 是 C 的前置；做完要动 JRP/WebXiaoHeiWu/RealHome。
- **C · 无头骑士**：webpaint.headless = 指令驱动纯 TS 内核（render tree + undo/workpiece + 笔刷滤镜算法），browser-agnostic，byte in byte out，mental model ≈ MCP over http（json+png 进 / json+binary 出）。UI/UX 全留前端（蚂蚁线渲染、手势状态机不归 headless）。两个口子：①commit 前实时预览也是 headless 输出；②同 tab 时可共享 GL context 但绝不碰 DOM。fantasy 清单：embedded 到别人网站 / VR 输入革命 / three.js UI（@pmndrs/uikit 一族）/ 多人协作 / 云后端 4K-8K。
- **D · 骑士的新装**：UI 深模块框架（menu/panel/toolbar 注册式、干掉手写 z-order 与 els.ts）。moonshot = Unity inspector（menu item 代码注册带图形语义，为 F 铺路）。实用 incentive：AI 功能 + sketchup clone 要来了，先抽走 boilerplate。
- **E · 骑士抽卡**：gallery 写成家族共享库（WebPaint/JRP/小黑屋/RealHome/BgRadio 一起重写）；gallery 也有偏后端的基座 + 多种控件模式；顺带把库分发机制（byte-identical vs 版本 pinning）正规化；sheet→panel 命名收敛。
- **F · 封建骑士**：插件化拆 core + addons（形状笔/色名等都拆），每个新功能 = 隔离插件 project，可 jettison 可 rewrite，防 scope creep。契约 pinned 成 document，越狱立刻可查。

### user 提的术语提案（未定稿，与现状有张力处已标）

- **doc** = 惰化持久格式（.ora/.psd/.blend 一族），不存在于 runtime。
- **workpiece** = runtime 被 undo 监管的东西（undo 全部 regime）。→ 现状 runtime 类叫 PaintDoc，改名波及见 recon-a。
- **sidecar** = 跟 ora 走 ∧ 不进 undo（参考图等）——与 ADR-0007 定案一致。
- **workbench** = 泛指编辑器窗口/app（与 gallery 对立）。
- **拆分提案**：旧 editor-state → **ui-state**（纯 UI，C 阶段彻底 divorce）+ **workbench-state**（跟文件走的画室状态：笔位/视口/active layer）+ **user-preference**（云同步或 per-device 偏好）。⚠ 张力待拷问：user 蓝图说 workbench-state「被 undo system 管」，但 ① ADR-0007 曾把 workbench 一词否掉（语义=editor app runtime）；② 勘探证实 active layer/selection 本就在 PaintDoc 被 undo 管、desk 态（视口/笔位）**不**被 undo 管且有 v409「别加 dirty」钉子——「workbench-state 被 undo 管」若指后者则与钉子冲突，若只指前者则改名即可。见 recon-a §3。
- **shared-library** = 跨 workpiece 共享资源 hub（笔刷库/提示词库/调参模板），≈ store.collections 但要装得下大文件；shared ≠ synced。
- **gallery** = 家族统一词（= Explorer/Finder/ls），JRP/小黑屋/RealHome 也用。

## 勘探文件一览

| 文件 | 内容 | 一句话结论 |
|---|---|---|
| `20260802-v08-recon-a-undo-workpiece.md` | undo 契约/命名波及/workbench-state 清单/sidecar 现场 | spec 已拍板可直接开工；undo-history 已近 app-agnostic；god-object 真身是 PaintDoc |
| `20260802-v08-recon-b-store-decoupling.md` | store 耦合面/collections 考古/boot 依赖/password 现状 | 切口一半已存在；硬耦合仅三通道；「无 store=只画不落盘」语义成立 |
| `20260802-v08-recon-c-headless-browser-deps.md` | canvas/GL/DOM/非确定性普查 + 分层评估 | 数据面已达标；唯一硬骨头=合成栅格 GPU-only；分界线=workpiece 写锁线非 board |
| `20260802-v08-recon-d-ui-framework.md` | els.ts/toolbar 范式/z-order/panel 普查/boilerplate 实证 | 4 半成品深模块+14 份外点关拷贝；Vue 已 6 岛；user 点名过 popover TODO |
| `20260802-v08-recon-e-gallery-family.md` | 五兄弟 gallery 对比/store 关系/byte-identical 考古 | JRP 组件是底盘；**BgRadio「不用 store 的 ADR」不存在（记忆更正）**；byte-identical 神话已破产要补分发机制 |
| `20260802-v08-recon-f-plugins.md` | ADR-0001 对账/三准插件耦合度/横切面 | filter 已是骑士；shape-brush=16 文件封臣；F 的割点在 D 的四横切面，ADR-0001 可不推翻 |

## 拷问进度（2026-08-02 中断点）

1. **C·GPU 抉择**（唯一真正未定的大架构题）讨论中未拍板。已知约束：user——「CPU 性能不可接受」（实时路径必须 GPU）。AI 提出的候选切法（**未获接受，仅供下轮参考**）：headless 硬承诺=「DOM 零依赖」而非「GPU 零依赖」；GL context 创建翻到宿主、ctor 注入 GL port（现状 gl-context.ts 已是唯一创建点）；多人协作走 op-log 不承诺 bit-exact；云后端=软件 GL；CPU 参照（reference-2d golden）留测试域不转正；WebGPU 迁移列未来独立纪元。user 表示此题需长聊，有待澄清的顾虑未说完。
2. 顺手账（无争议，待排期）：brush.ts 压感 LPF 壁钟 dt → 事件 t（回放前提）。
3. 未拷问：B 的 password 设计（政策在 app/机制在 store 的分界动不动）、mhtml 可行性细节、E 的列举接口统一（watchFolder vs listAllItems）、术语拆分张力（见上）、F 的 i18n 插件自带文案问题。
