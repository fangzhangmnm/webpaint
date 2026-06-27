// GL smoke runner：esbuild bundle harness.ts → 无头 Chromium(SwiftShader WebGL2) 跑 → 读 window.__SMOKE__ 断言。
// 用途：验 node 测不到的真 GL 路径（context/shader/FBO/array-texture 上传读回）。
//   像素美学/手感/真机 GPU 精度不在此（那是 iPad 批）；Chromium 与 iPad 引擎不同，但
//   blend 公式确定性 → 同引擎 2D-vs-GL 自 diff 能抓绝大多数公式 bug（Stage 2 接入）。
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");

// 1) bundle harness（esbuild 解 .ts 扩展 import，同 app 构建）。
const esbuild = path.join(root, "tools/esbuild/esbuild");
const b = spawnSync(esbuild, [
  path.join(dir, "harness.ts"), "--bundle", "--format=iife",
  "--outfile=" + path.join(dir, "harness.js"),
], { stdio: "inherit" });
if (b.status !== 0) { console.error("[smoke] esbuild bundle 失败"); process.exit(1); }

// 2) 启 Chromium。无头需 SwiftShader 才有 WebGL2。
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });

await page.goto("file://" + path.join(dir, "index.html"));
const result = await page
  .waitForFunction(() => window.__SMOKE__, null, { timeout: 15000 })
  .then((h) => h.jsonValue())
  .catch(() => null);
await browser.close();

// 3) 报告
console.log("\nGL smoke (real Chromium WebGL2 / SwiftShader):");
if (!result) {
  console.log("  ✗ harness 未产出结果（window.__SMOKE__ 超时）");
  if (pageErrors.length) console.log("  page errors:", pageErrors.join(" | "));
  process.exit(1);
}
for (const c of result.checks) {
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`);
}
if (result.error) console.log("  ERROR:", result.error);
if (pageErrors.length) console.log("  page errors:", pageErrors.join(" | "));
const ok = result.ok && !result.error;
console.log(ok ? "\n  GL smoke PASSED\n" : "\n  GL smoke FAILED\n");
process.exit(ok ? 0 : 1);
