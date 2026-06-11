// node 测试用的 vendored zip.js 装载器（幂等）。
// node 下 require/import 该 UMD 两条分支都摸不到产物 → 显式喂 exports 强制 CJS 分支，
// 挂到 window.zip（src/zip.js 的 Z() 在 call-time 查 window）。
import fs from "node:fs";

export function ensureZipLoaded() {
  globalThis.window = globalThis.window || globalThis;
  if (globalThis.window.zip && globalThis.window.zip.ZipWriter) return;
  const code = fs.readFileSync(new URL("../vendor/zip-js/zip-full.min.js", import.meta.url), "utf8");
  const exp = {};
  new Function("exports", "module", "define", code).call(globalThis, exp, { exports: exp }, undefined);
  if (!exp.ZipWriter) throw new Error("vendored zip.js 没加载成");
  globalThis.window.zip = exp;
}
