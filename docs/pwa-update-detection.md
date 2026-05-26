# PWA 更新检测：四条路径要全挂

> 给兄弟项目和未来的 AI：这套**直接拷过去能用**。WebPaint 第一版只挂了第三条，user 反馈"PWA 更新不太主动"。补齐 4 条后稳了。WebXiaoHeiWu 是最早的范式，下面把它整理成可复用的模式。

## TL;DR

两件配套，**都是必需，不是可选**：

1. **挂全 4 条 update 检测路径**，否则 iPad PWA standalone 默认极不主动 check SW，user 看不到"有新版本"toast。
2. **屏幕上常驻显示版本号**，否则 user 点了"刷新"也不知道有没有真的换上新版本 —— 信任的反馈回路是断的。

少挂任何一条 update 路径，或者没有屏幕水印，都会产生"我推了新版本但 user 不知道有没有装上"的报告。

## 四条路径

```
                 +-----------------------+
   bump version → ETag/byte 变 ────────→│ 浏览器 fetch 新 SW    │
                 +-----------┬-----------+
                             |
              registration.update() (路径 4)
                             |
              install → precache → skipWaiting
                             |
              state: installed (路径 2) ──→ showUpdate()
                             |
              activate → clients.claim
                             |
              asset-updated postMessage (路径 3) ──→ showUpdate()

  开机时:   registration.waiting (路径 1) ──→ showUpdate()
```

### 1. `registration.waiting` 在 register 完检查

**抓什么**：上一次 session 已经把新 SW 装好但还没 activate 的，开机立即 toast。

**为什么需要**：用户上次开 app 时新 SW 装到 waiting 状态，但 user 退出 app 没刷新。再开 app 时 controller 还是旧的，新的躺在 `waiting`。要主动检查这种状态。

### 2. `updatefound` + `statechange === "installed"`

**抓什么**：本次 session 里浏览器 check 到 SW 有新版本、装完了的瞬间。

**关键判断**：`navigator.serviceWorker.controller` 必须存在（= 旧 SW 还在控制本页面）。如果 controller 是 null，说明这是首次安装，不该弹 update toast。

### 3. SW `postMessage({ type: "asset-updated" })`

**抓什么**：任意一个 precached asset 在背景 revalidate 时 ETag 变了。

**关键设计**：SW 的 fetch handler 必须做 cache-first + background revalidate：先返 cached，并发 fetch 网络版，**网络版 ETag 不同就 postMessage 给所有 clients**。`updateAnnouncedThisLoad` flag 防止同一 SW 生命周期里多次广播。

这一条**比版本检测更敏感** —— 你忘了 bump version 但某个 asset 字节级变了也能抓到。

### 4. `visibilitychange` / `focus` / interval → `registration.update()`

**抓什么**：让浏览器**主动**去 check SW 有没有新版本。

**为什么是关键**：iPad PWA standalone 模式下浏览器**默认不会勤快地 check SW**。没有这条，前面三条都得等浏览器自己想起来去 check。**这一条是 iOS PWA 不主动的死穴的解药。**

实现：
- `document.visibilitychange` (visible) → update()
- `window.focus` → update()
- `setInterval(update, 10*60*1000)` 兜底，PWA 长期在前台跑也每 10 分钟 check 一次

## 完整代码（粘贴可用）

### service-worker.js

```js
const CACHE_VERSION = "v1-2026-05-25";   // 改了任何 precached asset 就 bump
const CACHE_NAME = `myapp-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./", "./index.html", "./manifest.webmanifest",
  // ...所有 vendor / src / icon
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("myapp-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// 这是路径 3 的核心：cache-first + background revalidate + ETag 比对
let updateAnnouncedThisLoad = false;
async function notifyUpdate(url) {
  if (updateAnnouncedThisLoad) return;
  updateAnnouncedThisLoad = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: "asset-updated", url });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const network = fetch(req).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) ||
                          (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    if (cached) {
      network.catch(() => {});
      return cached;
    }
    const resp = await network;
    if (resp) return resp;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});

// page 点"刷新" → 推 SW 立刻 activate
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
```

### app.js 里的 SW 注册 + 4 条检测

```js
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
let updateDismissed = false;

function showUpdate() {
  if (updateDismissed) return;
  document.getElementById("updateToast").classList.remove("hidden");
}

document.getElementById("updateReloadButton").addEventListener("click", () => {
  navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
  location.reload();
});
document.getElementById("updateDismissButton").addEventListener("click", () => {
  updateDismissed = true;
  document.getElementById("updateToast").classList.add("hidden");
});

