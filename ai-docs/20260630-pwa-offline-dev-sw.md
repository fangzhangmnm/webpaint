# PWA 离线 / dev SW 策略（坑 + 设计）

> as-of v365 / 2026-06-30。owner 模块：`src/pwa-shell.ts`（app 侧）+ `service-worker.js`（worker 侧）。
> how 类，会腐烂——动 SW/部署前以代码现状为准。

## 踩过的坑（真机：断网下闪退后再开 PWA = "encountered a problem"，要联网才恢复）

家族早先为了 dev「改完即见」，把 `/dev/` 的离线能力**整个砍掉**——三处合谋、互相耦合，散在三个文件：

1. `deploy.yml`：compose 时 `rm -f site/dev/service-worker.js`（dev 部署里**删掉 SW 文件**）。
2. `src/pwa-shell.ts`：注册条件带 `&& !IS_DEV_ROUTE`（dev 路由**跳过注册**）。
3. `service-worker.js` fetch：`if (url.pathname.includes("/dev/")) return;`（根 SW **绕过** /dev/ 请求）。

结果：`/dev/` PWA **零 SW、零缓存、零离线**。iOS 把 PWA 因内存压力杀回主屏（CTD）后，**离线重开就白屏报错**，要等联网才能拉 shell。
（注：CTD 本身更可能是显存泄露 OOM——见 v362 FBO 池修；本条只解决"崩了之后离线打不开"这个独立的韧性问题。）

prod（`/`）一直有 SW（cache-first）→ 离线正常；坑只在 dev。但全家开发都在 dev 渠道测，所以天天踩。

## 修法：dev 也装 SW，但走 network-first（不是 cache-first）

关键洞察：当初砍 dev SW 是怕 **cache-first 会 stale**（dev 要改完即见）。但 **network-first 不会 stale**——
在线永远先抓网（= 改完即见 / 强制更新原样保留），**只有离线才回退缓存**。所以 network-first 同时满足两个目标，没有取舍。

同一个 `service-worker.js` 部署到 `/` 和 `/dev/` 两处，按**自己的 scope** 分流策略：

| scope | 策略 | 在线 | 离线 |
|---|---|---|---|
| `/`（prod） | cache-first + 后台 revalidate | 秒开缓存，ETag 变弹更新 toast | 服缓存 shell |
| `/dev/`（dev） | network-first | 永远抓网（改完即见） | 回退缓存（崩溃可重开） |

- scope 检测：`SCOPE_IS_DEV = self.location.pathname.includes("/dev/")`（SW 脚本自己的 URL）。
- 根 SW（scope=`/`）仍 `return` 跳过 `/dev/` 请求 → 留给 `/dev/` 作用域的 dev SW；dev SW 的 scope 已限在 `/dev/`，故只 prod 需此跳过。
- 导航离线未命中 → 回退缓存的 `index.html`（PWA 壳）。

## 三个文件现在怎么配合（owner = pwa-shell）

- `src/pwa-shell.ts`：prod + dev 都注册 `./service-worker.js`（只跳 localhost：dev server 无 SW 文件）。app 侧生命周期 owner。
- `service-worker.js`：按 scope 选 `cacheFirst` / `networkFirst`（两个小函数 + `navFallback`）。worker 侧策略。
- `.github/workflows/deploy.yml`：**不再**删 dev SW（compose 的 for 循环已 cp 到 `site/dev/`）。

## 验证

- node mock 测：`test/sw-strategy.test.mjs`（vm 载入 SW + mock `caches`/`fetch`/`Response` → 驱动 fetch 事件）：
  prod=cache-first（离线服缓存）、dev=network-first（在线抓网 / 离线回退）、prod 跳过 /dev/、导航回退 index.html。
- 真机待验（无法静态验的部分）：iPad `/dev/` PWA 断网重开能出 shell；在线改 dev 仍即见。

## 不变量（别再退化）

- dev 的离线**不许**用 cache-first（会 stale，破"改完即见"）。要离线就 network-first。
- prod 的 cache-first 路径**别动**（秒开 + asset-updated toast 是成熟的）。本次 prod 行为逐字未变。
- 别再在 deploy 里删 dev SW、或在 pwa-shell 里跳过 dev 注册——那就是把这个坑种回来。
