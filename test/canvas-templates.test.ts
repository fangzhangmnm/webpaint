// 画布尺寸模板（数据 = canvas-templates.json 独立 asset，新建作品 + 裁剪·模板模式共用）。
//
// 这个测试文件存在的理由（v0.7.32，user 2026-07-31）：模板此前有**两份**表——canvas-templates.ts
// 的 TS 常量（裁切读）+ index.html 手写的 <option>（新建读）。往新建里加了 1200×900，裁切看不到。
// 合成一份 json 之后，最该守的就是「一条模板确实同时喂两个面」和「id 不许乱改」（crop 的
// desk.crop.templateId 持久化了 id）。
import { readFileSync } from "node:fs";
import { test, eq, assert } from "./runner.mjs";
import {
  _adoptCanvasTemplates, allTemplates, templateById, templatePx,
  type CanvasTemplate,
} from "../src/canvas-templates.ts";

const DATA = JSON.parse(readFileSync(new URL("../canvas-templates.json", import.meta.url), "utf-8"));
_adoptCanvasTemplates(DATA.templates as CanvasTemplate[]);

test("数据契约：字段齐全、id 唯一、print 必带 dpi", () => {
  const ids = new Set<string>();
  for (const tp of allTemplates()) {
    for (const k of ["id", "label", "kind", "w", "h", "unit"]) assert(k in tp, `模板 ${tp.id} 缺 ${k}`);
    assert(!ids.has(tp.id), `id 重复: ${tp.id}`);
    ids.add(tp.id);
    assert(["print", "screen", "pixel"].includes(tp.kind), `kind 非法: ${tp.id} ${tp.kind}`);
    assert(["px", "mm", "in"].includes(tp.unit), `unit 非法: ${tp.id} ${tp.unit}`);
    assert(tp.w > 0 && tp.h > 0, `尺寸非正: ${tp.id}`);
    if (tp.kind === "print") assert(typeof tp.dpi === "number" && tp.dpi > 0, `print 缺 dpi: ${tp.id}`);
    if (tp.unit !== "px") {
      // 物理单位模板的像素数由 templateLabel() 换算后自动追加——label 里再写死一份既会重复显示，
      // 也会在 DPI 改动时漂移。（「4×6in」「100×148mm」是物理规格，不在此列。）
      const px = templatePx(tp);
      const stripped = tp.label.replace(/\s/g, "");
      assert(!stripped.includes(`${px.w}×${px.h}`), `别把换算出的像素数写死进 label（会漂移）: ${tp.id}`);
    }
    assert(!("surfaces" in tp), `v0.7.34 起两个面显示完全一样的列表，不该再有分面白名单: ${tp.id}`);
  }
});

test("id 是持久化契约：crop 的 templateId 存量 id 一个都不许消失", () => {
  // desk.crop.templateId 存的就是这些字符串（v0.6.48 起）。改名 = 用户桌面记忆失效。
  for (const id of [
    "print-4x6-300", "print-6x4-300", "print-5x7-300", "print-7x5-300",
    "print-a5-300", "print-a5l-300", "print-a4-300", "print-a4l-300",
    "screen-1080x1920", "screen-1920x1080", "screen-4096sq",
    "screen-2048sq", "screen-1024sq", "screen-512sq",
    "pixel-256", "pixel-128", "pixel-64", "pixel-32",
  ]) assert(templateById(id), `存量模板 id 不见了: ${id}`);
});

test("templatePx：物理单位按 DPI 换算成整像素", () => {
  eq(templatePx(templateById("print-4x6-300")!).w, 1200, "4×6in@300 宽");
  eq(templatePx(templateById("print-4x6-300")!).h, 1800, "4×6in@300 高");
  eq(templatePx(templateById("print-6x8-300")!).w, 1800, "6×8in@300 宽");
  eq(templatePx(templateById("print-6x8-300")!).h, 2400, "6×8in@300 高");
  // 明信片 100×148mm@300 = 1181×1748（旧 index.html 手写的像素数，换算必须对得上）
  eq(templatePx(templateById("print-postcard-300")!).w, 1181, "明信片宽");
  eq(templatePx(templateById("print-postcard-300")!).h, 1748, "明信片高");
  eq(templatePx(templateById("print-a4-300")!).w, 2480, "A4 宽");
  eq(templatePx(templateById("print-a4-300")!).h, 3508, "A4 高");
  // px 类原样返回
  eq(templatePx(templateById("screen-1200x900")!).w, 1200, "1200×900 宽");
  eq(templatePx(templateById("screen-1200x900")!).h, 900, "1200×900 高");
});

test("一份表喂两个面：两边显示完全一样的列表（user 2026-07-31 定）", () => {
  // 机制上已经没有 per-surface 过滤了（surfaces 字段连同 templatesFor() 一起删掉）——
  // 这条守的是「别再把它加回来」：投影函数只吃 (select, 自定义文案)，没有第三个分面参数。
  const src = readFileSync(new URL("../src/canvas-templates.ts", import.meta.url), "utf-8");
  assert(!/templatesFor/.test(src), "templatesFor() 复活了 = 分面差异回来了");
  assert(/export function fillTemplateSelect\(sel: HTMLSelectElement, customLabel: string\)/.test(src),
    "fillTemplateSelect 签名变了——多出的参数是不是又在分面？");
  // 这次的直接起因：3:4 / 4:3 得在表里（当初只加进了新建那半边的手写 option）。
  for (const id of ["screen-1200x900", "screen-900x1200"]) assert(templateById(id), `${id} 不在表里`);
});

test("打印模板横竖成对（user 原话：照片应该有横向和竖向）", () => {
  const prints = allTemplates().filter((tp) => tp.kind === "print");
  assert(prints.length > 0, "没有打印模板？");
  // 成对判据：同 unit 同 dpi、长短边数值互换，必须找得到对家。
  for (const tp of prints) {
    const mate = prints.find((o) =>
      o.id !== tp.id && o.unit === tp.unit && o.dpi === tp.dpi && o.w === tp.h && o.h === tp.w);
    assert(mate, `${tp.id}（${tp.w}×${tp.h}${tp.unit}）缺横/竖对家——打印模板要两个方向一起加`);
  }
});

test("UI 投影顺序：同 kind 的模板在数组里连续（否则 optgroup 会分裂成两块）", () => {
  const seen = new Set<string>();
  let prev = "";
  for (const tp of allTemplates()) {
    if (tp.kind !== prev) {
      assert(!seen.has(tp.kind), `kind ${tp.kind} 被打断成多段`);
      seen.add(tp.kind);
      prev = tp.kind;
    }
  }
});

test("i18n：模板引用的 key 在四语表里都有", async () => {
  const { S } = await import("../src/i18n/strings.ts");
  const keys = ["nd.custom", "nd.grp.painting", "nd.grp.print", "nd.grp.pixel"];
  for (const tp of allTemplates()) if (tp.i18n) keys.push(tp.i18n);
  for (const k of keys) {
    const row = (S as Record<string, Record<string, string>>)[k];
    assert(row, `strings.ts 缺 key: ${k}`);
    for (const lang of ["zh", "en", "ja", "tok"]) assert(row[lang], `${k} 缺 ${lang}`);
  }
});
