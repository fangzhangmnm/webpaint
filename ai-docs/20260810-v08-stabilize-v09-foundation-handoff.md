# 0.8 维稳 → 0.9 地基纪元 · 战略交接

> as-of v0.8.48 / 2026-08-10。出处 = 2026-08-10 战略讨论 session（C 骑士验收 → 停下来整理战略）。
> **user 原话一律实引并标「user:」**；AI 的裁定/建议标「AI:」；没拍板的进 §6 显式挂起。
> 读者 = 接棒 session。总背景：C 骑士 C0-C9 清账（`20260809-c-backend-handoff.md`）后验收，
> user:「验收不合格的原因很简单：你自己看一下src的目录结构，还是散一地」→ 本轮不埋头设计，
> user:「嗯你看得出来我们现在需要的不是埋头设计，而是停下来整理战略吧」。

## 0. 总路线（user 拍板，2026-08-10）

> user:「先维稳，v0.8ipad到能push的程度，然后一张画跑通。没做的骑士进历史遗留任务。
> 然后bump0.9。然后开始搬文件夹，分仓，西化，journals还没想好要不要公开，
> 也许到时候抽查一遍就知道了。不公开的方案也过一遍。」

即：**0.8 维稳批（§1）→ bump 0.9 → 地基纪元（§4：ext4 迁移 / 分仓 / 全盘西化）**。
没做完的骑士不带进维稳批，全部进历史遗留账本（§3）。

## 1. 0.8 维稳批（当前批，按序）

1. **C 收束口径修正**：C handoff 补尾注——backend 两个 win condition 分开记账（§2），
   不改「C0-C9 清账」事实，改的是「收官=搬完」的误读口径。
2. **push dev**：本地 main（v0.8.48 = 4ba9aef）领先远程，iPad 看不到——**需 user 授权**
   （新 session 第一批默认不 push 家规）。
3. **真机批总单**：悬账 24 条（workpiece v2 handoff §4 口径）+ C 各片追加锚（C0 fill 色窗 /
   C3 缩略图导出 / C4 裁决 fill·persp undo / C5 压感 / C6 液化替身 / C7-C8 无令牌硬化红 banner 探测）
   + **C9 参考窗全功能回归置顶**。C9 置顶理由，user:「虽然我一般会对你实机测试的建议不耐烦，
   但是这次因为用了webcomponent这个新技术，我也不知道是什么样，所以反而需要测试」——
   shadow DOM 事件所有权 / 图标烤入 shadow / wp:modechange 桥全是首次上真机。
4. **iPad 批 → 0.8.x patch 修**。
5. **「一张画跑通」= 0.8 的端到端 win condition**：新建 → 画（含 C6 三户手感）→ 存 → 云同步 →
   图库 → 导出。
6. **bump 0.9**：minor 需 user 显式版本号（家规）；同时按家规问 user **要不要把 0.8 终点推 prod**
   （新纪元开工前给线上稳定快照）。

## 2. C 骑士验收结论（两个 win condition，口径修正）

- **user 的判据**：「backend的win condition，我删掉backend common之外的文件能编译。……
  反正就是删文件夹能编译，或者每个子文件夹是类似mjs的干净」。
- **闭包（C 宣称的）：已达成、机器可验**。lint-dirs 绿 = backend 只 import common/vendor、
  common 零 import → 「删 backend/common/vendor 之外能编译」成立（2026-08-10 复验）。
- **器官全入城（user 的深层标准）：未达成、也从未被宣称**。拆户里的 backend 器官是
  frontend/shell 侧在消费的代码，backend 不 import 它们 → 闭包不破、lint 永远抓不到这笔账。
  清单见 §3.2。user 裁定语境:「拆户含有backend器官，说明C没做完」。
- **典型案例 = crop fork 债**：C8 的 backend crop 是 doc-ops runDocTransform 的「headless 同构」
  ——substrate verbs 同一份，但**编排层两份平行代码**（UI 走根上 doc-ops、MCP 走 backend 重写）。
  同构≠同一份。
