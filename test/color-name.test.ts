// color-name（颜色 ↔ 名字，全语言统一大表）：表完整性门 + 按语言命名（OKLab nearest）+
// 全语言 parse（行序 = 优先级 mpl > css > en > zh > ja > tok）。
import { test, eq, assert } from "./runner.mjs";
import { COLOR_WORDS } from "../src/color-words.ts";
import { colorNameIn, parseColorName, searchColorNames } from "../src/color-name.ts";

test("表完整性：六类别都在、规模对、hex 合法、en/zh/ja 同语言内名字互异（tok 多锚点豁免）", () => {
  const counts = new Map<string, number>();
  for (const [cat, name, hex] of COLOR_WORDS) {
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
    assert(/^#[0-9a-f]{6}$/.test(hex), `hex 非法: ${cat} ${name} ${hex}`);
    assert(name.length > 0, "空名");
  }
  for (const cat of ["mpl", "css", "xkcd", "zh-trad", "ja-trad", "tok"]) assert((counts.get(cat) ?? 0) > 0, `缺类别 ${cat}`);
  assert(counts.get("xkcd")! > 900 && counts.get("zh-trad")! > 500 && counts.get("ja-trad")! > 400, "全表规模不对");
  for (const check of ["xkcd", "zh-trad", "ja-trad"]) {
    const seen = new Set<string>();
    for (const [cat, name] of COLOR_WORDS) {
      if (cat !== check) continue;
      assert(!seen.has(name), `${check} 表内撞名: ${name}`);
      seen.add(name);
    }
  }
});

test("命名按 culture 分表（≠localization）：同一颜色各词库各得其名（OKLab nearest）", () => {
  eq(colorNameIn("xkcd", 229, 0, 0), "red");
  eq(colorNameIn("zh-trad", 0xee, 0xf7, 0xf2), "月白");
  eq(colorNameIn("ja-trad", 0xb7, 0x28, 0x2e), "茜色");
  eq(colorNameIn("tok", 3, 67, 223), "laso");
  eq(colorNameIn("tok", 255, 255, 255), "walo");
  eq(colorNameIn("tok", 0x75, 0xbb, 0xfd), "laso sewi");
});

test("slang flag：parse 照认、命名跳过；未收录 culture fallback xkcd", () => {
  eq(parseColorName("puke green"), "#9aae07");
  const n = colorNameIn("xkcd", 0x9a, 0xae, 0x07);
  assert(n !== "puke green", `命名蹦出 slang: ${n}`);
  eq(colorNameIn("fr", 229, 0, 0), "red");   // 加新 culture 只加行；没行的兜底 xkcd
});

test("parse 全语言搜索，行序 = 优先级（universal → 小众）", () => {
  eq(parseColorName("b"), "#0000ff");           // mpl 单字母
  eq(parseColorName("K"), "#000000");
  eq(parseColorName("tab:blue"), "#1f77b4");    // mpl tab: 配色（三种写法都认）
  eq(parseColorName("tab blue"), "#1f77b4");
  eq(parseColorName("tabblue"), "#1f77b4");
  eq(parseColorName("blue"), "#0000ff");        // css 标准化石值压过 xkcd #0343df（user 点名对齐标准）
  eq(parseColorName("sky blue"), "#75bbfd");    // 带空格 = xkcd 写法 → 众包质心
  eq(parseColorName("skyblue"), "#87ceeb");     // 连写 = css 关键字写法 → css 值
  eq(parseColorName("  Sky  BLUE "), "#75bbfd");
  eq(parseColorName("月白"), "#eef7f2");         // 中国传统色（zhongguose 快照 526）
  eq(parseColorName("yuebai"), "#eef7f2");       // 拼音别名
  eq(parseColorName("茜色"), "#b7282e");         // 和色大辞典（colordic 快照 462）
  eq(parseColorName("あかねいろ"), "#b7282e");   // かな别名
  eq(parseColorName("苔色"), "#69821b");         // 和色值（命名/parse 同表自洽）
  eq(parseColorName("laso"), "#0343df");         // tok 裸词首选 = 蓝（表内首行）
  eq(parseColorName("laso sewi"), "#75bbfd");
  eq(parseColorName("nicht eine farbe"), null);
  eq(parseColorName("#ff0000"), null);           // hex 不归本模块（调用方先走 normalizeHex）
});

test("命名 ↔ parse 往返自洽（各语言抽查）", () => {
  // 抽几个各语言的锚点色：命名得 X，parse(X) 回到同一 hex（同表同行）
  for (const [langCat, hex] of [["zh-trad", "#f9f4dc"], ["ja-trad", "#fef4f4"], ["xkcd", "#75bbfd"]] as const) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const name = colorNameIn(langCat, r, g, b);
    eq(parseColorName(name), hex, `${langCat} ${name}`);
  }
});

test("searchColorNames（IntelliSense 数据面）：前缀优先、别名命中、空查询空结果", () => {
  eq(searchColorNames("").length, 0);
  const sky = searchColorNames("sky");
  assert(sky.length >= 2, "sky 候选太少");
  assert(sky.some((x) => x.name === "skyblue") && sky.some((x) => x.name === "sky blue"), "css/xkcd 两写法都该在");
  eq(searchColorNames("月白")[0].name, "月白");
  eq(searchColorNames("yueb")[0].name, "月白");        // 拼音前缀 → 正名
  eq(searchColorNames("あかね")[0].name, "茜色");      // かな前缀 → 正名
  for (const it of searchColorNames("las")) assert(/^#[0-9a-f]{6}$/.test(it.hex));
  assert(searchColorNames("las").some((x) => x.name.startsWith("laso")), "tok 词也可联想");
  // 中间/尾缀命中保底槽位（user：输「黄」必须查得到「xx黄」，不能被黄x前缀挤光）
  const huang = searchColorNames("黄", 8);
  assert(huang.some((x) => x.name.indexOf("黄") > 0), `尾缀命中被挤光: ${huang.map((x) => x.name).join(",")}`);
  assert(huang.some((x) => x.name.startsWith("黄")), "前缀命中也该在");
  // 默认无上限：全部命中都返回（菜单限高滚动）
  assert(searchColorNames("黄").length > huang.length, "默认应不设上限");
});