if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3：SW 主动告知 asset 变了
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });

  window.addEventListener("load", async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register("./service-worker.js");
    } catch (err) {
      console.warn("SW register failed", err);
      return;
    }

    // 路径 1：开机检查有没有 waiting 的新 SW
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdate();
    }

    // 路径 2：本 session 内装到了新 SW
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdate();
        }
      });
    });

    // 路径 4：主动 poke 浏览器 check SW —— 关键的"反 iOS 不主动"措施
    const pokeUpdate = () => { registration.update().catch(() => {}); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pokeUpdate();
    });
    window.addEventListener("focus", pokeUpdate);
    setInterval(pokeUpdate, 10 * 60 * 1000);
  });
}
```

### index.html 里的 toast（CSS 不放在这）

```html
<div id="updateToast" class="toast hidden" role="status" aria-live="polite">
  <span>有新版本</span>
  <button id="updateReloadButton" type="button">刷新</button>
  <button id="updateDismissButton" type="button" class="dismiss" aria-label="忽略">×</button>
</div>
```

## 屏幕上必须显示版本号（必需，非可选）

**为什么是 hard requirement**：update 检测和 reload 是两个动作，中间隔了一个 SW activate。user 点了"刷新"之后，**他没办法判断新代码是否真的跑起来了**。如果没在 UI 上显示版本号：
- bug fix 推上去 → user 收到 toast → 点刷新 → 看上去一样 → "你这版本根本没生效" 报告
- 实际可能是：网络抖动 + SW activate 失败、precache 某个 asset 404、cache 没换、user 手动刷了页但 SW 没换……
- 没有 visual confirmation 你根本不知道是什么环节出了问题

WebPaint v5 起的做法：**HUD 角落常驻版本号水印**，user 一眼就知道当前装的是哪版。bump 一次发现水印没变 = update 没真装上 = 立刻去查。

### 实现：单 SSoT 版本号（顺手做）

版本号写在 `src/version.js` 这个 classic script 里，SW 用 `importScripts("./src/version.js")` 拿，index.html 一个 `<script>` 也加载它给 `window.WEBPAINT_VERSION`。app.js 把版本打到 HUD 角落。Bump 一处，两边自动同步、永不漂移。

```js
// src/version.js
self.WEBPAINT_VERSION = "v7-2026-05-25";
```

```html
<script src="./src/version.js"></script>  <!-- 早于 app.js -->
```

```js
// service-worker.js 顶部
importScripts("./src/version.js");
const CACHE_VERSION = self.WEBPAINT_VERSION;
```

```js
// app.js —— 启动时打到 HUD
els.versionLabel.textContent = window.WEBPAINT_VERSION || "v?";
```

```html
<!-- index.html，已有的 HUD 区域加一项 -->
<div class="hud">
  <span id="zoomLabel">100%</span>
  <span class="sep">·</span>
  <span id="statusLabel">就绪</span>
  <span class="sep">·</span>
  <span id="versionLabel" class="version">v?</span>
</div>
```

```css
/* styles.css —— 版本号低调一点 */
.hud .version {
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
```

放哪不重要 —— HUD / 设置面板 / 关于页都行 —— **关键是 user 不用任何操作就能瞄一眼读到当前装的是哪版**。藏在三层菜单里的不算。

## 关键的 anti-pattern（别犯）

- **❌ 只挂路径 3** —— iPad 上 90% 的情况下不会 fire，因为 SW 都没 check 更新
- **❌ 不显示版本号** —— user 点了刷新之后没有 visual confirmation，每次 update 都是盲信。bug 报告会变成"你这版本根本没生效"无法定位
- **❌ 自动 reload** —— user 可能正在写字 / 画画。绝不自动刷。toast + 用户点
- **❌ 同 session 内反复弹 toast** —— 用 `updateAnnouncedThisLoad` (SW 端) + `updateDismissed` (page 端) 各守一边
- **❌ 在 localhost 注册 SW** —— 开发时 F5 就拉不到最新代码了。`LOCAL_DEV_HOSTS` 白名单排除
- **❌ `clients.claim()` 不调** —— 不调的话新 SW activate 后老 tab 还是旧 SW 控制，下次 reload 才换。一般要调
- **❌ 忘 bump version 又改了文件** —— 路径 3 的 ETag 检测会救你，但 cache 名没换 → 下次 reload 还是旧 cache。**bump 才是真正解**

## 兄弟项目实现对照

| 项目 | SW 文件 | app 端注册位置 | 备注 |
| - | - | - | - |
| WebXiaoHeiWu | `service-worker.js` | `src/app.js` 末尾 | 最早的范式，本文蓝本 |
| RealHome | `service-worker.js` | `src/app.js` | 同模式 |
| ScratchPad | `service-worker.js` | `src/app.js` | 同模式但当时**只挂了路径 3**，后期需要补 |
| WebPaint | `service-worker.js` + `src/version.js` | `src/app.js` | 四条全挂；额外把版本号 SSoT 拎到 `src/version.js` |

如果你的项目还在"少挂路径"的状态，把本文 app.js 那段直接拷贝，调下 toast element id 即可。
