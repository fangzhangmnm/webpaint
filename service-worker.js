// SW: cache-first + 后台 revalidate + 改了通知页面（toast）。
// v15 起：在响应 .js 时改写 import URL 加 ?v=VERSION，绕开 iPad Safari
// WKWebView 的 bytecode cache（按 URL 索引，URL 没变就用旧 bytecode）。
// 同时 version.js 由 SW 动态返回当前 CACHE_VERSION，保证 page 端拿到的
// 版本永远和 SW 自己的一致。

importScripts("./src/version.js");
const CACHE_VERSION = self.WEBPAINT_VERSION;
const CACHE_NAME = `webpaint-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./apple-touch-icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./src/styles.css",
  "./src/version.js",
  "./src/app.js",
  "./src/doc.js",
  "./src/board.js",
  "./src/input.js",
  "./src/brush.js",
  "./src/brushes.js",
  "./src/default-brushes.json",
  "./src/panel-state.js",
  "./src/palette.js",
  "./src/history.js",
  "./src/liquify.js",
  "./src/lasso.js",
  "./src/reference.js",
  "./src/psd.js",
  "./src/history.js",
  "./src/storage.js",
  "./src/zip.js",
  "./src/ora.js",
  "./src/session.js",
  "./src/config.js",
  "./src/auth.js",
  "./src/graph.js",
  "./src/cloud.js",
  "./src/vendor/zip-js/zip-full.min.js",
  "./src/vendor/msal/msal-browser.min.js",
];

// 哪些响应需要做 import URL 改写
function isJSModule(url) {
  return url.pathname.endsWith(".js")
    && url.pathname.includes("/src/")
    && !url.pathname.endsWith("/version.js");
}

// 把源码里 `from "./xxx.js"` 和 `import("./xxx.js")` 改成 `?v=VERSION`
// 保留可能已有的 query（无 query 就加）。bump 时整套 module URL 都换 →
// JS engine 把它当全新模块编译 → bytecode cache 必失效。
function rewriteImports(text) {
  const v = `?v=${CACHE_VERSION}`;
  return text
    .replace(/(\bfrom\s+)(["'])(\.[^"'?]+\.js)(["'])/g, `$1$2$3${v}$4`)
    .replace(/(\bimport\s*\(\s*)(["'])(\.[^"'?]+\.js)(["'])/g, `$1$2$3${v}$4`);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE_URLS.map((u) =>
      cache.add(u).catch((err) => console.warn("precache miss", u, err))
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

  event.respondWith((async () => {
    // version.js：SW 直接合成响应，永远是当前 SW 自己的 CACHE_VERSION。
    // 这样 page 端 import 进 window.WEBPAINT_VERSION 之后立即就是新版本，
    // 后面的 `?v=${WEBPAINT_VERSION}` 才不会用旧值。
    if (url.pathname.endsWith("/src/version.js")) {
      return new Response(
        `self.WEBPAINT_VERSION = "${CACHE_VERSION}";\n`,
        { headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-store",
          } }
      );
    }

    const cache = await caches.open(CACHE_NAME);
    // ignoreSearch：缓存按裸 URL 存；带 ?v=N 的请求也能命中
    const cached = await cache.match(req, { ignoreSearch: true });
    // 拿网络版本时去掉 query，cache 也按裸 URL put
    const bareReq = new Request(url.origin + url.pathname);

    const network = fetch(bareReq).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(bareReq, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    async function maybeRewrite(resp) {
      if (!resp || !isJSModule(url)) return resp;
      const text = await resp.text();
      const rewritten = rewriteImports(text);
      return new Response(rewritten, {
        status: resp.status,
        headers: { "Content-Type": "application/javascript" },
      });
    }

    if (cached) {
      network.catch(() => {});
      return await maybeRewrite(cached.clone());
    }
    const resp = await network;
    if (resp) return await maybeRewrite(resp.clone());
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
