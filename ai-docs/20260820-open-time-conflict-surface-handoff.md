# Handoff: gallery 点开不查冲突（open 路径冲突 surface 是死代码）——红线区修复

> as-of WeebPaint v0.10.4 / @internal/store baked 0.1.0, upstream 0.2.0 / 2026-08-20
> **✅ A+B 已修（2026-08-20 同日）**：upstream v0.2.1（commit acb4f05，tag + gh release）；WeebPaint v0.10.10 已收货（0.1.0→0.2.1，跨 0.2.0 skew 一并对齐；WeebPaint 不走 0.2.0 新增的 ./sw 门牌，主门牌增量向后兼容，全量 1051 绿）。实现形状见 §3 各条回写。**C 未动**（badge 透传是产品判断，归人类拍板，单独开单）。真机验收（§4 复现脚本）待跑。
> 风险分区：**store/同步引擎 = 红线区**。动手前必读 `20260601 MyPWAPatterns/docs/MASTER.md` §A，走 `pwa-cloud-store` skill，改引擎前 escalate human（user 已在 2026-08-20 口头开单修此 bug，但持久化结构若要新增字段仍需显式同意）。

## 0. 事故现场（2026-08-20，user 亲历）

外部写入方（OneDrive 桌面客户端）更新了 appfolder 里的 `20260820-夏音线稿.ora`（AI 在 WSL 侧向 OneDrive 本地镜像投递文件，桌面客户端上传）。WeebPaint 本地 IDB 里有同名旧副本。user 实测：

1. **gallery 点开该文件 → 无任何冲突提示，静默打开了本地陈旧副本**（红线「冲突必 surface」被违反的瞬间）；
2. 直到**保存时**才弹冲突菜单（push 412），user 选「用云端覆盖本地（本地先备份进 .backup）」后恢复正常。

user 原话定性：「是wp的红线区错误：你上传好之后gallery点开不检查conflict，必须打开保存时才弹冲突菜单」。

## 1. 违反的契约（出处）

- MASTER.md §A：*"Conflict = dirty ∧ cloudMoved → **surfaced** (sheet), never silent"*。
- internal-store `README.md` §7（~L279-289）：`ui.resolveConflict` **必填，禁 placeholder/noop，绝不静默 cancel**——而现状正是开档路径静默 cancel（见 §2A）。
- **ADR-0016**（internal-store `ai-docs/adr/0016-clean-silent-fast-forward-conflict-on-dirty.md`）= 本案统辖 ADR：clean → 静默快进；dirty → surface，且该保证须**持续**成立。ADR 里 "Pilot impl — landed" 声称 `flow.open` 已实现 dirty 分叉弹 sheet——**现引擎只实现了前半（clean 快进），后半掉了**。ADR 与代码矛盾时以 ADR 为契约、代码为 bug。
- 相关：ADR-0009（冲突必 surface）、ADR-0017（前台新鲜度；其 `lastCheckedAt` 机制现引擎未实现，本案不展开）。

## 2. 缺陷地图（侦察确认，file:line 以 upstream `20260813 internal-store` 为准；baked 0.1.0 与 upstream 0.2.0 此处代码相同，dist 亦同 = bug 在线上）

### A（主犯）：`fresh.open` 的 `onNewer` 从未接线 → 冲突 sheet 在开档路径是死代码

- `src/create-store.ts:622-631` `open()`：本地有副本时调 `fresh.open(name, { isOnline, probe })` ——**没传 `onNewer` / `adopt` / `localDirty`**，且 `FreshResult` 返回值被丢弃，一律 `readLocal()`。
- `src/freshness.ts:86-97`：dirty ∧ 云端动过 → `choice = onNewer ? await onNewer(...) : "cancel"` → 无回调时默认 `"cancel"` → `{ source:"local", reason:"kept" }` 静默保留陈旧本地。
- 全库 grep：`onNewer` 生产代码零调用方，只有 `test/freshness.test.ts` 用到。`store-ui.ts:16-31` 的 `resolveConflict` sheet（标题 `cf.cloudNewerTitle`「云端有新版本」）本就是给开档时用的，现在只有 push 412 一条路能到它。

### B（帮凶）：`seenBase` 为 null 时误判 in-sync

- `src/freshness.ts:77-84`：`if (!base || meta.etag === base) → "in-sync"`——base 丢失（从未 synced 的血统 / 旧版本只 pull 过 / `forget()` 过）被当成「云端没动」。
- 与 listing 的判法**同一事实、相反结论**：`src/listing.ts:79-82` `moved = cloudMoved || !everSynced`（没 baseline 按「云端有别的版本」算）。freshness 应与 listing 对齐。
- base 的两轨簿记见 `local-head.ts:6-15,49-52,79-92`；耐久 etag 轨只在 push/weakOverride/markSynced 时写入（`cloud-sync.ts:114,216,329`、`local-head.ts:106-130`），listing/fetchMeta 从不记——这是 base 会丢的根源。

### C（从犯，app 层）：gallery 明明拿到了 drift 却压扁不显示

