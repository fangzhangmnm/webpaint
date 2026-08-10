#!/usr/bin/env node
// C2 目录格律 lint（C 骑士提案 §1 五目录单向依赖 + 禁浏览器词；ADR-0009）。规则**只增不减**：
//   · common/**  纯类型+纯数学：不得 import src 其他目录（vendor 也不许）。
//   · backend/** 只准 import common/（+ backend 内部相对引用 + vendor 纯计算库）。
//   · frontend/** 只准 import common/ + backend/（+ frontend 内部 + vendor）——不碰 shell/、gallery/、store。
//   · shell/**   platform 胶水，可 import 全部（无约束）。
//   · gallery/** 检疫堆场（提案 §1：只搬不斩）：暂无依赖约束。
//   · 禁浏览器词（backend 域 DOM 零依赖）：common/** + backend/** 代码行不得出现
//     document/window/navigator/localStorage/sessionStorage/getContext(/createElement(/addEventListener(。
//     注释行豁免；WebGL 句柄类型（WebGLTexture 等）= Gl2Port 契约 opaque 类型，不在禁词内。
// C7 起从 build.sh 的 grep 版升格为真路径解析（grep 分不清「backend 子目录间的 ../」和「逃逸出
// backend 的 ../」——workpiece/ 搬入后 ../tiles/、../selection.ts 全是合法内部引用）。语义同旧。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath 而非 URL.pathname——仓路径带空格（%20 编码会让目录静默扫空、lint 假绿）。
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (!statSync(resolve(ROOT, "src", "backend"), { throwIfNoEntry: false })) {
  console.error("[lint-dirs] ✗ 自检失败：src/backend 不存在（ROOT 解析错？）" + ROOT);
  process.exit(1);
}
const errors = [];

function tsFilesUnder(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = resolve(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...tsFilesUnder(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

// import specifier 抽取（静态 import/export-from + 动态 import()）。
const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function checkDeps(dirName, allowedTops) {
  const base = resolve(ROOT, "src", dirName);
  for (const file of tsFilesUnder(base)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;   // bare specifier（无：全 vendored）不管
      const target = resolve(dirname(file), spec);
      const relToBase = relative(base, target);
      if (!relToBase.startsWith("..")) continue;   // 目录内部引用：合法
      const relToRoot = relative(ROOT, target);
      const top = relToRoot.split(sep).slice(0, 2).join("/");   // "src/common" / "vendor/upng" …
      const topDir = relToRoot.startsWith("vendor" + sep) ? "vendor" : top;
      if (!allowedTops.includes(topDir)) {
        const line = text.slice(0, m.index).split("\n").length;
        errors.push(`${relative(ROOT, file)}:${line}: ${dirName}/ 不得 import ${relToRoot}（只准 ${allowedTops.join(", ")}）`);
      }
    }
  }
}

checkDeps("common", []);   // common 不得出目录（vendor 也不许）
checkDeps("backend", ["src/common", "vendor"]);
checkDeps("frontend", ["src/common", "src/backend", "vendor"]);

// 禁浏览器词（common+backend 代码行；注释行豁免——与旧 grep 同口径：行首 // 或 * 或 /*）。
const WORD_RE = /\b(document|window|navigator|localStorage|sessionStorage)\b|getContext\(|createElement\(|addEventListener\(/;
for (const dir of ["common", "backend"]) {
  for (const file of tsFilesUnder(resolve(ROOT, "src", dir))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
      if (WORD_RE.test(l)) errors.push(`${relative(ROOT, file)}:${i + 1}: 禁浏览器词：${l.trim().slice(0, 100)}`);
    }
  }
}

if (errors.length) {
  console.error("[lint-dirs] ✗ C2 目录格律违规：");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log("[lint-dirs] ✓ C2 目录格律干净");
