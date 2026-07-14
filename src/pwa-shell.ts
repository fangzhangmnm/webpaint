// 职责（单一）：PWA 外壳生命周期——service-worker 注册、新版本更新 toast、dev-route 红 chip。
// 四条更新检测路径（waiting / updatefound / asset-updated message / 回前台 poke）。
// app 注入 onBeforeReload（reload 前 apply+save）+ onForeground（ADR-0017 闲置锁屏检查）+ DOM。
//
// **离线策略 owner（app 侧）**：这里在 prod 和 dev 两处都注册 `./service-worker.js`（只跳 localhost：dev server 无 SW 文件）。
//   worker 侧策略在 service-worker.js 里按自己的 scope 分流：prod=cache-first、dev=network-first。
//   为何 dev 也要 SW：早先 deploy 删掉 /dev/ 的 SW、这里又跳过 dev 注册 → /dev/ PWA 零离线 → 闪退后离线打不开
//   （"encountered a problem"）。dev 用 network-first：在线永远先抓网（"改完即见"/强制更新不变），离线才回退缓存。
//   完整设计 + 这个坑见 docs/20260630-pwa-offline-dev-sw.md。

export interface PwaShellDeps {
  toast: HTMLElement;
  reloadBtn: HTMLElement;
  dismissBtn: HTMLElement;
  envChip: HTMLElement | null;
  onBeforeReload: () => Promise<void>;
  onForeground: () => void;
}

export class PwaShell {
  d: PwaShellDeps;
  reg: ServiceWorkerRegistration | null = null;
  dismissed = false;
  constructor(d: PwaShellDeps) { this.d = d; }

  show() { if (!this.dismissed) this.d.toast.classList.remove("hidden"); }

  init() {
    const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
    const IS_DEV_ROUTE = location.pathname.includes("/dev/")
      || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (this.d.envChip && IS_DEV_ROUTE) this.d.envChip.classList.remove("hidden");

    this.d.reloadBtn.addEventListener("click", async () => {
      await this.d.onBeforeReload();
      // skip-waiting 推给 WAITING SW（不是 controller），听 controllerchange 再 reload。
      const reg = this.reg || await navigator.serviceWorker?.getRegistration();
      if (!reg || !reg.waiting) { location.reload(); return; }
      let reloaded = false;
      const doReload = () => { if (reloaded) return; reloaded = true; location.reload(); };
      navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
      reg.waiting.postMessage({ type: "skip-waiting" });
      setTimeout(doReload, 5000);   // 兜底
    });
    this.d.dismissBtn.addEventListener("click", () => { this.dismissed = true; this.d.toast.classList.add("hidden"); });

    // ---- 前台钩子：**无条件挂**（v409 修）----
    // onForeground 是**业务**（app 拿它拉 4 个 settings/state collection + 查文件新鲜度）；SW 的 update poke
    //   是外壳自己的事。两者只是碰巧同一时机，不该同生共死。
    // v406-v408 这两个监听器挂在 `serviceWorker.register().then()` 里、且整块被 LOCAL_DEV_HOSTS 守卫包住 →
    //   localhost 开发 / SW register reject（隐私窗口、SW 被禁、SW 404）/ 无 serviceWorker 的环境下，
    //   **前台永不触发 onForeground**：设置跨设备同步静默消失，无任何报错。prod 能注册所以没暴露。
    //   → 「设置同步」不该寄生在「SW 注册成功」的路径上。
    const onFg = () => {
      this.reg?.update().catch(() => {});   // SW 有才 poke（没有也不影响下面这行）
      this.d.onForeground();
    };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") onFg(); });
    window.addEventListener("focus", onFg);

    // 注册 SW：prod 和 dev(/dev/)都装（worker 按 scope 分 cache-first / network-first）；只跳 localhost（dev server 无 SW 文件）。
    if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
      navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => { if (e.data?.type === "asset-updated") this.show(); });
      navigator.serviceWorker.register("./service-worker.js").then((registration) => {
        this.reg = registration;
        if (registration.waiting && navigator.serviceWorker.controller) this.show();
        registration.addEventListener("updatefound", () => {
          const nw = registration.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) this.show();
          });
        });
        setInterval(() => { registration.update().catch(() => {}); }, 10 * 60 * 1000);
      }).catch((err) => console.warn("SW register failed", err));
    }
  }
}