- 引擎 watchFolder 的 remote frame 已算出 8 值 syncState（`listing.ts:19-28`），含 `newer-on-cloud` / `conflict`。
- WeebPaint 缝合层 `src/app-store.ts:121-133` `itemToG` 把它压扁成 legacy `{dirty,local,cloud}`：`newer-on-cloud` 变得与 `synced` 无异、`conflict` 与 `unpushed` 无异。
- `src/gallery/gallery-view-model.ts:43` `BadgeKind` 联合类型没有这两个状态的槽位。
- 参考：8-badge 语义对齐 PWAPatterns `state-machine.md`（`listing.ts:17` 头注释）。

### 开档调用链（速查）

`gallery.ts:388 openTile` → `session-state.ts:600/618` → `editor-session.ts:170-189 open()`（L173 注释自称「open 内含 freshness / 冲突 surface」——**注释在撒谎**，正是 A 的产物）→ `create-store.ts:622 open()`。
保存路径（现在唯一活着的 surface）：`session-state.ts:421` → `editor-session.ts:202/121/135` → `create-store.ts:612 push` → `push.ts:61-109`（L82 isConflict/412 → L88 onConflict → sheet）→ `safe-resolve.ts:104-117`（takeCloud = 备份→pull→markSynced）。

## 3. 修复方向（建议，非钦定；实现形状变了要回写本节）

1. **A**：`create-store.ts open()` 给 `fresh.open` 接上 `onNewer`（复用 `create-store.ts:472-475` push 侧 onConflict 同款取双方 blob → `ui.resolveConflict` 的形状）+ `adopt` + `localDirty`；不再丢弃 `FreshResult`。目标行为 = ADR-0016 后半：clean 静默快进（现状已对），dirty ∧ cloudMoved 弹同一张 sheet（keepMine / takeCloud，takeCloud 走 `safeResolve.safePull` 含 .backup）。
   **【回写 v0.2.1 实际形状】**：`onNewer` = push 412 侧**同一个** `onConflict`（同一张 sheet，零新 UI）；`localDirty` 接 `sub.edits.localDirty`（与 safeResolve 同款；WeebPaint 现不驱动该游标 = 恒 false，durable `head.isDirty` 已覆盖事故场景）；**`adopt` 刻意不接**——open 的字节经 `readLocal()` 返回值流回 app（editor 随后 adopt），refresh 才需要 adopt 活替换已开 doc，open 侧接了会双重装载；`FreshResult` 不再丢弃：`error`/`invalid-cloud-bytes`/`cloud-vanished`/`backup-failed` → `ui.reportError(warning)`（用户选了 takeCloud 拉失败时本地照读但必 surface）。
2. **B**：freshness 的 `!base` 分支与 `listing.ts:80` 对齐（无 baseline ∧ 云端有文件 → 按 moved 处理，而不是 in-sync）。注意 clean ∧ !base 的正确动作大概率 = safePull 快进（本地无 dirty 就该拿云端），dirty ∧ !base → surface。
   **【回写 v0.2.1 实际形状】**：照此落地，`open` 与 `refresh` 两处同修（in-sync 条件收紧为 `base != null && meta.etag === base`；in-sync 分支的 markSeen 重捕保留，现无条件调——base 非空已由条件保证）。clean ∧ !base → safePull 快进、dirty ∧ !base → surface，与单测锁死。
3. **C**（可后置/单独开单）：`app-store.ts` 缝合层把 `newer-on-cloud`/`conflict` 透传，`BadgeKind` 加槽位 + gallery tile 显示。**badge 视觉/文案是产品判断，归人类拍板**；引擎侧 A/B 修完后 C 才有意义。
4. 修在 **upstream `20260813 internal-store`**（v0.2.0），加回归测试（`test/freshness.test.ts` 已有 onNewer 的 mock 测试形状可抄），发包后走 WeebPaint `pull-package.sh` 收货——**禁止直接 patch WeebPaint `node_modules/`**（baked 0.1.0 与 upstream 0.2.0 有版本 skew，收货时一并对齐，skew 本身也要留意 0.2.0 里其他未收货变更）。
   **【回写】**：已照此走完。upstream 测试 +11（freshness 单测 6：!base 四象限 + cancel + 离线不回归；新 `test/store-open-conflict.test.ts` 5：真 createStore 复刻事故调用链，含 takeCloud 先落 .backup、clean 快进不弹、in-sync 不弹），库 338 绿；exports 无变化（dist/index.d.ts 逐字节同 0.2.0 → patch 例行）。WeebPaint 收货后 1051 绿。§2A 提的 `editor-session.ts:173`「open 内含冲突 surface」注释自此不再撒谎，未改注释。
5. 库改动纪律：零内容格式知识、app 不许绕库自查 etag；缺口全在库侧补。

## 4. 验收（能 mock 测的先测完，人类真机按批交付）

- 单测：dirty ∧ cloudMoved → open 必弹（onNewer 被调、choice 生效）；clean ∧ cloudMoved → 静默快进拉云端；dirty ∧ !base ∧ hasCloud → 弹；clean ∧ !base ∧ hasCloud → 快进不弹；离线 → 现状（秒开本地）不回归。
- 真机复现脚本（本次事故同款）：iPad/桌面 WP 打开某文件留 dirty 本地副本 → 另一端（OneDrive 桌面镜像放新字节）更新云端同名文件 → 回 WP **gallery 点开** → 应当场弹「云端有新版本」sheet，而不是等保存。
- 红线自查：takeCloud 路径 .backup 真落盘；处处 If-Match 不回归（`push.ts:62,72`、`cloud-sync.ts:194-198`）。
