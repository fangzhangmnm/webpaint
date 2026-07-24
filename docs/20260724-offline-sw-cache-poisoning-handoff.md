# Handoff：PWA 离线可用又坏了 — SW 缓存中毒病根诊断（#38/#64）

> as-of v0.4.11 / 2026-07-24（0.5 R1 planning 阶段只读核查得出；修复归 R2 store/平台线）
> ⚠ SW 属硬规则区（上级 CLAUDE.md #1）：动 `service-worker.js` 前读 MyPWAPatterns `docs/MASTER.md` §A + escalate human。

## 用户原话（出处：`journal/20260723 v0.5 batch requests.md` 第 64 行）

> high: pwa离线可用好像又坏掉了?update:测试之后发现：关wifi可用，但是几天没联网的旧设备放久了说没法访问url。不过也可能旧设备上是旧的没有做好离线可用的版本？或者partial network导致拿了更新token网抖了一下？还是pwa缓存还是有过期时间的？

症状拆解：**关 wifi 立刻用 = 好的**；**放几天偶尔弱联网的旧设备 = 打不开 url**。这个差别正是诊断的钥匙——纯离线路径没坏，坏在「联网一下再离线」之后。

## SW 现状（v0.4.11，`service-worker.js`，根目录、无构建生成）

- precache 静态表硬编码（`:12-24`）；bundle **不在表里**——install 时 `getCurrentBundleUrl()`（`:34-45`）fetch `./index.html` 用正则抠出当前 content-hash bundle 再一起 precache（`:55`）。cache name = `webpaint-<bundleHash>`（`:52-53`）。
- fetch 按 scope 分流（`:84-92`，`SCOPE_IS_DEV` @ `:32`）：
  - **prod（/）→ cacheFirst**（`:95-114`）：命中即返，后台 revalidate，ETag/length 变了发 `asset-updated` toast 并 `cache.put` 刷新。
  - **dev（/dev/）→ networkFirst**（`:135-150`）：60s 超时 fallback（`NETWORK_FIRST_TIMEOUT_MS` @ `:133`，v417 加、v421 从 6s 放宽到 60s）。
  - navigation 离线未命中 → 回退缓存 `./index.html`，否则 503（`:153-159`）。
- install 结尾无条件 `skipWaiting()`（`:61`）；activate `clients.claim()` + **删光所有旧 `webpaint-*` cache**（`:65-73`）。
- MSAL/auth 不阻塞离线 boot（`initAuth` fire-and-forget，`src/app.ts:410-418`）——「拿 token 网抖」不是壳打不开的原因；壳没起来是 index/bundle 层的事。

## 病根假设（按可能性排序）

### H1（最可能）：cacheFirst 后台 revalidate 毒化 —— index 与 bundle 错配

`cacheFirst` 对**任何** ok 响应都 `cache.put`（`:106`；networkFirst 同病 `:143`）。旧设备短暂/弱联网 → 后台 revalidate 抓到**新 index.html**（引新 hash bundle B）覆盖缓存；但 **bundle B 不会被主动抓**（只有页面请求它才进 fetch handler，而本次页面是旧 bundle A 跑的）。发版 ritual 又会**清掉服务器上的旧 hash bundle**（CLAUDE.md 发版 step 3）。结果：缓存里 index=B、bundle 只有 A → 再离线打开 → 请求 B 未命中 → 非 navigation → 503 白屏。

**一次弱联网即可中毒**，完全匹配「放几天说打不开」。这不是过期时间——Cache Storage 没有 TTL——是**成对资源被拆开更新**。

变体：captive portal 返回 200 的门户 HTML 同样会被 `:106/:143` 写进缓存当资源，同类毒化。

### H2：install 逐条吞错 → 半更新 cache 上位

install 的 precache 每个 URL 单独 `.catch` 吞掉失败（`:56-60`）→ 弱网中断照样 install 成功 → `skipWaiting` → activate **不校验新 cache 装全没装全**就删光旧 cache（`:65-73`）。新 cache 只有 index 没 bundle，旧的好 cache 已没了。症状同 H1。

### H3（仅 dev 渠道旧设备）：卡在 v365..v416 的无超时 networkFirst

60s 超时是 v417 才加的；partial network（半开 TCP/蜂窝切换/portal）下 `fetch` 永挂，catch 里的离线回退永远到不了。老设备**更新 SW 本身也要网络**，可能长期卡在旧 SW 上。`git diff prod main -- service-worker.js` 显示 **prod 分支的 networkFirst 至今没有超时**（prod 部署走 cacheFirst 所以该分支代码不执行，但如果哪天 prod 换策略会踩）。

## R2 修复 spec 必须覆盖的方向

1. **install 原子性**：precache 有任何一条失败（尤其 bundle）→ install 整体 fail，不 `skipWaiting`；旧 SW/旧 cache 继续服务。
2. **revalidate 成对性**：后台 revalidate 发现 index.html 变了 → **先抓齐它引用的新 bundle（含 .map）再一起 put**；抓不齐就整组放弃，保持旧的一致快照。等价说法：把「index + 它引的 hash bundle」当一个原子版本单元，永不允许缓存里出现跨版本混搭。
3. **activate 校验后再删**：删旧 `webpaint-*` cache 前验证新 cache 完整（index 里的 hash bundle 真的在），否则保留旧 cache。
4. **非 HTML 响应护栏**：`cache.put` 前校验 content-type（防 captive portal HTML 毒化 bundle/资源位）。
5. prod 分支 networkFirst 补超时（低优先，当前不执行，防将来换策略踩雷）。

## 验证方法（真机）

- 中毒态取证：iPad DevTools → Application → Cache Storage → `webpaint-<hash>`，比对缓存 index.html 里引用的 `dist/*.mjs` hash 与缓存里实际存在的 bundle 是否错配；离线 reload 看 Network 里 bundle 是否 503。
- 复现 H1：设备 A 停在旧版 → 服务器发新版（旧 bundle 被清）→ A 短暂联网让 revalidate 跑一轮 → 断网重开 app。
- 复现 H2：弱网（DevTools throttle 或真弱网）下触发 SW 更新，中途断网，再离线打开。
- 注意错误多被降级为 `"log"` 档（仅 console，`src/pwa-shell.ts:82`、`app.ts:417`），banner 不会报——要连线看 console。

## 关联

- 家族层面：sw-kit 抽取 parked；本修复落地后应把「原子版本单元」模式回流 MyPWAPatterns（兄弟 app 同款 SW 同款病）。
- 症状邻居：`journal/20260723 v0.5 batch requests.md` #38（系统性检查断网离线可用）与本条同源，R2 一份 spec 一起解。