- **教训入制度**：闭包 lint 管「城里不许伸手出去」，管不了「该进城的流落在外」——后者只能靠
  户籍普查（survey 对照）当审计器。两个都要。
- handoff 没藏账（survey 拆户、algorithms README 挂账都在），是「C3 完 ✅ / C 收官」的**口径**
  容易读成「搬完」——口径罪不是假账罪。

## 3. 历史遗留账本（0.9 之后按新制度消化，维稳批不碰）

（user 的 13 条 competing tasks 原文见 §7 索引，此处按归置排列。）

### 3.1 src 现状（验收不合格的实数）
src 根平铺 **88 个 .ts**；编外顶层目录 `ui/`(10)、`plugins/`(8)、`i18n/`(3)、`editor-session/`(2)。
survey（`20260809-file-naming-survey.md`）已给全部去处：~45 frontend、~28 shell、~20 拆户。
根目录本身无格律——散是结构性的。

### 3.2 拆户 backend 器官（闭包外流落者）
pixel-conic 光栅原语、doc-ops 脊柱（+crop fork 债收敛）、color-name 数学、board commit 面残余、
rasterizePolygonGray8（被 Selection→common 拖住）——survey 备注与 algorithms/README 挂账为准。

### 3.3 UI 骑士（黄线 + 状态机，延后 grill）
- user:「前端不是纯接线，而是有黄线（红线是数据安全，黄线是核心体验grill资产）手感交互的
  一大堆资产。这个可能得抽象成一个状态机之类的。是需要grill的东西」
- user:「UI，接线的一刀没画清楚」「backend和前端的一刀其实我们做的还是比较草率的，
  很多UX的归属还是没理清楚」
- **但不现在设计**，user:「我现在凭直觉设计一个状态机模型，肯定和reality有漂移，
  可能很多交互都会不对」→ AI 裁定获认可：先户籍普查攒证据（每次过审=一份档案：职责/黄线标记/
  依赖），证据厚了再 grill 状态机。
- user 直觉的顺序：「需要先做UI兄弟共享库，之前是从底下刀，这次是把UI接线的混乱解决了，
  奶油挂完了，才能把中间层给暴露出来，不然我怀疑你会这个不敢动那个不敢动刮痧」。
- AI: 黄线写进户籍档案（红=store/数据安全、黄=手感/交互状态机/UX 拍板——改前 grill+真机锚、
  白=胶水 greenfield）——把 CLAUDE.md「人类钉死区」从口头传统变逐文件登记。

### 3.4 gallery / shell / 中间层
- user:「重构兄弟项目时我又想等gallery和shell，然后gallery又要等UI」「UI出来之后Gallery才能抽，
  然后中间层才能逃，不过也许相反」。
- user:「shell我们也一直没有整顿它的理想形态是什么」→ AI: shell 靠减法显形——UI/gallery
  人口迁走后剩下的就是 shell 本体，不必先验设计。

### 3.5 webcomponent 化 / 单 html
- user:「webpaint的webcomponent化，single html化（也许这个直接靠webcomponent免费拿）
  逼出很多东西。注意这里的component不带gallery，所以也许还是需要胶水。」
- 单 .html 发行原在 B 剩余批（非 mhtml，base64 内联，单文件+目录双产物）。

### 3.6 封建骑士 / 插件化（停车场）
- user win condition:「我们可以给痛恨ai的artist专门做一个compile target，里面一句AI都没有。
  或者我觉得那个shapes是pile of shame永远用不到，可以热插拔。」
- user:「插件化的问题是太多东西我们没有摸清楚了」→ 停车场。
- AI 裁定（user 未反对未拍板）：插件化≠封建——封建是编译期领土纪律，插件化多的是运行期注册缝；
  「可删⇒可抖（tree-shake）」，**构建期选择性 import 一个 entry 就够零 AI target**，
  不需要运行时插件系统。封建不立专门一轮，是常设纪律（同版本 ritual 级），条文随西化落。
