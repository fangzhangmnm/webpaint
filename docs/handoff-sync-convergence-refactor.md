# Handoff — 云同步收敛重构（ADR-0016 NEEDS REFACTOR）

> 写给接手实现 ADR-0016 的 agent。**决策不在这里**——决策在 ADR，本文只给：要改什么、地基在哪、坑在哪、怎么验。

## 一句话

把"冲突/`.backup` 收敛"从**冲突点**（412，证不出安全）搬到**干净态**（无损快进）。串行两设备改同一张画时不再每次交接刷 `.backup`。决策已拍板（含"干净画布静默变成对方版 = 特性不是风险"），**代码尚未动**。

## 权威文档（别重复，照着读）

- **决策 + 实现 gap 清单**：`MyPWAPatterns/docs/adr/0016-clean-silent-fast-forward-conflict-on-dirty.md`（status: accepted / **NEEDS REFACTOR**）。它的 "NEEDS REFACTOR" 段就是 touch-point 清单。**先读它。**
  - 同目录 ADR-0009（冲突模型，已说"clean→take-cloud / dirty→options"）、0014（stateful authority）、0015（`.trash`/`.backup` same-tier）是它的上游。
- **落地待办 + 根因推导**：`WebPaint/docs/backlog.md` → P1「云同步收敛：干净态快进，别在冲突点修」。
- **同期 sync 体检（0 字节上传 postmortem，已修）**：`WebPaint/docs/reports/20260605-postmortem-zero-byte-upload.html`（`docs/reports/` 是 gitignored，本地看）。
- **领域词表**：`WebPaint/CONTEXT.md` → **Store** 段（flow 全集 / state-as-store / 已接消费面）。

## 硬约束（最重要，违反就推翻重做）

**热路径零网络。** 每画一笔 = 0 cloud call；`clean→dirty` 那道门 = 0 cloud call（只本地快照 `parentBase`）。网络 FF 只在 **focus / visibilitychange / online** 事件、且当前干净时触发（复用现成 SW-update-poke 钩子，`fetchMeta`/etag 级，etag 真动了才拉内容）。**任何把 FF 变成每笔/每编辑轮询的设计都是错的。** 见 ADR-0016 §7。

## 要改什么（代码锚点，截至 commit `8a41b89`；见下"协作警告"）

1. **Store 加 `parentBase` + `clean→dirty` 门**（`src/store/store.js`）
   - 现状：`baseFor()`（store.js:50）在 `_base` 缺失时回退**跨 tab 共享的 `cloud.getETag`**（localStorage）——这正是蛙跳 + W2 风险点。`parentBase` 要取代这个语义：每次编辑会话捕获"派生自哪个云版"。
   - 门 = 第一次 `edits.mark()` after clean（`edits` 在 store.js，有 `mark/markSaved/localDirty`）。门只快照本地 base，不发请求。
   - `push` 比 `parentBase` vs server = 现有的 `If-Match`/412，白嫖。**push 若发现 dirty 但无 parentBase → 抛**（防 AI/新路径 bypass）。
2. **App 加事件驱动 FF**（`src/app.js`）
   - 现状：活动 doc **只在 open 快进**（`gateCloudSyncOnOpen → checkCloudETag → flow.open`，app.js ~2140）。要在 focus/visibilitychange/online 且 `!localDirty && !cloudDirty` 时也做（无损 `_safePull` 语义）。**不要**每笔/每编辑。
3. **同步字节剔除视图态**（`src/app.js` saveAndPush 的 encode，~2966：`webpaintState.viewport: {...board.viewport}`）
   - viewport 是 per-device UI，进了同步 `.ora` → `_tryHeal` 的 `bytesEqual`（store.js:58）跨设备永不命中 → 纯平移也算冲突。剔除（或 heal 只比像素部分）。
