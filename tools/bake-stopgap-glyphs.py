#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stopgap 字形烤制：中文字/短文本 → 轮廓 path 的补丁 sprite（assets/icons-local.svg）。
库里还没有的图标先用字形顶位（旧协议）；烤成轮廓 = 不依赖设备字体、无豆腐块。
改 SPECS 后在仓库根跑 python3 tools/bake-stopgap-glyphs.py，再跑 tools/inline-sprites.py。
真图标进库后：重跑 extract + inline（同名自动让位），并从 SPECS 删掉该条重烤。
字体：系统 DroidSansFallbackFull（Apache-2.0，CJK）/ DejaVuSans-Bold（Bitstream Vera，数字°）。"""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.misc.transform import Transform

FONTS = {'cjk': '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', 'sans': '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'}
_fts = {}
def fontfor(name):
    if name not in _fts:
        ft = TTFont(FONTS[name], lazy=True)
        _fts[name] = (ft.getGlyphSet(), ft.getBestCmap())
    return _fts[name]

def text_path(text, box, font='cjk'):
    gs, cmap = fontfor(font)
    glyphs = []; cx = 0
    minx = miny = 1e9; maxx = maxy = -1e9
    for ch in text:
        g = gs[cmap[ord(ch)]]
        bp = BoundsPen(gs)
        g.draw(TransformPen(bp, Transform(1, 0, 0, 1, cx, 0)))
        if bp.bounds:
            b = bp.bounds
            minx = min(minx, b[0]); miny = min(miny, b[1])
            maxx = max(maxx, b[2]); maxy = max(maxy, b[3])
        glyphs.append((g, cx)); cx += g.width
    w = maxx - minx; h = maxy - miny
    bx, by, bw, bh = box
    s = min(bw / w, bh / h)
    tx = bx + bw / 2 - s * (minx + maxx) / 2
    ty = by + bh / 2 + s * (miny + maxy) / 2   # svg y 朝下：y = -s*y_font + ty
    out = []
    for g, cx0 in glyphs:
        pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip('0').rstrip('.'))
        g.draw(TransformPen(pen, Transform(s, 0, 0, -s, tx + s * cx0, ty)))
        c = pen.getCommands()
        if c: out.append(c)
    return ' '.join(out)

# (id, 文字, 盒, 语义 note)
SPECS = [
    # 2026-08-21 图标收货：cut（剪刀 CCW145）/copy-picture（copy+画片，原登记名 copy-merged 甲方定名改之）
    # 两枚真图入库（库仓 5976d20），stopgap 再度**清零**。历史见 git。
    # 注意：收货同时 index.html 的 <use href="#copy-merged"> 已改 #copy-picture（id 随甲方定名走）。
    # 2026-08-21 图标收货（第二轮）：add-to-home-screen 真图入库（库仓 b62c33a，甲方拍板候选 1 号
    # = iOS 原味：圆角方框 16 见方 rx4.6 + 居中加号 7.2）。中文「装」stopgap 撤除，stopgap 再度清零。
]
syms = []
for sid, text, box, note in SPECS:
    d = text_path(text, box[:4], box[4] if len(box) > 4 else 'cjk')
    syms.append(f'  <symbol id="{sid}" data-cat="stopgap" data-src="baked:DroidSansFallbackFull(Apache-2.0)/DejaVuSans-Bold(Bitstream-Vera)" data-note="{note}" viewBox="0 0 24 24"><path d="{d}" fill="currentColor" stroke="none"/></symbol>')

HEADER = '''<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none">
<!-- WeebPaint 本地 stopgap 补丁 sprite —— 共享库（20260708 SVG Icons）里还没有的图标先用
     【中文字烤成轮廓 path】顶位（旧协议：占地不解决 pictogram，每条都是过渡态待真图形）。
     字形烤自系统 DroidSansFallbackFull（Apache-2.0），不依赖设备字体，无豆腐块。

     机制（自愈）：tools/inline-sprites.py 把本文件与 assets/icons.svg 合并内联；
     assets/icons.svg（上游钉死拷贝）里已有同名 symbol 时，本文件的副本【自动让位】。
     即：图标画进库 → 重跑 extract + inline → 这里对应条目失效，宿主 <use> 一字不改。

     需求登记：全局清单 ../20260708 SVG Icons/TODO.md（美工 agent 的取活处）。
     重新烤制：仓库根跑 python3 tools/bake-stopgap-glyphs.py（SPECS 即声明）。
-->
'''
open('assets/icons-local.svg', 'w', encoding='utf-8').write(HEADER + '\n'.join(syms) + '\n</svg>\n')
print("baked", len(syms), "symbols")

# 渲一眼（家规：别盲画）
import cairosvg
prev = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 96 24"><rect width="96" height="24" fill="#fff"/>'
for i, (sid, text, box, note) in enumerate(SPECS):
    d = text_path(text, box[:4], box[4] if len(box) > 4 else 'cjk')
    prev += f'<g transform="translate({i*24},0)"><rect width="24" height="24" fill="none" stroke="#ccc" stroke-width="0.2"/><path d="{d}" fill="#000"/></g>'
prev += '</svg>'
cairosvg.svg2png(bytestring=prev.encode(), write_to='/tmp/glyphs-preview.png', output_width=480)
print("preview written")
