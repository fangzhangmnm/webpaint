// WebPaint 全量层测试入口（C8 ⑤ 测试分级）——`npm run test:full` = 快层(run.mjs) + 本层 + GL smoke。
// 本层住「贵但值」的锚：全量画作 round-trip、mock multiplayer 双 backend。
// 三方 golden ±ε（真 GPU vs SwiftShader vs SoftGl2，gl-smoke harness 注入 SoftGl2 比较器）排后棒。
// 快层开发期快捷：TEST_FILTER=<子串> npm test 只跑匹配条目（runner.mjs run() 的过滤器）。
import "./dom-shim-first.mjs";   // 必须第一（同 run.mjs——Vue/document 求值序）
import { run } from "./runner.mjs";
import { ensureZipLoaded } from "./zip-node.mjs";
import { installDomParserShim } from "./xml-shim.mjs";
ensureZipLoaded();               // encodeOra/open .ora 用（vendored zip.js node 装载）
installDomParserShim();          // open 路径 parseStackXml 用（node 无 DOMParser）

import "./full-painting-roundtrip.test.mjs";   // 全量画作 encodeOra↔open 逐字节 + 构建决定论
import "./full-mock-multiplayer.test.mjs";     // 共享 SoftGl2Port 双租户：隔离对拍/令牌墙 per-backend/退租

console.log("\n  WebPaint —— 全量层（test:full；快层锚在 run.mjs）\n");
await run();