- shapes/genAI 的包形态见 §6 未拍板。

### 3.7 B 剩余批（原 C handoff §3 悬账，照搬）
password 契约、单 .html 发行、pwa wizard、三兄弟对齐。

### 3.8 已落地的（不再是 TODO）
- **测试制度**：user「testing也需要整理设计制度化了（出了几个会把全量测试卡的20min也跑不完的
  东西，需要整顿）」→ **已由 v0.8.48 落地**（每测实时耗时 + 10s 超时墙 + 全量<1min 硬线 +
  2min watchdog + 长跑纪律入 CLAUDE.md；34min「慢测试」实为 boot smoke 挂死，禁跑令已撤回）。

## 4. 0.9 地基纪元（顺序已拍）

### 4.0 前置：remote 清账 + journal 备份
- 各 repo 本地未 push 账盘点清零（唯一真备份策略 = canonical 内容全有 git remote，
  本地盘降格为可丢弃工作副本）。
- **journal/ 是当前唯一裸奔资产**（gitignored、无备份），user:「一大堆人类的journal都没有备份」。
  两案见 §5。

### 4.1 ext4 迁移
- user:「jupyterlodal文件夹整体迁移linux可接受，但是我总觉得vhdx不安全」→ 解法不是不迁移，
  是迁移前把「只活在盘上的东西」清零（§4.0），vhdx 炸了=重 clone。
- **关键账**，user:「迁移jupyter local关键是claude code的引用也得全量改meta」：
  ① `~/.claude/projects/` 的记忆/会话按**项目绝对路径 slug** 做 key——搬家=失忆，
  需 slug 目录改名（确定性映射）；② grep 全量绝对路径引用（memory 的
  `reference_sibling_paths.md` 首当其冲、settings 权限、脚本/CLAUDE.md 硬路径）；
  跨仓相对路径不受影响；③ 迁完开 session 验证记忆/技能/权限再删旧副本。
  一个脚本+一次 grep 的量级。
- 甜头：DrvFS 正是 pnpm symlink 雷的来源，迁完自动拆雷（§4.3 勘探少一项）。

### 4.2 分仓（包化）
- **包名单已拍**，user:「store, UI, gallery, workpiece. 是包同意，然后webpaint的终极形态也是
  一个大包，可以被别的项目import的那种」。
- **仓模型已拍**，user:「我的模型是每个项目一个git，然后每个package(不是module)一个git.
  然后项目会pin一个package的版本，也可以某天专门升级一下」。
  AI 记录的唯一代价：强耦合库跨仓重构要跨仓跳舞（改 A 发版→B 升 pin→再改 B）；
  忍不了再考虑库群同仓，可延后。
- **不抢跑拆仓**：现在只有 store 有真的多消费者（user:「store真的需要backpropogate to
  兄弟项目了」）；workpiece 等 CatsUp 真要（user:「undo+workpiece体系我也想抽出来，
  防止catsup重复劳动」）；UI/gallery 等抽出来再说。
- **包≠module**（30 秒科普已过，user 认可方向）：包=版本/发布/所有权单位，module=封装单位；
  sub-sub folder 不做包，做带门牌的 module（numpy 一包多模块同构）。
- dev/prod 与 iPad 不受影响：**库仓不需要 Pages**（只发 tgz，公开仓零成本）；app 仓维持
  公仓 + main→/dev/ + prod 分支（user:「我需要的ipad看dev，而且也没充值」——现状本就满足，
  且 user 确认:「现在所有东西绑的gh pages也是公仓」）。

### 4.3 全盘西化（pnpm workspaces + TS project references + Changesets）
- **拍板**，user:「我的想法是直接用2026年的制度比我们手搓封建制度要好，所以应该是最不休克的
  快速『全盘西化』」+「我的直觉是应该全量（不掉任何功能）不休克比休克疗法好」。
