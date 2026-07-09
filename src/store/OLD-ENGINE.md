# 旧引擎（store.ts）seam + API 全貌 —— 重构前的 escalation 底稿

> 目的（按 #79）：**不做 facade**。要把旧引擎正经重构成 README.md 那套新 API，先把旧版本的**注入 seam** 和**对外 API interface** 摊开给人看清，再决定怎么切。
> 来源：通读 `store.ts`（~1050 行，2026-06-21）。这是 WebPaint baked、身经百战的 work-file 同步引擎，红线全在库内 enforce。

---

## 一句话结构

`createStore(deps)` 一个工厂，内部不持 UI、不碰 DOM。它管两个 adapter（`cloud`=CloudSync、`local`=IDB），把同步**编排**收拢，对外暴露一个 `{ flow, …crypto helpers…, edit, busy, autosave, cloud, settings, … }` 大对象。**红线在库内，不在 UI。**

---

## A. 构造注入 seam（`StoreDeps`，createStore 的参数）

| seam | 类型 | 作用 / 备注 |
|---|---|---|
| `cloud` | `CloudSync` | **必填**。云端同步层（push/pull/fetchMeta/trash/rename/weakOverride/…，见 types.ts）。 |
| `local` | `LocalCache?` | IDB 本地缓存（save/get/backup/trash/hardDelete/restore/…）。不传 → 本地相关 flow 不可用。 |
| `kv` | `Kv` | get/set/remove。**唯一**让库读写 localStorage 的口（etag/dirty 态、删除队列、settings）。 |
| `busy` | `BusyFn?` | 全屏锁屏包装 `(label, fn)=>Promise`。契约：立刻显示吞输入的全屏遮罩、`await fn()` 原样透传、结束收起、**必须可重入(ref-count)**。不传=passBusy(直接跑，无锁屏)。 |
| `crypt` | `{ ext?, makePeek?, getPassword? }?` | 加密 app 接缝。`ext`=真扩展名进 meta；`makePeek(plain)→不透明字节`=app 抽预览(**唯一一行 ORA 知识**)；`getPassword(name)→string\|null`=**同步、非交互、只读内存**，store 唯一密码来源。 |
| `crypto` | `CryptoCodec?` | zip/7z codec（HOST-SEAM，我 2026-06-21 改的注入）。不传→加密不可用。**注：#78 已决定 7z 走注入、zip 随库，这块要重做。** |
| `validateAdopt` | `(blob)=>bool?` | 采纳云端字节落盘**前**校验是真容器（挡 captive-portal HTML 覆盖好本地）。store 格式盲→逻辑 app 给。 |
| `maxAttempts`/`backoffMs`/`sleep` | | push 重试退避参数。 |

**观察**：`busy` / `crypt.getPassword` / `validateAdopt` / `crypt.makePeek` —— 这四个就是新 README.md 里 Model B `ui` 想收编的"UI/app 决策 seam"，现在散在构造 deps + 各 flow 的 opts 里。

---

## B. 逐 flow 的 callback seam（每个 flow 方法另收的 opts）

旧引擎**没有**统一的 `ui` bundle；每个 flow 方法各自收 UI/env 回调：

- **`open(name, opts)`**：`isOnline` / `probe` / `onNewer(ctx)→choice` / `adopt(blob,name)` / `busy` / `now` / `localDirty`
- **`push(name, opts)`**（`_doPush`）：`encode()→bytes` / `getEditVersion` / `onConflict(ctx)→choice` / `adopt` / `saveBranch` / `now` / `busy`
- **`refresh(name, opts)`**：`isOnline` / `adopt` / `localDirty` / `busy` / `onReplaceStart`
- **`delete(name, opts)`**：`isOnline` / `confirm(ctx)→bool` / `onDirtyWarn(ctx)→bool` / `busy`
- **`rename` / `saveAs`**：`encode` / `getEditVersion` / `cloud?` / `busy`
- **`restore` / `purge` / `emptyTrash` / `newFolder` / `deleteFolder`**：`confirm` / `busy` / `isOnline` / `scope` 等
- **`save(name, {encode, hint})`** / **`load(name)`**：本地落盘/读取，自动包/解壳
- **`acquire(cloudName, opts)`**：`localName` / `adopt` / `busy`（首取云→本地，无冲突）

