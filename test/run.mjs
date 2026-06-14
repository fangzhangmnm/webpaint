// WebPaint 专属测试入口（store/cloud-sync/provider 契约在 lib 的 test/，这里只留 WebPaint vendored adapter）。
import { run } from "./runner.mjs";
import "./onedrive-provider.contract.test.mjs";
import "./crypto-container.test.mjs";
import "./store-crypt.test.mjs";
import "./substrate.test.mjs";
import "./store-flow.test.mjs";
import "./store-coalescer.test.mjs";
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./folder-store.test.mjs";
import "./brush-rack-migrate.test.mjs";
import "./engine-registry.test.mjs";
import "./registry.test.mjs";
import "./resolved-brush.test.mjs";
import "./pointer-gesture.test.mjs";
import "./crop-geometry.test.mjs";
import "./gallery-model.test.mjs";
import "./gallery-view-model.test.mjs";
import "./color-model.test.mjs";
import "./brush-size.test.mjs";
import "./brush-settings-model.test.mjs";
import "./brush-rack-view.test.mjs";
import "./pointer-route.test.mjs";
import "./stroke-input-smooth.test.mjs";
import "./stroke-smoother.test.mjs";
import "./selection-morph.test.mjs";
import "./app-boot.test.mjs";   // 组合根 boot smoke（接线零覆盖缺口，见该文件头注释）。放最后：包了 global timer。

console.log("\n  WebPaint —— vendored OneDriveProvider 适配验收（lib 契约在 sync-store/test/）\n");
await run();
