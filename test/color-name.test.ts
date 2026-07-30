// color-name（颜色 ↔ 名字）：表完整性门（120 条 / 四语齐 / 同语言互异）+ OKLab nearest + 四语 parse。
import { test, eq, assert } from "./runner.mjs";
import { COLOR_NAMES } from "../src/color-name-table.ts";
import { nearestColorEntry, parseColorName } from "../src/color-name.ts";

test("表完整性：120 条、hex 合法、en/zh/ja 同语言内互异、tok 全填", () => {
  eq(COLOR_NAMES.length, 120);
  for (const lang of ["en", "zh", "ja"] as const) {
    const seen = new Set<string>();
    for (const e of COLOR_NAMES) {
      assert(!seen.has(e[lang]), `${lang} 撞名: ${e[lang]}`);
      seen.add(e[lang]);
    }
  }
  const hexes = new Set<string>();
  for (const e of COLOR_NAMES) {
    assert(/^#[0-9a-f]{6}$/.test(e.hex), `hex 非法: ${e.en} ${e.hex}`);
    assert(!hexes.has(e.hex), `hex 重复: ${e.hex}`);
    hexes.add(e.hex);
    assert(e.tok.length > 0, `tok 缺: ${e.en}`);
  }
});

test("nearest 自洽：每个锚点自身的 hex 反查回自己（无锚点被邻居吞掉）", () => {
  for (const e of COLOR_NAMES) {
    const r = parseInt(e.hex.slice(1, 3), 16), g = parseInt(e.hex.slice(3, 5), 16), b = parseInt(e.hex.slice(5, 7), 16);
    eq(nearestColorEntry(r, g, b).en, e.en, e.hex);
  }
});

test("nearest 抽查：纯白/纯黑/近红/天蓝附近", () => {
  eq(nearestColorEntry(255, 255, 255).en, "white");
  eq(nearestColorEntry(0, 0, 0).en, "black");
  eq(nearestColorEntry(229, 1, 1).en, "red");          // #e50000 ±1
  eq(nearestColorEntry(0x76, 0xbb, 0xfc).en, "sky blue");
});

test("parse 四语 + 大小写/空格不敏感 + CSS 连写；未知 → null", () => {
  eq(parseColorName("sky blue"), "#75bbfd");
  eq(parseColorName("  Sky  BLUE "), "#75bbfd");
  eq(parseColorName("skyblue"), "#75bbfd");
  eq(parseColorName("天蓝"), "#75bbfd");
  eq(parseColorName("空色"), "#75bbfd");
  eq(parseColorName("laso sewi"), "#75bbfd");   // tok 撞名按热度先到先得：sky blue 排在知更鸟蛋蓝前
  eq(parseColorName("laso"), "#0343df");        // 多锚点共用 laso → 最热的 blue
  eq(parseColorName("紫"), "#7e1e9c");
  eq(parseColorName("nicht eine farbe"), null);
  eq(parseColorName("#ff0000"), null);          // hex 不归本模块（调用方先走 normalizeHex）
});
