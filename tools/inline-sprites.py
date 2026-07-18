#!/usr/bin/env python3
"""把 SVG sprite 内联进 index.html 的标记区。

为什么要内联而不是 <use href="assets/icons.svg#id">：
  file:// 下外部 use 被跨域规则挡死（PWA 要能当裸静态页打开）。且内联零 JS、零请求。

为什么要这个脚本而不是手贴：
  assets/icons.svg 是 extract-icons.py 的生成物。手贴一次之后，谁重跑 extract、
  index.html 就悄悄陈旧了，且没有任何机制会报错。这个脚本让「重新贴」变成一条命令。

自愈规则（重要）：
  webpaint_legacy.svg 里的 symbol，凡是 id 已经在 assets/icons.svg 里出现的，一律丢弃。
  也就是说：某个图标被美工画进共享库、重跑 extract 之后，legacy 里那份副本自动失效，
  宿主的 <use href="#name"> 一个字都不用改。把图标画进库 == 删掉 legacy 一条。

用法：
  python3 tools/inline-sprites.py          # 贴
  python3 tools/inline-sprites.py --check   # 只检查是否已是最新（CI/提交前用），不写文件
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
LIB = ROOT / "assets" / "icons.svg"
LEGACY = ROOT / "assets" / "webpaint_legacy.svg"

BEGIN = "<!-- ICON-SPRITE:BEGIN — 由 tools/inline-sprites.py 生成，勿手改 -->"
END = "<!-- ICON-SPRITE:END -->"

SYMBOL_ID = re.compile(r'<symbol\s+id="([^"]+)"')


def inner(svg_text: str) -> str:
    """剥掉最外层 <svg …> </svg>，留内容。"""
    start = svg_text.index(">", svg_text.index("<svg")) + 1
    end = svg_text.rindex("</svg>")
    return svg_text[start:end].strip("\n")


def split_symbols(body: str):
    """切成 [(id or None, chunk)]，注释/空白归到紧随其后的 symbol 前面那块。"""
    out, pos = [], 0
    for m in re.finditer(r"<symbol\b.*?</symbol>", body, re.S):
        if m.start() > pos:
            out.append((None, body[pos:m.start()]))
        sid = SYMBOL_ID.search(m.group(0))
        out.append((sid.group(1) if sid else None, m.group(0)))
        pos = m.end()
    if pos < len(body):
        out.append((None, body[pos:]))
    return out


def build() -> tuple[str, list[str]]:
    lib_body = inner(LIB.read_text(encoding="utf-8"))
    lib_ids = set(SYMBOL_ID.findall(lib_body))

    kept, dropped = [], []
    # legacy 逐 symbol 过滤：库里已有同名 → 丢弃（连它前面的注释块一起丢）
    pending_comment = ""
    for sid, chunk in split_symbols(inner(LEGACY.read_text(encoding="utf-8"))):
        if sid is None:
            pending_comment = chunk
            continue
        if sid in lib_ids:
            dropped.append(sid)
            pending_comment = ""
            continue
        kept.append(pending_comment + chunk)
        pending_comment = ""

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">']
    parts.append("<!-- 共享库子集（20260708 SVG Icons，extract-icons.py 生成） -->")
    parts.append(lib_body)
    if kept:
        parts.append("<!-- WebPaint 本地补丁（assets/webpaint_legacy.svg，库里还没有的） -->")
        parts.extend(kept)
    parts.append("</svg>")
    return "\n".join(parts), dropped


def main() -> int:
    check = "--check" in sys.argv
    sprite, dropped = build()
    html = HTML.read_text(encoding="utf-8")

    if BEGIN not in html or END not in html:
        print(f"✗ index.html 里找不到标记区。请先手工插入这两行到 <body> 顶部：\n  {BEGIN}\n  {END}")
        return 2

    head, rest = html.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    new = head + BEGIN + "\n" + sprite + "\n" + END + tail

    lib_n = len(SYMBOL_ID.findall(sprite))
    if new == html:
        print(f"✓ index.html 已是最新（{lib_n} 个 symbol）")
    elif check:
        print(f"✗ index.html 的 sprite 已陈旧，请跑 python3 tools/inline-sprites.py")
        return 1
    else:
        HTML.write_text(new, encoding="utf-8")
        print(f"✓ index.html ← {lib_n} 个 symbol 已内联")

    if dropped:
        print(f"↳ legacy 里 {len(dropped)} 个已进共享库，自动丢弃：{' '.join(dropped)}")
        print("  （可以把它们从 assets/webpaint_legacy.svg 里删掉了）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
