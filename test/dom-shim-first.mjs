// 套件级 DOM shim 安装——**必须是 run.mjs 的第一个 import**。
//
// 为什么 top-level 装：Vue（vue.esm-browser）在 module-eval 时把 document 缓存成 module 级 const。
// 只要套件里任何测试在 top-level import 了拉 Vue 的模块（如 current-brush.ts），ESM 会在 run() 之前
// 就求值它 → Vue 那时若没 document（node 裸环境）→ 缓存 doc=null → 之后 boot-smoke 里 Vue mount
// 即 `null.createTextNode` 炸。这里在最早时刻装好 shim，确保 Vue 首次求值时 document 有效。
//
// shim 设计上是 hermetic-可卸载的，但本模块装的这份是**套件级**：crypto/store 测试在它存在下
// 把 zip 载进 shim window（ensureZipLoaded：globalThis.window.zip）也无碍——shim-first 不会像
// 「装在 crypto 之后」那样顶掉已载好的 window（那才是当初 24 假红的成因）。boot-smoke 自己再调
// installDomShim 是幂等 no-op（见 dom-shim.mjs），不会中途把它拆掉。

import { installDomShim } from "./dom-shim.mjs";
installDomShim();
