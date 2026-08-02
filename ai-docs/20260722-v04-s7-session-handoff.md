# WebPaint 0.4 · 会话交接（第五棒 → 第六棒：S8+S9 一口气做完，纪元末统一真机）

> 首版写于 2026-07-22 S7 完工后；同日经两次用户拍板改写（merge 上 main；sequencing 重定）。
> 给下一个 fresh agent；自包含，但内容细节一律以 repo 文档为准（本文只做路由，不复述）。

## 现状一句话

**S0–S7 全部已 merge main 并 push dev（v0.4.8，main=94def73）**。tsc 0 / 824 node 测试 /
SwiftShader smoke 全绿。用户已做过一次真机，**结果有意暂扣**（防 breadcrumbing）——别问、
别猜、别据此调整优先级；按 spec 把 S8+S9 做完再统一收真机反馈。

## Sequencing（用户 2026-07-22 拍板，pin 死）

**完整做好重构再测。** 旧「每片之间插真机验收」的门是 agent 链条自己长出来的谨慎（非用户决定），
已作废。所有需要人类拍板的事项**累积进本文 §拍板清单**，不阻塞施工、不逐条打断用户。

## 下一棒：S8 · 编辑逻辑迁移

施工图 = `ai-docs/20260722-v04-batch1-handoff.md` §4-S8 + `ai-docs/20260722-v04-s7-render-tree.md` §3
（S7 交接点，消费口已备好）。开工前照例轻量 plan。要点：

1. **brush ready/live/commit 走 doc-FBO + bridge 批量 readback**（spec:187-205）；旧
   rasterize→canvas→editRegion 路径死。**手感数学（smoother/taper/gamma）一个字节不动。**
2. **液化重写 doc-space mask**（「按 layer.bbox 烤」bug 从构造上消灭，S5 埋的 H7 RED×3 转绿）；
   filter-brush 抽象类（CPU 实现暂留）。
3. **吸管走 render-tree 单帧 GPU read**（compositeOnce 已可当基础；杀 ensureCompositeCache）。
4. **checkpoint-autosave 只做机械最小**（spec:36-44：ora checkpoint / 最小周期 / 写成功再删旧 /
   isDirty 别弄错 / 副线程不支持走 bg-jobs）；**归属挂现有 session.ts 不动窝**——
   workbench-session 重组是用户下一轮理 store/boot 时亲自整理的（spec:26）。此默认待追认，
   已进拍板清单，不阻塞。
5. 顺手：选区 mask per-tile GPU 化（并进 brush ready 重做）、board.ts 冗余 hint 机器
   （forceGLResyncUnderFloat/_wasFloatActive/liveSync provider）拆除、SD 异步范式文档化
   （spec:241-242，无 UI）。

## 紧接着：S9 · 日落 + 改名 + **体重合同**

清单 = batch1-handoff §4-S9。**用户明确要求：S9 要有比较大的 LOC 净削减**——这几片鲁棒性
不错但一直在长胖。**度量口径（用户钉的）：不算测试套件、注释、文档等杂项**——只数 src/
非 vendor 的 .ts/.js 实质代码行（剔空行与纯注释行），秤 = `python3 tools/count-src-loc.py <ref>`：

- 纪元开工 v0.4.0(895fd20) = **23,280** 行（167 文件）→ 现在 v0.4.8(94def73) = **24,658** 行
  （174 文件，净增 +1,378）。
- **目标：S9 完成后 ≤ 23,280**（纪元净增清零转负）。交付时用同一把秤报告体重变化
  （家族规则：承诺了重构就交付体重变化）；达不到不许糊弄，逐项列出哪里没砍到、为什么。
  ⚠ 别为凑数删注释/压行——口径已把注释排除在外，凑不了；砍的必须是真实管线。

点名削减对象（现大小）：`layer-composite.ts`(301) 全删接 compositeOnce；`reference.ts`(569)
手抄扁平合成删；Canvas2D mentality 残余整体迁走（editRegion/materialize 收缩到 import/export
边界，spec 附录点名）；`board.ts`(978) 冗余 hint + 旧显示路径残余；brush 旧栅格路径残余；
`editor-state.ts`→`workbench-state.ts` 改名（ORA 内 json key 向后兼容）；`gl/tile-pixels.ts`
归位 `tiles/`；每个死模块补 build.sh 防复活 lint。纪律：**深切不刮痧**——砍的是整条旧管线，
不是边缘刮奶油。

## 纪元收尾：真机总批（S9 之后才进）

- 总单 = `ai-docs/20260722-v04-device-test-batch.md`。**S8/S9 的新增待验项追加进总单**
  （标节号），别散新文件；对水印 = 届时最终版本（≥v0.4.8）。
- 真机是用户在 iPad 做；agent 接 bug 反馈批逐条修（math/手感 bug 禁猜测式调试，先写清
  输入/输出问题陈述；建议 diagnose skill）。

## 拍板累积清单（施工不阻塞，真机批时或之后统一过）

1. checkpoint-autosave / workbench-session 归属——S8 按「机械落地、挂 session.ts」默认先行，待追认。
2. accept 后选区去留（现状 = 清；spec:219 原文「或者清选区，看UX」）。
3. reject 在 AA 软边选区的覆盖率损失（spec 已预认「不要缓存」；消除它与 spec 冲突，要人拍）。
4. 点选图层是否入 undo（现状 = 不入）。
5. reference-gallery 归属（spec:26 留空；S8/S9 不碰）。
6. 用户首轮真机结果（暂扣中，纪元末揭晓）。

## 必读文档（顺序）

1. `journal/20260721 Architecture.md` — 人类 spec，pin 死不 re-litigate。
2. `ai-docs/20260722-v04-batch1-handoff.md` — 路线图 + 现状地图（S5/S6/S7 均已标 ✅ merged）。
3. `ai-docs/20260722-v04-s7-render-tree.md` — S7 报告（§3 = S8 交接点：sliceRegionToTiles/
   registerPair 消费口、吸管/导出现状、选区 mask 现状）。
4. `ai-docs/20260722-test-charter.md` — 历史 bug → 架构保证映射（H7 液化 RED 待 S8 转绿）。

## 琐碎（继承自前几棒，仍有效）

- worktree 跑 tsc/test 需 `ln -s` 主 checkout 的 node_modules（完工删掉，防误 commit）。
- smoke golden `test/gl-smoke/goldens.json` 是本机 SwiftShader 基线；换机假红
  `SMOKE_UPDATE_GOLDEN=1 npm run smoke` 重录；缺文件自动首录。
- u8 累积器逃生门：dodge/burn/软边累积刺眼 → `render-tree-gl.ts` ctor `accumPrec` 拨回 `"f16"`。
- HUD 第二行 `Np/sb/sh/!` 读数含义与健康形态见总单 §7。
- `test/gl-smoke/preview.ts` 每帧 markDirty 是有意的 worst case，别"优化"。
- GLCompositor 树递归 composite() = smoke 对拍参照，生产不走；S9 嫌它占体重可移进 test/
  harness，但**别删对拍能力**。
- 发版 ritual 照 CLAUDE.md 四步（成对 commit：先源后 bundle）；AI bump patch，minor 要人类。
- worktree 落地：commit 分支 → merge 回 main → push，本地主 checkout 的 main 必须同步。