**冲突决策回调**：`onConflict`（push 撞 412）和 `onNewer`（open 发现云端更新）返回 `ConflictChoice = "keep"|"pull"|"branch"|"weak-override"|"rename"`。**store 调它拿选择，然后 `_resolveConflict` 在库内执行后果**（pull/branch/weak-override 都在库内做）——这已经是 Model B 的形状，只是回调名/选项跟新 README.md 的 `resolveConflict`+`{keepMine,takeCloud,cancel}` 不一致。

---

## C. 对外 API interface（createStore 的 return）

### C1. `flow.*`（同步/持久编排）
| 方法 | 干什么 |
|---|---|
| `push` | 推当前字节到云（If-Match=parentBase，412→heal/onConflict→_resolveConflict）。后台流，不进单飞守卫。 |
| `open` | 开 session 的云端 gate：clean→静默快进、dirty→onNewer 弹「拉/留/分支」。 |
| `refresh` | 事件驱动(focus/visibility/online)的"干净无损快进"，只 metadata，dirty→no-op。 |
| `acquire` | 首取云端 item 到本地（gallery 拉取，无冲突）。 |
| `save` / `load` | 本地落盘 / 读取（明文绝不落盘：save 自动包壳、load 自动解壳，locked→status）。 |
| `delete`(单飞) | 三态删除=move-aside（仅本地/仅云/两者；离线排队 replayDelete）。 |
| `rename`/`saveAs`(单飞) | 身份变更（phantom-path 红线：先存新名再删旧名）。 |
| `restore`/`purge`/`emptyTrash`(单飞) | 回收站恢复/永久删(强制 danger confirm)/批量清。 |
| `newFolder`/`deleteFolder`(单飞) | 空文件夹增删（删除"必须空"在 cloud 内强制）。 |
| `encrypt`/`decrypt`(单飞) | 切 at-rest 加密态（换文件体，本地先落、云端 If-Match 跟进、错密码先出局）。 |
| `replayDelete`/`drainDeleteQueue` | 离线删除队列重放（base-etag 守卫：被改过→edit-wins 不删）。 |

### C2. 加密/读侧 helpers（格式盲，peek 解释归 app）
`seal`/`unseal`（旁路字节包/解壳）· `verifyPassword`（解 peek 便宜验，UI 解锁循环用）· `verifyContainer` / `unsealWith`（导入外来加密文件，显式密码）· `looksEncrypted` / `isEncrypted`（加密态查询，SSoT=字节尾扫）· `loadRaw`（原始字节不解壳）· `getTailBytes`（尾部 N 字节，本地/云端自动路由）· `decryptPeekBytes` / `readPeek`（尾片→peek 明文，非交互）。

### C3. 状态 / 节律（state-as-store，app 不直碰 localStorage）
- `cloud`(=cloudState)：`isDirty`/`getETag`/`setDirty`(**clean→dirty 门，唯一捕获 parentBase 处**)/`status`。
- `settings`：`get`/`set`/`remove`（`settings:` 前缀的通用 KV）。
- `edit(name)`：work-file **唯一编辑入口**（推编辑游标 + 经门标云脏）。
- `busy`：transient `saving`/`pushing`/`replacing` 状态位 + `whenPushIdle()`。
- `autosave`：`configure(persist)`/`start(ms)`/`stop`/`flush`（本地落盘节律，3min 兜底+生命周期 flush）。
- `edits`(sub.edits) / `session`(sub.session)：编辑游标 SSoT + save 合流 coalescer（住 substrate）。
- `adoptBase(name, etag)`：open/采纳 item 时捕获本 tab 的 base-etag（C4）。
- `_internal`：toU8/bytesEqual/seenBase/parentFor/hasParent（测试/内省）。

---

## D. 内部架构 & 红线机制（重构时**绝不能丢**的东西）

1. **substrate**（`createSubstrate`）：编辑游标(`edits.mark/version/localDirty`) + **push-serialize**(`serialize`/`serialize2` 按 name 串行) + save 合流(`session`)。shape-agnostic，WorkFile/Folder 共享。
2. **`_base`（per-tab 已见云版）**：`name→etag`。**只用于 open/refresh 比对"云端动没动"**，绝不当 push 的 If-Match（W2 红线：陈旧推被误判无冲突→静默覆盖）。
3. **`parentBase`（ADR-0016 §4）**：`name→etag`，"当前未推编辑派生自哪个云版"。**push 的 If-Match 唯一来源**。捕获=clean→dirty 边沿(`cloudState.setDirty`)；清除=采纳云版后。有 bypass 守卫：dirty 却没 parentBase→响亮抛错，绝不静默覆盖。
4. **冲突解决**（`_resolveConflict`/`_safePull`）：pull/branch/weak-override 在库内执行；`_safePull` = **先 backup 再覆盖**(A4/A10)、dirty 才备份、clean 跳备份(ADR-0016)、采纳后置(R1：etag/dirty 只在 local.save 成功后推进)。
5. **加密包壳**（`_seal`/`_unseal`）：encode 永远出明文、落盘/推送前按 name 的 at-rest 加密态包壳，**调用方零感知**；密码非交互(`getPassword`)，锁定→响亮 LOCKED / status。
6. **single-flight 守卫**：8 个用户态写流同一时刻只一个（throw STORE_BUSY）。与 busy 正交、更硬（无 UI 也挡得住）。
7. **删除队列持久化**（kv `delqueue:v1`）：离线删排队、重连 `drainDeleteQueue` 按 base-etag 守卫重放。
8. **lost-response 自愈**（`_tryHeal`）：412 时拉云逐字节比对，相等即自愈(B5/W1)。

