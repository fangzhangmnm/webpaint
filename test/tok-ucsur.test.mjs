// v0.5.35 tok→UCSUR 转写：四条件真值表 + 反引号 escape + 参数跨度保护（规则=与 Toki Pona repo linter 同一份）。
import { test, eq } from "./runner.mjs";
import { tokGlyphs, stripTokMarkup } from "../src/i18n/ucsur.ts";
import ucsurMap from "../vendor/toki-pona/ucsur-map.json" with { type: "json" };

const G = (w) => ucsurMap[w];

test("[tok-ucsur] 词表命中转写、词表外保留拉丁", () => {
  eq(tokGlyphs("weka e pali"), `${G("weka")} ${G("e")} ${G("pali")}`, "纯 tp 全转");
  eq(tokGlyphs("dev"), "dev", "词表外小写保留（乱码问题的根治对象）");
  eq(tokGlyphs("nasin dev"), `${G("nasin")} dev`, "混排各归各");
});

test("[tok-ucsur] 条件③：紧邻字母/数字/连字符不转", () => {
  eq(tokGlyphs("v124a"), "v124a", "版本串里的孤立字母不转");
  eq(tokGlyphs("4.0.2a"), "4.0.2a", "数字后缀不转");
  eq(tokGlyphs("nasin-nanpa"), "nasin-nanpa", "连字符词不转");
  eq(tokGlyphs("PNGa"), "PNGa", "大写接小写整体豁免");
});

test("[tok-ucsur] 大写词豁免；反引号显式拉丁（标记剥离）", () => {
  eq(tokGlyphs("Blender sync"), "Blender sync", "大写起头整词豁免");
  eq(tokGlyphs("`toki` sync"), "toki sync", "反引号内词表词也保留拉丁，标记剥掉");
  eq(stripTokMarkup("`toki` sync"), "toki sync", "latin 模式同样剥标记");
});

test("[tok-ucsur] {param} 跨度原样（用户数据绝不被转写）", () => {
  eq(tokGlyphs("{name} li pona"), `{name} ${G("li")} ${G("pona")}`, "占位保留、其余照转");
  eq(tokGlyphs("sitelen {n}"), `${G("sitelen")} {n}`, "尾参保留");
});
