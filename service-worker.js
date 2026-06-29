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
  // v121 dev/ 入口走纯 HTTP（不进 SW cache 层），让 dev 改完即见
  if (url.pathname.includes("/dev/")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });

    const networkPromise = fetch(req).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        // hash-named bundle 不可能变内容；其它文件可能更新，put 一次
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    if (cached) {
      networkPromise.catch(() => {});
      return cached;
    }
    const resp = await networkPromise;
    if (resp) return resp;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
