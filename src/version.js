// 版本号 SSoT。service-worker.js 走 importScripts() 拿；index.html 普通
// <script> 也加载，给 app.js 读 window.WEBPAINT_VERSION。bump 一处，两边生效。
//
// 约定：vN-YYYY-MM-DD。N 单调递增，日期是发版那天。改了客户端代码就 bump。
self.WEBPAINT_VERSION = "v34-2026-05-28";
