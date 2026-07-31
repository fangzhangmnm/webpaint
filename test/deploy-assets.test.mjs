// 部署清单守卫：runtime fetch 的根目录 asset 必须同时进 SW 预缓存和 GH Actions 的拷贝白名单。
//
// 为什么要有这条（这个坑踩过**两次**，两次都是静默的）：
//   ① default-brushes.json 改名成 builtin-brushes.json，deploy.yml 的列表没跟 → 出厂笔刷 JSON
//      从此再没被部署过，线上 404，每台新设备只剩一支 emergency「默认笔」。
//   ② v0.7.32 新增 canvas-templates.json，同样忘了加 → 新建作品/裁切的尺寸下拉框在线上全空。
// 两次都不会让部署失败（deploy.yml 里 cp 的失败被咽掉，只打 ::warning::），也不会让测试变红——
// 除非有这么一条。
//
// 判据：源码里出现 `new URL("./xxx", document.baseURI)` 的，就是运行时要从站点根目录取的文件。
import { readFileSync, readdirSync } from "node:fs";
import { test, assert } from "./runner.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf-8");

// src/ 全树（含子目录）里扫 runtime fetch 的相对 asset
function srcFiles(dir = "src") {
  const out = [];
  for (const e of readdirSync(new URL(dir + "/", root), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...srcFiles(`${dir}/${e.name}`));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) out.push(`${dir}/${e.name}`);
  }
  return out;
}

const fetched = new Set();
for (const f of srcFiles()) {
  for (const m of read(f).matchAll(/new URL\(\s*["']\.\/([^"']+)["']\s*,\s*document\.baseURI/g)) {
    fetched.add(m[1]);
  }
}

test("部署清单：runtime fetch 的根 asset 一个都不许漏（SW 预缓存 + deploy.yml 白名单）", () => {
  assert(fetched.size > 0, "一个 runtime fetch 的 asset 都没扫到——正则大概过时了，先修这条");
  const sw = read("service-worker.js");
  const precache = sw.slice(sw.indexOf("STATIC_PRECACHE"), sw.indexOf("];", sw.indexOf("STATIC_PRECACHE")));
  const deploy = read(".github/workflows/deploy.yml");
  // deploy.yml 里那段 `for f in ... ; do` 的文件名列表
  const forLine = deploy.slice(deploy.indexOf("for f in "), deploy.indexOf("; do", deploy.indexOf("for f in ")));
  for (const asset of fetched) {
    assert(precache.includes(`"./${asset}"`), `${asset} 不在 SW 的 STATIC_PRECACHE 里 → 离线打不开`);
    assert(new RegExp(`(^|\\s)${asset.replace(/\./g, "\\.")}(\\s|\\\\)`).test(forLine),
      `${asset} 不在 deploy.yml 的拷贝白名单里 → 线上 404（而且部署不会报错，静默）`);
  }
});
