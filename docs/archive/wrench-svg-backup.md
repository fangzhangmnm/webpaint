# 扳手 SVG 备用（v124 user 撤掉，留这里供以后想换回去时复用）

v120 加在 menu 导入/导出 旁边的扳手图标，v124 user 觉得"⋯"更合适做"展开配置"
语义（同图层 ⋯ menu 习惯）。

如果以后想换回扳手或在新地方用，原 SVG：

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
</svg>
```

风格：单 path，stroke-only，跟其他工具 icon 一致。
