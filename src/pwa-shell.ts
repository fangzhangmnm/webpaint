// 职责（单一）：PWA 外壳生命周期——service-worker 注册、新版本更新 toast、dev-route 红 chip。
// 四条更新检测路径（waiting / updatefound / asset-updated message / 回前台 poke）。
// app 注入 onBeforeReload（reload 前 apply+save）+ onForeground（ADR-0017 闲置锁屏检查）+ DOM。

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

    if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname) && !IS_DEV_ROUTE) {
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
        const poke = () => { registration.update().catch(() => {}); };
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { poke(); this.d.onForeground(); } });
        window.addEventListener("focus", () => { poke(); this.d.onForeground(); });
        setInterval(poke, 10 * 60 * 1000);
      }).catch((err) => console.warn("SW register failed", err));
    }
  }
}
