// WebPaint 专属测试入口（store/cloud-sync/provider 契约在 lib 的 test/，这里只留 WebPaint vendored adapter）。
import { run } from "./runner.mjs";
import "./onedrive-provider.contract.test.mjs";
import "./store-flow.test.mjs";
import "./store-coalescer.test.mjs";
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./brush-rack-migrate.test.mjs";
import "./engine-registry.test.mjs";
import "./pointer-gesture.test.mjs";
import "./crop-geometry.test.mjs";
import "./gallery-model.test.mjs";
import "./brush-rack-view.test.mjs";

console.log("\n  WebPaint —— vendored OneDriveProvider 适配验收（lib 契约在 sync-store/test/）\n");
await run();
