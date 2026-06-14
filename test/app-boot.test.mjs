// Boot smoke 测试 —— 组合根 app.js 的接线验收（dismemberment-aftermath-survey 的 Top recommendation #1）。
//
// 背景：肢解把 app.js 从 god-file 拆成「显式 ctx 袋 + 22 步 initX 握手 + 5 个 Vue mount」。
// 代价（survey S2/S5）：接线零自动覆盖——拆出来的失败从「加载即 ReferenceError」（响亮、boot 即抓）
// 退化成「点到才 undefined is not a function」（静默、只真机抓）。本测试把 boot 这段拉回 node 守护：
// 在零依赖假 DOM（test/dom-shim.mjs，不引 jsdom——spec §5.5 + 家族「不许 npm install」铁律）上
// 真的 import 并跑完 app.js 的整段同步 boot + 紧随的 reactive flush，断言全程不抛。
//
// 覆盖（会 fail 的真回归）：
//   · 任一 initX(ctx) 同步抛错（缺/错 ctx key 在 init 期被解构或调用）
//   · 任一模块 module-eval 期抛错（eager els 查询、construct 期 DOM 触碰）
//   · Board canvas / 5 个 Vue 组件 mount 在 boot 期炸
//   · early/late init 顺序被打乱导致 gallery 相关 init 同步 NPE
//   · boot 收尾 IIFE / watch 回调在 settle 窗口内的 unhandledRejection / uncaughtException
//
// 不覆盖（survey 自陈的固有边界，属 recommendation #2「收窄 ctx + 断言必填 key」的活）：
//   · 「点到才浮现」——晚绑 ctx key 只在用户事件 handler 里被读、boot 期不触及的 undefined。
//     要抓这类需真事件回放或 ctx 必填 key 断言；本 smoke 只保「boot 不炸」这条底线。
//
// 维护：app.js 在 node 触发新 DOM/平台 API 而垫片没 stub → 这里报 "X is not a function/defined"，
//   按报错往 dom-shim.mjs 补一个 stub 即可（不是测试坏了，是 boot 摸到了新面）。

import { describe, it, assert } from "./runner.mjs";
import { installDomShim, makeNode } from "./dom-shim.mjs";

describe("app.js 组合根 boot smoke", () => {
  it("import app.js：22×initX + 5×Vue mount + reactive flush 全程不抛", async () => {
    // hermetic：测完复原全局，否则假 window 会顶掉后续 crypto/store 测试依赖的 globalThis.window.zip。
    const uninstallDomShim = installDomShim();

    // board 的 1:1 合成缓存（白边修）在 boot 期即建离屏 → 用 OffscreenCanvas。前面 selection-morph /
    // doc-* 测试会往 globalThis.OffscreenCanvas 漏一个极简 stub（无 setTransform/clearRect），boot 摸到就炸。
    // 这里装一个 shim 撑起的完整 OffscreenCanvas（getContext 走 makeCtx2d，全 NOOP 但方法齐），finally 复原。
    const prevOSC = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class OffscreenCanvasShim {
      constructor(w, h) { this.width = w; this.height = h; this._n = makeNode("canvas"); }
      getContext(type, opts) { return this._n.getContext(type, opts); }
    };

    // app boot 会起常驻 timer（cloud-freshness idle tick 的 setInterval、RAF、2s 后的 cloud check）。
    // 包住 global timer 工厂，settle 后全清——否则 `node test/run.mjs` 跑完套件不退出。
    const realSetTimeout = globalThis.setTimeout;
    const origSI = globalThis.setInterval, origST = globalThis.setTimeout;
    const intervals = new Set(), timeouts = new Set();
    globalThis.setInterval = (...a) => { const h = origSI(...a); intervals.add(h); return h; };
    globalThis.setTimeout = (...a) => { const h = origST(...a); timeouts.add(h); return h; };

    const errors = [];
    const onRej = (e) => errors.push(["unhandledRejection", e]);
    const onExc = (e) => errors.push(["uncaughtException", e]);
    process.on("unhandledRejection", onRej);
    process.on("uncaughtException", onExc);

    try {
      // 同步 boot：抛了直接冒泡成测试失败（这正是「initX 不抛」的断言）。
      await import("../src/app.js");

      // settle：让 boot 收尾的 async IIFE（gallery-first 加载分支）、Vue 调度器 flush、
      // immediate watch 跑完，捕获其中的异步抛错。用原始 setTimeout（不被下面清理误杀）。
      await new Promise((r) => realSetTimeout(r, 500));
    } finally {
      process.off("unhandledRejection", onRej);
      process.off("uncaughtException", onExc);
      globalThis.setInterval = origSI; globalThis.setTimeout = origST;
      for (const h of intervals) clearInterval(h);
      for (const h of timeouts) clearTimeout(h);
      globalThis.OffscreenCanvas = prevOSC;
      uninstallDomShim();
    }

    // node-env 下被 app 自己 catch 的兜底（IDB 缺失、default-brushes.json fetch 失败）是 console.warn，
    // 不进 errors；这里只对「真的逃逸出来的抛错」失败。
    if (errors.length) {
      const lines = errors.map(([k, e]) => `  [${k}] ${e && e.stack || e}`).join("\n");
      assert(false, `boot 期间有 ${errors.length} 个逃逸抛错：\n${lines}`);
    }
  });
});