---

## E. 旧 API ↔ 新 README.md 的 GAP（重构要弥的缝）

| 维度 | 旧引擎（现状） | 新 README.md（目标） |
|---|---|---|
| 入口 | `createStore({cloud, local, kv, busy, crypt, …})`——收**已造好的** cloud/local | `createStore({provider, ui, sevenZip?, …})`——收 **provider**，cloud/local 库内自造 |
| UI 决策 seam | 散在 deps(`busy`)+各 flow opts(`onConflict`/`onNewer`/`confirm`/…) | 统一 `ui = {busy, askPassword, resolveConflict, reportError}` |
| 冲突选项 | `"keep"\|"pull"\|"branch"\|"weak-override"\|"rename"` | `"keepMine"\|"takeCloud"\|"cancel"`（收敛成 3 个） |
| 密码 | `crypt.getPassword` 同步读内存 + flow 返 `locked`，UI 在 busy 外循环 | `ui.askPassword` 异步，**store 驱动**验+重试循环 |
| 文件对象 | 无；按 `name` 散调 `flow.push/open/save/…` | `store.file(name,{isZip})`→`RawFile`/`ZipFile`（带 save/open/rename/delete/setPreview） |
| 集合 | 另一套 `folder-store`（app 注入 snapshot/encode/decode） | `store.collection`（自拥内存、JSON 自序列化）—— **已新建好** |
| 设置 | `settings`(local KV only) | `localSettings` + `syncedSettings`(key-as-item) —— **已新建好** |
| 加密引擎 | `crypto` 注入整个 zip+7z codec | zip 随库 + **仅 7z 注入**(`sevenZip`)，不注入→`store.encryption` 类型不存在 |
| 预览 | app 经 `crypt.makePeek` 回调抠 / `readPeek` 读 | `ZipFile.setPreview(blob)` 显式给 / `getPreview()` |
| barrel | index.ts 导出 createStore + createCloudSync + folder-store + memKv… | 只导出 `createStore` + provider，其余封死 |

---

## F. 重构的真问题（给人决策，不 facade）

旧引擎的**红线 guts**（D 节 1-8）是对的、要原样保。要改的是**外壳/接缝形状**（E 节）。三种切法：

- **(R1) 原地改签名**：把 `createStore` 的入口从 `{cloud,local,…}` 改成 `{provider,ui,…}`，库内自造 cloud/local；把散落的 `onConflict/onNewer/confirm/busy` 收敛进 `ui`；在同文件加 `file()/collection()/settings/encryption` 组合层。**guts 不动，只动接缝。** 风险：store.ts 变更大，但都在编排层、红线函数不碰。
- **(R2) 拆引擎与门面两层**：`work-file-flow.ts`(纯 guts，保持现状) + `store.ts`(新 createStore，组合 work-file-flow + collection + settings + encryption，映射 ui)。——你说这是 facade、否决了。
- **(R3) 收敛 seam 后原地长**：先只做"统一 ui seam + provider 入口"这一刀（E 的前 4 行），file/encryption 等增量长在同一文件。

我的倾向：**R1**（原地改接缝、guts 不动）最贴你"静下心重构、别加层"的要求，且不违反"同步引擎改前 escalate"（guts 不动）。

**请你定**：① R1 还是别的切法？ ② 冲突选项从 5 个收敛成 `keepMine/takeCloud/cancel` 3 个——`rename`/`branch` 那两个语义是丢掉还是并进某个选项？ ③ 旧的 `open/refresh/acquire/saveAs` 这些 work-file 专用流，JRP 几乎用不到（PDF 写一次），新 `file` 对象要暴露到什么粒度？
