# 同步身份决定 + GUID 尝试的回滚与发现（2026-06-07）

> 这轮尝试用 in-file GUID 给文档做稳定身份（修「多设备改名裂卡」C1），**真机暴露多个问题后回滚**。
> 用户定调：**store 必须文件格式无关；身份只用 path；不要任何 id↔path 注册表（那是灾难）**。
> 本文档保留这轮的发现/教训/待修，别随回滚丢。

## 终局决定

- **身份 = path/name，唯一**。云端天然给每个文件 path，零铸造、零分叉。
- **不铸 per-file id，不要 id↔path 注册表**（registry = 又一份要同步、会 desync、provider 特定的状态 → 灾难）。
- **Store 文件格式无关**：opaque bytes by path + 同步机制(push/pull/etag/If-Match/.trash/serialize/parentBase) + 云 metadata `{path, etag, size}` + 一个原语 **`getTailBytes(item, n)`**。**不解析文件、不懂 thumb/guid**（mp3/txt/pdf 兄弟也要用）。
- **thumb 提取留 app**（WebPaint 用 `getTailBytes` 从 .ora 尾自取，cloud-thumbs 现状）。
- **接受 E（多设备改名裂卡）不修**：数据不丢、re-sync 归一，是 UX 疣不是数据红线。修它的代价(registry)不值。

## 为什么 in-file GUID 炸了（核心教训，别再走）

- **自铸 id 竞态（根因）**：legacy 文件无内嵌 id → 每台设备开它各自 `crypto.randomUUID()` → **同一文件两个 id** → reconcile 判异身份 → 裂卡 + 收敛 side-effect 制造 0B。要不分叉就得 registry 强制收敛——而 registry 是灾难。⇒ **不铸 id**。
- **格式特定**：ADR-0011「GUID 在 byte-range thumb/header 块」假设文件是自定义容器(zip)。mp3/txt 不是 → 共享 store 不能假设。**ADR-0011 的 in-file-GUID 机制对「格式无关共享 store」over-reach**（见 MyPWAPatterns 注）。
- **慢**：把 guid 提取做成开画库时阻塞 per-item 网络抓取 → 画库变慢。**教训：画库渲染绝不阻塞在 per-item 网络。**

## 这轮发现的 Bug / 隐患（保留，标注归属）

| # | 现象 | 归属 | 回滚后 |
|---|---|---|---|
| C | 多设备改名 xxy→yyz → 另一端冒 **0B xxy**、变云端态、点开不提示冲突 | 疑 GUID 收敛 side-effect 引入 | **复验是否消失**；若仍在=预存 rename bug，要查 |
| D | **同名异内容碰撞(888)**：两设备各建同名 → 云端 path 撞 → 第二个推**裸报错**（手速快可复现） | **预存**（name-based push 撞 path） | 仍在 → 应：检测 path 已存在 → 改名消歧/优雅冲突，**待修** |
| E | 多设备改名在另一端**裂成两卡** | name 身份固有 | **接受不修**（path-only 的已知疣） |
| F | 改名后**过一会才锁屏** | 疑预存（rename 的 sync gate 时序） | 仍在 → **待查** |

## salvage（保留的好东西）

- **`getTailBytes` 原语**：store 暴露「取某 item 尾部 N 字节」，app 用它自取 thumb（及任何 app 私有尾部 meta）。cloud-thumbs 的 byte-range 就归这。**这是 store 该有的、格式无关的口。**
- gallery-model 的「撞名异身份不误配」守卫思路——回滚到 name-merge 后用不上（name 唯一键），但记着：**未来任何身份升级都要有这条完整性守卫**。

## 回滚范围（v196–198 → name-merge）

删：`src/file-envelope.js`、ora EOCD-comment 读写、`_activeDocGuid` mint、`_buildOraMeta.meta`、pkg.guid/listSessions.guid、`fetchOraGuid`/`_ensureCloudGuids`/收敛、`gallery-model` guid-merge → 回 name-merge。**保留** cloud-thumbs byte-range（thumb 照常）。`docs/file-envelope.md` 标已撤。

## 回滚后单独待办（非本次混入）

- **D**：同名异内容碰撞 → flow 层优雅处理（检测 + 改名消歧/冲突）。
- **F**：改名延迟锁屏 → 查 rename sync-gate 时序。
- **渲染线（独立）**：pixel brush 等渲染问题——单独 backlog、单独修，不与存储混。
