#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 src/color-words.ts —— **全语言统一色词表 COLOR_WORDS**（2026-07-30 user 拍板）。

行 = [类别, 名, hex, 别名(かな/拼音)?, slang?]；**行序 = parse 优先级**（universal → 小众）：
  mpl（matlab 单字母 / tab: 配色——单独类别，en 命名不误取）> css（CSS4 标准关键字）
  > en（xkcd 全表 949，slang 打 flag：parse 照认、命名跳过）> zh（中国传统色 526 + 拼音别名）
  > ja（和色大辞典 462 + かな别名）> tok（手工小表，本文件 TOK 列表维护）。

命名（colorNameOf）= 同一张表按 UI 语言过滤（mpl/css 永远不是 UI 语言 → 天然不参与命名）。
**以后加语言只加行不改码**：消费端（color-name.ts）按类别字符串泛化过滤/建索引，零 special-case。

数据源（全部 vendored，重生成不需网络）：
  · matplotlib.colors（XKCD_COLORS / CSS4_COLORS / TABLEAU_COLORS / BASE_COLORS）
  · vendor/color-words/zhongguose-colors.json（快照自 zhongguose.com/colors.json，含拼音）
  · vendor/color-words/colordic-wa-colors.json（快照自 colordic.org 和色大辞典 /w 页，含かな）
改词库 = 改快照/本文件列表后重跑：python3 tools/gen-color-words.py
"""
import json, io, re, pathlib
import matplotlib.colors as mc

ROOT = pathlib.Path(__file__).resolve().parent.parent
V = ROOT / "vendor" / "color-words"

# toki pona 小表（手工维护，不依托英语）。tok 只规定**词**不规定色值，也没有权威 tok 色值数据集
# —— 锚点色值借 xkcd 众包质心当原型值（"大家说 loje 时指的色"的最好可得近似）。
# 一个词可挂多个原型锚点（laso 语义同时盖蓝绿 → 各一票）；同词首行 = 裸词 parse 时给的值。
TOK = [
    ("loje", "#e50000"),              # 红
    ("loje jelo", "#f97306"),         # 橙
    ("jelo", "#ffff14"),              # 黄
    ("laso", "#0343df"),              # 蓝——裸 laso 的 parse 首选
    ("laso", "#15b01a"),              # 绿——同词第二锚点
    ("laso jelo", "#aaff32"),         # 黄绿
    ("laso kasi", "#5ca904"),         # 草木绿（kasi=植物）
    ("laso telo", "#029386"),         # 水色/青（telo=水）
    ("laso sewi", "#75bbfd"),         # 天蓝（sewi=天）
    ("laso pimeja", "#00035b"),       # 深蓝
    ("laso pimeja", "#033500"),       # 深绿
    ("laso walo", "#d0fefe"),         # 淡蓝
    ("laso walo", "#c7fdb5"),         # 淡绿
    ("loje laso", "#7e1e9c"),         # 紫
    ("loje laso", "#c20078"),         # 品红
    ("loje laso walo", "#c79fef"),    # 浅紫
    ("loje laso pimeja", "#35063e"),  # 深紫
    ("loje walo", "#ff81c0"),         # 粉
    ("loje pimeja", "#653700"),       # 棕
    ("loje pimeja", "#840000"),       # 深红
    ("jelo pimeja", "#6e750e"),       # 橄榄
    ("jelo pimeja", "#ceb301"),       # 芥末
    ("jelo walo", "#e6daa6"),         # 米黄
    ("walo", "#ffffff"),              # 白
    ("walo pimeja", "#929591"),       # 灰
    ("pimeja", "#000000"),            # 黑
]

SLANG = re.compile(r"shit|poop|poo\b|puke|vomit|diarrh|snot|booger|barf|bile|piss|pee\b|urine|ugly")

def f2h(t):
    return "#" + "".join(f"{round(c*255):02x}" for c in t)

rows = []  # (cat, name, hex, alias, slang)
for k, v in mc.BASE_COLORS.items():
    rows.append(("mpl", k, f2h(v), "", 0))
for k, v in mc.TABLEAU_COLORS.items():
    rows.append(("mpl", k, v.lower(), "", 0))
for k, v in mc.CSS4_COLORS.items():
    rows.append(("css", k, v.lower(), "", 0))
xkcd = [(k[5:], v.lower()) for k, v in mc.XKCD_COLORS.items()]
xkcd.reverse()   # 热度降序（原文件升序）——同类别内先到先得
for n, h in xkcd:
    rows.append(("xkcd", n, h, "", 1 if SLANG.search(n) else 0))
for c in json.load(io.open(V / "zhongguose-colors.json", encoding="utf-8")):
    rows.append(("zh-trad", c["name"], c["hex"].lower(), c["pinyin"], 0))
for name, kana, h in json.load(io.open(V / "colordic-wa-colors.json", encoding="utf-8")):
    rows.append(("ja-trad", name, h, kana, 0))
for n, h in TOK:
    rows.append(("tok", n, h, "", 0))

def esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')

def row_ts(cat, name, hexv, alias, slang):
    t = f'  ["{cat}", "{esc(name)}", "{hexv}"'
    if slang:
        t += f', "{esc(alias)}", 1'
    elif alias:
        t += f', "{esc(alias)}"'
    return t + "]"

counts = {}
for r in rows:
    counts[r[0]] = counts.get(r[0], 0) + 1

out = f'''// 生成物 —— 勿手改，改 tools/gen-color-words.py（含 tok 手工小表）/ vendor/color-words/ 快照后重跑。
// 全语言统一色词表：行 = [类别, 名, hex, 别名(かな/拼音)?, slang?]。
// **行序 = parse 优先级**（mpl > css > en > zh > ja > tok，universal → 小众；同类别内 = 热度/表序）。
// 命名按用户选的 culture 过滤本表（默认按 UI 语言映射；slang 行 parse 照认、命名跳过）。
// 加新 culture = 只加行（消费端零 special-case）。档目：{" · ".join(f"{k} {v}" for k, v in counts.items())}

/** 类别 = 命名 culture（或技术命名空间 mpl/css）。加新 culture 直接扩这个联合 + 加行。 */
export type ColorWordCat = "mpl" | "css" | "xkcd" | "zh-trad" | "ja-trad" | "tok";
/** [类别, 名, hex, 别名(かな/拼音)?, slang?] */
export type ColorWordRow = [ColorWordCat, string, string, string?, (0 | 1)?];

export const COLOR_WORDS: ColorWordRow[] = [
{",\n".join(row_ts(*r) for r in rows)},
];
'''
io.open(ROOT / "src" / "color-words.ts", "w", encoding="utf-8").write(out)
print("wrote src/color-words.ts:", len(out.encode()), "bytes ·", counts)
