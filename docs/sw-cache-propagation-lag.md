# 已知问题：版本号对了，行为还是旧的（GitHub Pages 传播 + SW 预缓存竞态）

## 症状
推完 v119 之后强刷，顶栏版本号显示 v119（对），但 transform 行为还是 v118 老的
（uniform 角拖 anchor 跟着歪）。**过几分钟自动好。** 不报错。

## 根因
GitHub Pages 是 multi-PoP CDN，push 完到全网 PoP 收齐新文件大约 1–5 分钟。
我们的 SW (`service-worker.js`) 是 cache-first + 后台 revalidate + skipWaiting，
install 时一次性 `cache.add` 全套 PRECACHE_URLS。

竞态：
1. push v119，commit hash 写入 `version.js`
2. 用户访问，浏览器拉新 service-worker.js（带 v119 字串）→ 开 install
3. install 触发 PRECACHE_URLS 全量 `cache.add`，**逐个发 fetch**
4. 此时 GitHub Pages 不同 PoP 收 v119 文件的进度不一致：
   - `version.js`、`index.html` 已是 v119（早传播到 / 浏览器命中的 PoP）
   - `lasso.js`、`app.js` 等 .js 还可能是 v118（命中的 PoP 还没拿到）
5. SW 把 v119 的 `version.js` + v118 的 `lasso.js` 一起塞进 `webpaint-v119` cache
6. activate → 接管。后续请求 `cache.match` 直接返回这堆**版本混搭的**文件
7. 顶栏读 `version.js` 显示 v119 ✓，但 `lasso.js` 还是老逻辑 ✗

后台 revalidate 也帮不大忙：cache-first 总是先返 cached，network fetch 完了
比较 etag、发现变了发 `asset-updated` 通知页面 → 页面弹 toast，但**该 import 调用已经执行完了**，
要等下次模块重新 import / 刷页才生效。

## 为什么版本检查没报错
版本号是 SW 自己合成的：
```js
if (url.pathname.endsWith("/src/version.js")) {
  return new Response(`self.WEBPAINT_VERSION = "${CACHE_VERSION}";\n`, ...);
}
```
SW 自己升到 v119 → CACHE_VERSION = "v119" → 给页面的 version.js 永远显示 v119。
跟 cache 里 `.js` 文件实际内容版本对不对**没关系**。

## 缓解
- **简单**：deploy 后等 2–3 分钟再让 user 测；推完 commit 不当场报"已发布"。
- **更稳**（v121 候选）：install 时给每个 PRECACHE_URLS 的 fetch 带 `?v=${CACHE_VERSION}` query
  + Pages 对未知 query 不回 304，强保拿全网最新。前提是 Pages 的 PoP 已经同步 ─ 没同步则照样拿到老的，
  这条不解决根因，只是少一次"cache 里塞混搭"的窗口。
- **更彻底**：SW 收 install 时先 fetch `index.html` 拿到一个 manifest（含每个文件的预期 hash），
  再 fetch 各文件并校验 hash；不一致则**重试**或**拒绝 activate**（user 看到上次的 v118 → 安全降级，
  比看到混搭强）。工程量较大，暂存 backlog。

## 用户视角的"过一会就好了"
SW 后台 revalidate 把混搭 cache 修对的速度，加上下次 SW 检查更新（默认 24h，
但每次 navigation 都会触发 `/service-worker.js` 的 304 检查 → 收到新内容会再走 install 一次，
此时 PoP 已经同步 → 这次拿全是 v119）。所以"再过一会就好了"≈ 用户再访问一次时 install 重跑碰上 PoP 已经同步。
