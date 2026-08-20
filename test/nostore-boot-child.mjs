// nostore boot smoke **子进程**（store-absent.test.mjs spawn，env WEEBPAINT_NOSTORE=1）。
// 为什么子进程：detectStoreAbsent 在 app-store 模块 eval 期定死，同进程二次 import 换不了模式。
// 形态 = app-boot.test.mjs 的瘦身克隆：装 DOM shim → 断言缺席模式已生效 → import app.ts 整段
// boot → settle 捕逃逸抛错 → exit 0/1。父测试只看退出码 + stderr。
import { installDomShim, makeNode } from "./dom-shim.mjs";

installDomShim();
globalThis.OffscreenCanvas = class OffscreenCanvasShim {
  constructor(w, h) { this.width = w; this.height = h; this._n = makeNode("canvas"); }
  getContext(type, opts) { return this._n.getContext(type, opts); }
};
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      if (typeof data === "number") { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
      this.data = data; this.width = width; this.height = height ?? (data.length / 4 / width);
    }
  };
}

const errors = [];
process.on("unhandledRejection", (e) => errors.push(["unhandledRejection", e]));
process.on("uncaughtException", (e) => errors.push(["uncaughtException", e]));

const appStore = await import("../src/app-store.ts");
if (!appStore.storeAbsent) {
  console.error("WEEBPAINT_NOSTORE=1 没让 app-store 进缺席模式");
  process.exit(1);
}
if (appStore.isAuthConfigured() !== false || appStore.isSignedIn() !== false) {
  console.error("缺席模式 auth 未 dormant");
  process.exit(1);
}

// 主线抛错必须自己接：不 try 的话 import 拒绝会被上面的 uncaughtException 收集器拦下
// （收集器只 push 不退出），process.exit 永远走不到 → 子进程被 boot 泄漏句柄吊死、父测试
// 无限等（2026-08-10 真实咬过：shim 缺 toggleAttribute → 整个 npm test 挂死 34min+）。
try {
  await import("../src/app.ts");
} catch (e) {
  console.error("[boot-import-reject]", (e && e.stack) || e);
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 500));   // settle：boot 收尾 async IIFE / Vue flush

if (errors.length) {
  for (const [k, e] of errors) console.error(`[${k}]`, (e && e.stack) || e);
  process.exit(1);
}
process.exit(0);