- **制度先行获背书**，user:「我还是觉得制度是用来把你逼对的，而不是整理好了再上制度，
  那个叫形式主义」→ AI 收回「先普查再上制度」的顺序。技术理由：pnpm `exports` 门牌 +
  workspace 边界是 **resolver 级 enforce**——违规 resolve 不到，比手搓 lint 硬。
- **手搓件的去留**：可被工业件替换的全替换（目录依赖 lint→workspace 边界、.h 生成→
  project references declaration emit、版本/CHANGELOG→Changesets）；活下来的三样 =
  禁浏览器词 lint、黄线风险分区标记、隔离区冻结。
- **vendor 家规澄清**（user 更正旧规）：「不用npm这条可能得再议。那都是我刚开始学coding agent
  时候的东西，而且我说的是第三方明文缓存到vendor，而不是我们不能用包管理的软件，但是我们确实
  不用注册类似pypi的东西，但是我还是希望有包管理软件的依赖，版本管理。这个比手动拷贝要重要」。
  → 运输走 vendor（自包含），账本走包管理器。手动 cp 的真实缺陷=无版本元数据/无 lock/无传递解析。
- **自包含不变量（第一条钉死的设计约束）**：user 判据:「兄弟项目里有store的全量code，我删store
  或者被删号，只克隆了webpaint的别人代码不崩，能做到吗？」→ **「克隆任一 app 仓，断网能构建」**。
  实现：库发版打 `.tgz` commit 进消费方仓（`file:./vendor-pkgs/xxx-1.2.0.tgz`）。
  **纯 git-tag 依赖不走**（上游删库=装不出来；lockfile 只锁哈希不存内容）。
  user 想象的「类似pip的本地的东西，你给版本号就帮你clone的vendor里面」= 包管理器本身 +
  一个 `pull-package` 小脚本（extract-icons 同款 app 侧入口）。
- **火车头恐惧已澄清**（user:「如果所有项目都引用同一个物理文件夹，那么只要改一行所有的旧app
  全变……真·harrass全村祖坟」）：pnpm store 内容寻址**只读**，新版本=新条目；lockfile 锁精确
  哈希；升级永远显式。怕的场景只在 `workspace:*` 跟 HEAD 模式——只用于单仓内部（原子 commit
  同测）。跨项目一律 pin 版本化产物。
- **勘探雷（切第一刀前必探）**：① DrvFS symlink（ext4 迁移后自动拆；不迁先用
  `node-linker=hoisted`）；② deploy.yml 白名单——路径变动**静默 404**（v0.7.33 原坑）；
  ③ node test runner 对 workspace 包名 import 的 resolution。
- **第一刀**：WebPaint 仓内 workspace 化——backend+common 包化（已被 lint 证明 import 闭合，
  正好整刀切）；`src/` 剩余 = app 包 = **隔离区本体**（user:「把未归类的和新增的未归类的
  要不要专门建一个隔离区？」→ 要，且 app 包行数就是进度条）。
  每刀只切闭合子图、tsc 审计归零、不留双轨 import 过夜——双轨长存是唯一真会盘根错节的东西。

### 4.4 户籍/folder=module 制度（西化的城内条文）
- user:「文件夹制度。这个是我这轮重构最想要的」。
- **层层分封 + 每层门牌**，user:「我的想法是每个子文件夹都要有manifest，一层层分封。
  父文件夹只用管子文件夹，甚至每个子文件夹有h或者接口。对人类来说这样太迂腐，但是对ai来说
  这个可以根治我（人类）『不看code』的问题。因为我不是不看，而是code太混淆了。」
  → 执法原语：folder=module，跨文件夹 import 只准打门牌（index/.h），deep import lint 咬；
  包级由 `exports` 字段 resolver 咬。
- **manifest 防腐警告（AI，必须遵守）**：manifest 以生成物为主（.h 是 tsc 生成不腐），
  手写散文部分要短、带 as-of 戳——否则是在造 211 个新的无失效缓存。
