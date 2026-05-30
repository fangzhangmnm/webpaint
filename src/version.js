// 版本 SSoT。bump 这里 → 跑 bash scripts/build.sh --prod → index.html 自动指向新 hash。
// 约定：vN-YYYY-MM-DD。N 单调递增，日期是发版那天。
//
// v121 起改 ES module 导出：bundle 后 esbuild 把字面值 inline 进 main-<hash>.mjs。
// 跟 bundle 一起 hash 出新文件名，不再需要 SW 合成 / import URL rewrite 等老花招。
export const WEBPAINT_VERSION = "v124-2026-05-30";
