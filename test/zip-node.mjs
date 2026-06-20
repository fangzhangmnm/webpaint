// node 测试用的 vendored 加密原语装载器（幂等）。
import fs from "node:fs";
import { createRequire } from "node:module";

// zip.js UMD：node 下 require/import 两条分支都摸不到产物 → 显式喂 exports 强制 CJS 分支，
// 挂到 window.zip（src/zip.js 的 Z() 在 call-time 查 window）。
export function ensureZipLoaded() {
  globalThis.window = globalThis.window || globalThis;
  if (globalThis.window.zip && globalThis.window.zip.ZipWriter) return;
  const code = fs.readFileSync(new URL("../vendor/zip-js/zip-full.min.js", import.meta.url), "utf8");
  const exp = {};
  new Function("exports", "module", "define", code).call(globalThis, exp, { exports: exp }, undefined);
  if (!exp.ZipWriter) throw new Error("vendored zip.js 没加载成");
  globalThis.window.zip = exp;
}

// 7z-wasm：sevenzip.js 默认 loader 是浏览器路径（注入 script + fetch），node 跑不了 →
// 经 setSevenZipLoader 注入 node 版（require UMD + fs 读 wasm）。
export async function ensure7zLoaded() {
  const { setSevenZipLoader } = await import("../src/sevenzip.ts");
  const require = createRequire(import.meta.url);
  const factory = require("../vendor/7z-wasm/7zz.umd.js");
  const wasmPath = new URL("../vendor/7z-wasm/7zz.wasm", import.meta.url);
  setSevenZipLoader(async () => ({ factory, wasmBinary: fs.readFileSync(wasmPath).buffer }));
}
