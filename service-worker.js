// SW v121 重写：bundle 后整个站只剩 1 个 hash-named bundle，缓存失效**自动**
// 通过文件名差异解决。manifest hash / import URL rewrite / version.js 合成 这些老花招全删。
//
// 设计：
//   - install：fetch index.html → 抠出当前 bundle 文件名 → precache 入口 + bundle + statics
//   - cache name = "webpaint-<bundleHash>"。新 bundle = 新 cache name；activate 时清老的。
//   - fetch：cache-first + 后台 revalidate；ETag 变了通知 page。
//
// 跟 sibling family 抄：基本可以 1:1 拷，改 STATIC_PRECACHE 列表就行。
// 论证见 docs/20260529-why-content-hash-bundle.md。

const STATIC_PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon-180.png",
  "./styles.css",
  "./default-brushes.json",   // v122 r2: 改 runtime fetch，必须 precache 保证离线
  "./vendor/zip-js/zip-full.min.js",
  // msal / 其它惰性加载的库 SW 不预缓存。用到才下，那时候 fetch 会自动 cache。
];

let CACHE_NAME = "webpaint-boot";   // install 时会被替换为 webpaint-<bundleHash>

// 同一个 SW 文件部署到 /(prod) 和 /dev/ 两处；按**自己的作用域**选策略（owner: docs + src/pwa-shell.ts）：
//   - prod(scope=/)      → cache-first：秒开 + 离线稳，更新靠 asset-updated toast。
//   - dev(scope 含 /dev/) → network-first：在线永远先抓网（「改完即见」/强制更新不变），离线才回退缓存
//     （崩溃后能离线重开——修「/dev/ 按设计无 SW → 闪退离线打不开」的坑，见 docs/20260630-pwa-offline-dev-sw.md）。
const SCOPE_IS_DEV = self.location.pathname.includes("/dev/");

async function getCurrentBundleUrl() {
  const res = await fetch("./index.html", { cache: "no-store" });
  if (!res.ok) throw new Error("install: index.html fetch failed " + res.status);
  const html = await res.text();
  // <script type="module" src="./dist/webpaint-<hash>.mjs"></script>
  // v124 起 bundle 名从 main- 改成 webpaint-；SW 这条 regex 当时漏改 → install 抛错 →
  // 新 SW 永远装不上，老 SW 继续 cache-first 服旧 bundle/默认笔架 → 提交了也「没同步」。
  // 兼容 main-（旧）+ webpaint-（现）两种名，避免再被改名咬到。
  const m = html.match(/src="(\.\/dist\/(?:main|webpaint)-[a-z0-9-]+\.mjs)"/i);
  if (!m) throw new Error("install: 找不到 ./dist/(main|webpaint)-*.mjs 入口 in index.html");
  return { html, bundleUrl: m[1] };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const { bundleUrl } = await getCurrentBundleUrl();
    // 必须跟 line 36 入口 regex 同步认 main-（旧）+ webpaint-（现）两种名 —— 否则抽不出 hash
    // → fallback "boot" → CACHE_NAME 恒为 webpaint-boot → cache 永不随 build 失效（离线/更新坏）
    const bundleHash = bundleUrl.match(/(?:main|webpaint)-([a-z0-9-]+)\.mjs/i)?.[1] || "boot";
    CACHE_NAME = `webpaint-${bundleHash}`;
    const cache = await caches.open(CACHE_NAME);
    const urls = [...STATIC_PRECACHE, bundleUrl, bundleUrl + ".map"];
    await Promise.all(urls.map((u) =>
      fetch(u, { cache: "no-store" })
        .then((r) => r.ok ? cache.put(u, r) : null)
        .catch((err) => console.warn("[SW] precache miss", u, err.message))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("webpaint-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

let updateAnnounced = false;
async function notifyUpdate(url) {
  if (updateAnnounced) return;
  updateAnnounced = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: "asset-updated", url });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // prod 根 SW(scope=/)不碰 /dev/——留给 /dev/ 作用域的 dev SW 自己处理（dev SW 的 scope 已限在 /dev/，故只 prod 需此跳）。
  if (!SCOPE_IS_DEV && url.pathname.includes("/dev/")) return;
  event.respondWith(SCOPE_IS_DEV ? networkFirst(req) : cacheFirst(req));
});

// prod：cache-first + 后台 revalidate（ETag/长度变 → 通知 page 弹更新 toast）。
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });
  const networkPromise = fetch(req).then((resp) => {
    if (resp && resp.ok) {
      if (cached) {
        const cE = cached.headers.get("etag"), fE = resp.headers.get("etag");
        const cL = cached.headers.get("content-length"), fL = resp.headers.get("content-length");
        const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
        if (changed) notifyUpdate(req.url).catch(() => {});
      }
      cache.put(req, resp.clone()).catch(() => {});   // hash-named bundle 内容不变；其它文件更新则刷一次
    }
    return resp;
  }).catch(() => null);
  if (cached) { networkPromise.catch(() => {}); return cached; }
  const resp = await networkPromise;
  if (resp) return resp;
  return navFallback(req, cache);
}

// dev：network-first——在线永远拿最新（「改完即见」/强制更新不变），离线才回退缓存（崩溃后能离线重开）。
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});   // 顺手刷缓存，供下次离线回退
    return resp;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return navFallback(req, cache);
  }
}

// 导航请求离线且未命中 → 回退缓存的 index.html（PWA 壳）；否则 503。
async function navFallback(req, cache) {
  if (req.mode === "navigate") {
    const fallback = await cache.match("./index.html");
    if (fallback) return fallback;
  }
  return new Response("offline & not cached", { status: 503 });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
