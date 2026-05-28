# WebPaint Sync 设计

> 同事接手版。v77 起的设计；之前 v66 docs/persistence-and-encryption-shareback.md
> 是 push/pull 协议层细节，本文是**用户决策流**。

## 出发点

WebPaint 是**离线优先**的 PWA + 可选 OneDrive 同步。两条强约束：

1. **离线第一公民** —— 没网 / 没登录也得完全可用，不能阻断打开 / 编辑 / 保存（IDB）
2. **不偷动数据** —— 任何「覆盖本地」/「覆盖云端」决定必须 user 显式 consent

加上业界经典坑：cache invalidation 半自动化最容易出事。所以我们**没有 auto-pull**。
有的是：**强提示 + 用户选 + 副本保底**。

## ETag 局限 —— 为什么不光靠它

ETag 防得住「两台并发推」（412 阻止盲覆盖），**防不住**「旧客户端覆盖新客户端」
和「fork-vs-trunk」。详见 conversation v71→v72。我们补的就是 ETag 防不住那块。

## 决策矩阵 —— 打开 doc 时

| 上次 session | 这次 onLine | token 有效 | 行为 |
|---|---|---|---|
| 没登录 / 未配置 | (n/a) | (n/a) | **不卡** 直接本地 |
| 登录过 | false | (n/a) | **锁屏** + 弹「离线 / 稍后再试」 |
| 登录过 | true | false (silent acquire 失败) | **锁屏** + 弹「重登 / 离线」 |
| 登录过 | true | true | **锁屏 + 转圈** 拉云端 etag；user 随时可点「跳过到离线」 |

**关键不变量**：「离线」选择**不**修改 `lastSessionSignedIn` flag。意图保留 →
下次进还会问。只有显式登录 / 登出才动这 flag。

## 拉 etag 后

```
local etag === cloud etag        → 静默，正常用本地
local etag !== cloud etag        → 锁屏 + 弹三选：
                                     1. 拉云端覆盖本地（先备份本地）  ← primary
                                     2. 保留本地（之后 push 会冲突）
                                     3. 云端开为副本（都留）
fetch error / 超时               → fallback「连不上云，用本地」status
```

「拉」选项会先把本地另存为 `{name}-backup-{ts}` 防误操作。

## In-doc 安全网

**1. 手动 Ctrl+S push 出 412**：
```
锁屏 + 弹三选：
  1. 拉云端覆盖本地（备份本地）          ← primary
  2. 保留本地另存为「{name} (新)」
  3. 都留（云端开为副本）
```

**2. token 中途过期（401）**：onLine 仍 true 但 graph 调用 401 → 锁屏「重登 / 离线」。
*(v77 还没全 hook，需要 graph.js 把 401 抛上来)*

**3. 后台 update 检测云端比本地新 + 本地 clean**：
*(预留，v77 未实现；规划：每 10 min poll，等同 PWA SW 那条路径)*

## 锁屏的 UX 细则

- backdrop z-index 100，sheet 101
- spinner（小 ring，0.8s 转一圈）
- 同时给「跳过到离线」按钮 immediate 可点（不强制等满）
- 无硬 5s timeout；let it fly。超过 5s **没**自动 fall back—— user 显式选

## API

```js
// cloud.js
getLastSessionSignedIn(): boolean         // localStorage flag
setLastSessionSignedIn(v: boolean): void  // 仅 signIn / signOut / silent-success 调
fetchSessionMetadata(name): Promise<{ etag, lastModified, size, item }>

// app.js（私有，inline）
gateCloudSyncOnOpen(sessionName: string): Promise<void>   // 打开 doc 后调
lockSyncGate({ title, message, showSpinner, actions }): Promise<value>
```

## 没做的（未来再说）

- **3-way merge / OT / CRDT**：像素数据不像字符有 op 序，业界 paint 没人做
- **后台 idle poll**：每 N 秒查 etag 弹横幅；现在只在 open 时查
- **lock 文件**：server-side 独占编辑，需服务器配合（OneDrive 不支持）
- **历史版本时间轴 UI**：OneDrive 服务端有 version 但我们没暴露

## 为啥不做 auto-pull

参 conversation v76→v77 的论证。简言：方案 3（last-write-wins + history）里
auto-pull 等于客户端替用户决定 trunk，用户没法回滚——比 ETag 不够更糟。

## 对照行业其他做法

| 方案 | 离线 | 状态突变 | 冲突 |
|---|---|---|---|
| Google Docs / Figma (CRDT) | OK | 平滑 op | 自动 merge |
| Word (lock 文件) | 不能编辑 | n/a | 不会 |
| Dropbox file sync | OK | 突变 | `Document (Conflict).docx` |
| iWork pull-on-open | 受限 | n/a | 不会 |
| **WebPaint v77** | **OK** | **user 选** | **user 选 + 副本保底** |

## 调试

localStorage keys：
- `webpaint.lastSessionSignedIn` = "1" / "0"
- `webpaint.etag:{name}` = OneDrive etag
- `webpaint.cloudDirty:{name}` = "1" / "0"

清掉这些 = 重置成「未登录 / 没缓存 / 没同步过」状态。
