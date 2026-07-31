// color-name（颜色 ↔ 名字，数据 = color-words.json 独立 asset）：数据契约门 + 按 culture 命名
// （OKLab nearest）+ 全词库 parse + 色温 + `category:` 前缀浏览。
// 词库完整性（hex/类内唯一/别名撞车/parent 两级）由 20260730 Colors 的 build.py 把守；
// 这里守的是**宿主消费契约**：格式能 adopt、各查询面行为对。
import { readFileSync } from "node:fs";
import { test, eq, assert } from "./runner.mjs";
import {
  _adoptColorWords, colorNameIn, parseColorName, searchColorNames,
  kelvinToHex, namingCategories, categoryLabel,
} from "../src/color-name.ts";

const DATA = JSON.parse(readFileSync(new URL("../color-words.json", import.meta.url), "utf-8"));
_adoptColorWords(DATA);

test("数据契约：categories 元数据齐全、六库都在、词行挂已知类", () => {
  const ids = new Set<string>();
  for (const c of DATA.categories) {
    for (const k of ["id", "label", "aliases", "naming", "default_for"]) assert(k in c, `category ${c.id} 缺 ${k}`);
    ids.add(c.id);
  }
  for (const want of ["mpl", "css", "xkcd", "zh-trad", "ja-trad", "tok"]) assert(ids.has(want), `缺 ${want}`);
  const counts = new Map<string, number>();
  for (const [cat, name, hex] of DATA.words) {
    assert(ids.has(cat), `词行挂未知类: ${cat} ${name}`);
    assert(/^#[0-9a-f]{6}$/.test(hex), `hex 非法: ${name} ${hex}`);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  assert(counts.get("xkcd")! > 900 && counts.get("zh-trad")! > 500 && counts.get("ja-trad")! > 400, "规模不对");
  // 命名词库清单（sheet 下拉数据源）来自元数据
  const naming = namingCategories().map((c) => c.id);
  assert(naming.includes("zh-trad") && naming.includes("tok") && !naming.includes("mpl") && !naming.includes("css"), `naming 清单不对: ${naming}`);
  eq(categoryLabel("zh-trad"), "中国传统色");
});

test("命名按 culture 分表（≠localization）：同一颜色各词库各得其名（OKLab nearest）", () => {
  eq(colorNameIn("xkcd", 229, 0, 0), "red");
  eq(colorNameIn("zh-trad", 0xee, 0xf7, 0xf2), "月白");
  eq(colorNameIn("ja-trad", 0xb7, 0x28, 0x2e), "茜色");
  eq(colorNameIn("tok", 3, 67, 223), "laso");
  eq(colorNameIn("tok", 255, 255, 255), "walo");
  eq(colorNameIn("tok", 0x75, 0xbb, 0xfd), "laso sewi");
  eq(colorNameIn("fr", 229, 0, 0), "red");   // 未收录 culture 兜底 xkcd（加词库只加行）
});

test("slang flag：parse 照认、命名跳过", () => {
  eq(parseColorName("puke green"), "#9aae07");
  const n = colorNameIn("xkcd", 0x9a, 0xae, 0x07);
  assert(n !== "puke green", `命名蹦出 slang: ${n}`);
});

test("parse 全词库，行序 = 优先级（universal → 小众）", () => {
  eq(parseColorName("b"), "#0000ff");           // mpl 单字母
  eq(parseColorName("tab:blue"), "#1f77b4");    // mpl tab:（"tab" 不是 category → 落回字典）
  eq(parseColorName("tab blue"), "#1f77b4");
  eq(parseColorName("blue"), "#0000ff");        // css 标准化石值压过 xkcd #0343df（user 点名对齐标准）
  eq(parseColorName("sky blue"), "#75bbfd");    // 带空格 = xkcd 写法 → 众包质心
  eq(parseColorName("skyblue"), "#87ceeb");     // 连写 = css 关键字写法 → css 值
  eq(parseColorName("月白"), "#eef7f2");
  eq(parseColorName("yuebai"), "#eef7f2");       // 拼音别名
  eq(parseColorName("あかねいろ"), "#b7282e");   // かな别名
  eq(parseColorName("laso"), "#0343df");         // tok 裸词首选 = 蓝
  eq(parseColorName("nicht eine farbe"), null);
  eq(parseColorName("#ff0000"), null);           // hex 不归本模块（调用方先走 normalizeHex）
});

test("色温：5600k 等直接算 Planck 黑体色（纯数学，parse/sense 都认）", () => {
  const d65 = kelvinToHex(6500);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(d65.slice(i, i + 2), 16));
  assert(r > 235 && g > 235 && b > 235, `6500K 应接近白: ${d65}`);
  const warm = kelvinToHex(2000);
  const [wr, , wb] = [1, 3, 5].map((i) => parseInt(warm.slice(i, i + 2), 16));
  assert(wr === 255 && wb < 120, `2000K 应显著偏暖: ${warm}`);
  // 蓝通道随色温单调不减（暖 → 冷）
  let prev = -1;
  for (const t of [2000, 3200, 4500, 5600, 6500, 9000]) {
    const bb = parseInt(kelvinToHex(t).slice(5, 7), 16);
    assert(bb >= prev, `蓝通道非单调 @${t}K`);
    prev = bb;
  }
  eq(parseColorName("5600k"), kelvinToHex(5600));
  eq(parseColorName("5600 K"), kelvinToHex(5600));
  const sense = searchColorNames("5600k");
  eq(sense.length, 1);
  eq(sense[0].name, "5600K");
});

test("`category:` 前缀 = 浏览整板（id/别名/label 都认，rest 再过滤，保持源序）", () => {
  eq(searchColorNames("zh-trad:").length, 526);          // 裸前缀 = 整板
  eq(searchColorNames("中国传统色:").length, 526);        // label 也认
  eq(searchColorNames("zh:").length, 526);               // 别名也认
  eq(searchColorNames("zh-trad:")[0].name, DATA.words.find((w: string[]) => w[0] === "zh-trad")![1]);   // 源序
  const bai = searchColorNames("zh:白");
  assert(bai.length > 5 && bai.every((x) => x.name.includes("白")), "类内过滤全含「白」");
  eq(parseColorName("css:blue"), "#0000ff");             // 类内精确取名
  eq(parseColorName("ja:茜色"), "#b7282e");
  eq(parseColorName("zh-trad:不存在的色"), null);         // 类内找不到不落回全字典
  eq(searchColorNames("notacat:x").length, 0);           // 未知 token 落回普通查询（无命中）
});

test("模糊匹配 + 词库 discovery：子序列命中、部分词库名出「label:」候选", () => {
  // 子序列（匹配尽量模糊）：「豆黄」→「豆汁黄」、"tblue" → "tab:blue"
  assert(searchColorNames("豆黄").some((x) => x.name === "豆汁黄"), "子序列命中丢了");
  assert(searchColorNames("tblue").some((x) => x.name === "tab:blue"), "去空格子序列丢了");
  // discovery：部分输入 category 名 → 候选置顶，选中回填（wheel 侧行为）
  const zg = searchColorNames("中国");
  assert(zg.length > 0 && zg[0].category === "zh-trad" && zg[0].name === "中国传统色:", `discovery 不对: ${JSON.stringify(zg[0])}`);
  assert(searchColorNames("xk")[0].category === "xkcd", "id 部分输入也该出词库候选");
});

test("普通联想：前缀优先/子串保底/别名命中/默认无上限", () => {
  const sky = searchColorNames("sky");
  assert(sky.some((x) => x.name === "skyblue") && sky.some((x) => x.name === "sky blue"));
  eq(searchColorNames("yueb")[0].name, "月白");
  const huang8 = searchColorNames("黄", 8);
  assert(huang8.some((x) => x.name.indexOf("黄") > 0), "尾缀命中被挤光");
  assert(huang8.some((x) => x.name.startsWith("黄")), "前缀命中也该在");
  assert(searchColorNames("黄").length > huang8.length, "默认应不设上限");
});

test("schema v2：任意深度树（子树语义）+ suppress（被动隐身/作用域可查/兄弟联想）", () => {
  _adoptColorWords({
    categories: [...DATA.categories,
      { id: "t-root", label: "测试合集", aliases: [], naming: false, default_for: [] },
      { id: "t-mid", label: "测试中层", aliases: [], naming: false, default_for: [], parent: "t-root" },
      { id: "t-pal", label: "天依板", aliases: ["天依"], naming: false, default_for: [], parent: "t-mid" },
      { id: "t-hidden", label: "噪音板", aliases: [], naming: false, default_for: [], parent: "t-root", suppress: true },
    ],
    words: [...DATA.words,
      ["t-pal", "天依蓝", "#66ccff"],
      ["t-pal", "髪", "#f0e0c0", "", 2],       // suppress 槽位词
      ["t-hidden", "noise", "#123456"],          // suppress 板里的普通词
    ],
  });
  // 子树浏览：根 = 全子树并集（含 suppress 词与 suppress 板——作用域内不隐身）
  eq(searchColorNames("t-root:").length, 3);
  eq(searchColorNames("天依:").length, 2);              // 板的别名直接可达（token 扁平，不嵌套）
  // suppress 词：全局裸名不可查、作用域可取
  eq(parseColorName("髪"), null);
  eq(parseColorName("t-pal:髪"), "#f0e0c0");
  assert(!searchColorNames("髪").some((x) => x.name === "髪"), "suppress 词漏进全局联想");
  // suppress 板：整板被动隐身、显式寻址照常、discovery 不出
  assert(!searchColorNames("noise").some((x) => x.name === "noise"), "suppress 板的词漏进全局联想");
  eq(parseColorName("t-hidden:noise"), "#123456");
  assert(!searchColorNames("噪音").some((x) => x.category === "t-hidden"), "suppress 板漏进 discovery");
  assert(searchColorNames("测试中层").some((x) => x.category === "t-mid"), "正常中层该可 discovery");
  // 兄弟联想：全局命中 天依蓝 → 板友 髪 追加在候选尾
  const hits = searchColorNames("天依蓝");
  assert(hits.some((x) => x.name === "天依蓝") && hits.some((x) => x.name === "髪"), "兄弟联想没带出板友");
  // 子树命名：suppress 词/板都不参与，nearest 只剩 天依蓝
  eq(colorNameIn("t-root", 0x66, 0xcc, 0xff), "天依蓝");
  eq(colorNameIn("t-root", 0x12, 0x34, 0x56), "天依蓝");   // noise(#123456) 被隐身，不许当选
  _adoptColorWords(DATA);   // 还原，别污染其它测试
});