- **造新城 vs 封城的裁法**（user meta 问题:「造新城还是先封城。这是一个比较有趣的meta问题」）：
  城墙（接口+manifest+lint）用封城方式立——快、机械、全境；城内用造新城方式换——
  user:「我对户籍的直觉不是拆棚户区，而是造新城……就和我们之前器官移植的思路一样，
  只有我手动一个一个模块重新设计，才能一块一块搭建好」。
  **带门牌的棚户区是合法中间态**，user 自己的范式:「比如store，还是可以外面整整齐齐一个
  我grill好的接口，里面还是棚户区，然后以后可以里面再封建一次」。
  包边界只 enforce 依赖方向不 enforce 内聚——造新城（人肉 grill）不可被制度替代。

## 5. journal 两案（未拍板，两案都过）

- user:「没想好要不要进公仓」；公开的动机（更早原话）:「我一开始说的是journal进公仓，
  也许以后ai或者人类学这个非常实战的vibe coding经验还是有意义的」；决策方式:「也许到时候
  抽查一遍就知道了。不公开的方案也过一遍」。
- **结构性事实（让决策不着急）**：私仓备份与公开解耦——私仓（免费，journal 不需要 Pages）
  现在就能建，裸奔备份即刻解决；将来公开的正确姿势**不是翻私仓公开**（git 历史不会忘），
  而是普查后从干净快照另立公仓。先私仓不锁死任何选项。
- **公开前置**：公开出版级普查（token/密钥之外：真名、他人信息、邮箱、路径身份残留），
  **在首次公开 commit 前扫完**；公开是单向门，逐条 user 拍板。
- **AI 权限边界**：硬规则 #2 照旧——AI 对 journal 只读；可做只读扫描出报告，内容零改动；
  进了任何仓之后 AI 不写的规矩不变。

## 6. 未拍板清单（显式挂起，勿提前固化）

1. journal 公开与否（§5）。
2. 库群要不要同仓（每包一仓已拍为默认；跨仓跳舞疼了再议）。
3. AI/genAI、shapes 的包形态——AI 建议 exports 子门牌 + 构建期选择性 import（§3.6），
  user 问过（「然后AI，shapes做成什么呢」）未拍。
4. UI 状态机设计（等户籍档案证据，§3.3）。
5. ~~0.9 具体版本号 + 0.8 终点要不要推 prod（维稳批第 6 步现场问）~~
   → **已拍（2026-08-12）**：v0.9.0；v0.8.48 已推 prod。详见 `20260812-v090-epoch-open.md`。
6. unity inspector UI（user 提过一嘴:「之后再做unity inspector UI?」——归 UI 骑士语境，未展开）。

## 7. user 原始 competing tasks 13 条 → 归置索引

| # | user 原话（缩） | 归置 |
|---|---|---|
| 1 | 检查和一开始的5骑士的漂移程度，完成程度 | §2 已做 backend 半；全量漂移审计并入户籍普查（§4.4/§3.1） |
| 2 | 文件夹制度。这个是我这轮重构最想要的 | §4.3/§4.4（西化+户籍） |
| 3 | UI抽出来 | §3.3（等证据再 grill） |
| 4 | UI出来之后Gallery才能抽，然后中间层才能逃 | §3.4 |
| 5 | 未归类的要不要专门建隔离区 | §4.3 第一刀（app 包=隔离区） |
| 6 | store/UI/gallery 模块化移出去、pin 版本 | §4.2 |
| 7 | webcomponent 化、single html 化 | §3.5 |
| 8 | 封建骑士/零 AI compile target/shapes 热插拔 | §3.6 停车场 |
| 9 | store backpropagate + 包管理 best practice grill | §4.2/§4.3（科普已过，正式 grill 随第一刀） |
| 10 | 重构兄弟项目等 gallery/shell | §3.4（最后） |
| 11 | shell 理想形态 | §3.4（减法显形） |
| 12 | undo+workpiece 抽出防 CatsUp 重复劳动 | §4.2（等 CatsUp 真要） |
| 13 | testing 制度化 | §3.8 **已落地**（v0.8.48） |