4. **`_safePull` dirty-gate**（store.js ~112）
   - 现状无条件 `local.backup` 再覆盖，**即使本地干净已同步**（可从云端拿回、无未见内容）→ 冗余 `.backup-local`。改成仅 `localDirty || cloudDirty` 才备份（ADR-0009 早就要求"clean switch never spams backup"）。
5. **别做**：后台 idle 轮询（会把 Store 变成主动 agent）= 另一个更大的 ADR，**不在本次范围**。

## 已经做完的（别重复，是地基）

最近一串 commit（main，全部 **未真机回归验**）已经把同步面收拢好，ADR-0016 才好做：

- 文件管理（删/改名/移动/还原/彻底删）全走 `store.flow.*`（`flow.rename` 已泛化为"具名文件"，encode 可选）。
- Store 死面清掉（`flow.close`/`store.active` 删，`replayDelete` 标 NOT-WIRED）。
- 本地 dirty 收成单一权威：`store.edits.localDirty()` 派生自编辑游标（删了 app 的 `_docDirty`）——**这就是门要用的信号**。
- 两条本地落盘路径合一（`session.putSessionPkg`）。
- **0 字节上传 bug 已修**（`onedrive-provider.upload` 把 Uint8Array 包回 Blob；`cloud-sync.push` H7 兜底核对 size）。
- backup 命名/防撞/命名空间收进深模块 `src/store/move-aside.js`（`<base> [yyyymmddhhmmss-guid]`；本地隐藏前缀 `.backup-local/`；云端 `.backup/` 现也整个隐藏不漏进 gallery）。

git log（main）：`8a41b89`(backlog) ← `07892ff`(backup 统一, **= 当前 prod**) ← `f52fb91`(0字节) ← `40b5a52` ← `91afb51`(dirty SSoT) ← `56fc903` ← `9843cb2`。

## 怎么验

- `node test/run.mjs`（截至 `8a41b89` 是 41 passed；另一 agent 动过 store-flow.test.mjs，先重跑拿当前数）。
- **对抗性测试纪律**（本仓已成习惯，照做）：每个修复配一个 fail-before/pass-after 的测试，并**真的 revert 实现跑一遍确认它会挂**。MockCloudProvider + MockLocal 能在 node 全测同步逻辑——WSL 开不了浏览器，这是你的主验证手段。
  - ADR-0016 该补的测试：clean+focus → 静默 FF 不弹冲突不刷 backup；dirty 分叉 → 才 backup；push dirty 无 parentBase → 抛；同图异 viewport → heal 命中（剔除 viewport 后）。
- 构建：`bash scripts/build.sh`（产 `dist/<hash>.mjs` + 改 index.html 引用）。
- **真机**（用户跑，你跑不了浏览器）：串行两设备交接不刷 backup；干净端切回来内容自动变最新；并发双屏才弹冲突。报告写 `docs/reports/`（gitignored）。

## 规矩（本仓约定）

- DEV：build+commit+push main 是常态；**PROD（push 到 `prod` 分支）必须问用户**（prod 现在 = `07892ff`）。
- 纯中文 UI / 无 system alert / 不声称"浏览器里验过"（说"未真机验"+ 列待验项）。
- 字节契约教训（postmortem）：lib↔transport 接缝的字节表示要钉死；mock 别比真 transport 宽容。

## 建议技能（suggested skills）

- **grill-with-docs**：动手前把 ADR-0016 的 `parentBase`/门 设计对着 CONTEXT.md 再磨一遍，顺手把新术语（parentBase、edit-lease）写进 CONTEXT。
- **tdd**：red-green 正好配"对抗性测试 fail-before/pass-after"的纪律。
- **code-review**（或 `/code-review ultra`）：改完 sync 红线代码后过一遍。
- **improve-codebase-architecture**：本轮就是它起的；后续 store 按 storage-shape 分层（Substrate / WorkFileFlow / FolderFlow，见 CONTEXT.md Store 段末）也用它。
