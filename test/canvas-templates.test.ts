// 画布尺寸模板（数据 = canvas-templates.json 独立 asset，新建作品 + 裁剪·模板模式共用）。
//
// 这个测试文件存在的理由（v0.7.32，user 2026-07-31）：模板此前有**两份**表——canvas-templates.ts
// 的 TS 常量（裁切读）+ index.html 手写的 <option>（新建读）。往新建里加了 1200×900，裁切看不到。
// 合成一份 json 之后，最该守的就是「一条模板确实同时喂两个面」和「id 不许乱改」（crop 的
// editorState.crop.templateId 持久化了 id）。
import { readFileSync } from "node:fs";
import { test, eq, assert } from "./runner.mjs";
import {
  _adoptCanvasTemplates, allTemplates, templatesFor, templateById, templatePx,
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
    if (tp.surfaces) {
      assert(tp.surfaces.length > 0, `surfaces 空数组=谁也看不见: ${tp.id}`);
      for (const s of tp.surfaces) assert(["new", "crop"].includes(s), `surfaces 非法: ${tp.id} ${s}`);
    }
  }
});

test("id 是持久化契约：crop 的 templateId 存量 id 一个都不许消失", () => {
  // editorState.crop.templateId 存的就是这些字符串（v0.6.48 起）。改名 = 用户桌面记忆失效。
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

test("一份表喂两个面：默认（无 surfaces）的模板新建和裁切都看得到", () => {
  const inNew = new Set(templatesFor("new").map((tp) => tp.id));
  const inCrop = new Set(templatesFor("crop").map((tp) => tp.id));
  assert(inNew.size > 0 && inCrop.size > 0, "两个面都不该是空的");
  for (const tp of allTemplates()) {
    if (tp.surfaces) continue;
    assert(inNew.has(tp.id), `无 surfaces 的模板漏了新建面: ${tp.id}`);
    assert(inCrop.has(tp.id), `无 surfaces 的模板漏了裁切面: ${tp.id}`);
  }
  // 这次的直接起因：3:4 / 4:3 必须两个面都在（当初只加进了新建那半边）。
  for (const id of ["screen-1200x900", "screen-900x1200"]) {
    assert(inNew.has(id), `${id} 不在新建面`);
    assert(inCrop.has(id), `${id} 不在裁切面`);
  }
});

test("新建面保持 #21 收窄后的形状：没有 A4、没有 4096²、打印只给竖版", () => {
  const inNew = templatesFor("new");
  const ids = new Set(inNew.map((tp) => tp.id));
  // A4 / 4096² 是 user 原话砍的（见 canvas-templates.json 的出处分级），这两条别自作主张加回来。
  for (const id of ["print-a4-300", "print-a4l-300", "print-a5-300", "print-a5l-300", "screen-4096sq"]) {
    assert(!ids.has(id), `新建面不该有 ${id}（user 原话砍掉的）`);
  }
  // 「只给竖版」查无 user 原话，是当年 AI 提案的细节——钉在这里只为防**无意**漂移，
  // 不是 user 拍板；真要给新建面加横版打印模板，不必回去问，改这条断言即可。
  for (const tp of inNew) {
    if (tp.kind === "print") assert(tp.h > tp.w, `新建面的打印模板目前约定为竖版: ${tp.id}`);
  }
});

test("UI 投影顺序：同 kind 的模板在数组里连续（否则 optgroup 会分裂成两块）", () => {
  for (const surface of ["new", "crop"] as const) {
    const seen = new Set<string>();
    let prev = "";
    for (const tp of templatesFor(surface)) {
      if (tp.kind !== prev) {
        assert(!seen.has(tp.kind), `${surface} 面的 kind ${tp.kind} 被打断成多段`);
        seen.add(tp.kind);
        prev = tp.kind;
      }
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
