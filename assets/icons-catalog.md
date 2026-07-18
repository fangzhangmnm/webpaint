# 本 app 的图标

56 icons · 提取自家族图标库 `../../../../20260708 SVG Icons/icons.svg` · 由 `extract-icons.py` 生成，别手改。

用法：把 sprite 内联到 `<body>` 顶部（它是 `display:none`），然后按 id 引用；
颜色跟随 CSS `color`（全部 `currentColor`）：

```html
<!-- 内联 icons.svg -->
<svg width="24" height="24"><use href="#eraser"/></svg>
```


## tool

| name | 说明 |
|------|------|
| `eraser` | tool.eraser |
| `eyedropper` | tool.picker |
| `hand` | 手/抓取:食指左线裁到与拇指指尖弧交点 y=11.44,不再穿出 |
| `lasso` | tool.lasso |
| `magic-wand` | la.magic |
| `move` | 四向移动箭头 (move tool, for SketchUp-clone) |
| `pencil` | 铅笔 Bootstrap Icons MIT |

## image-processing

| name | 说明 |
|------|------|
| `brush-width` | 笔刷宽度:平行两条波浪(标准1.7/粗3.4) |
| `color-palette` | 调色板:BI palette 身体(MIT)+四点非均匀,下方留空 |
| `fx` | 滤镜/调整 fx (WebPaint topAdjustBtn) |
| `sliders` | 不写类别 |
| `transparency` | L.opacity |

## transform

| name | 说明 |
|------|------|
| `flip-horizontal` | 水平翻转 |
| `rotate-ccw` | 逆时针旋转+轴 (WebPaint 在用) |
| `scale-uniform` | 等比缩放(正方框+小方虚线) |

## selection

| name | 说明 |
|------|------|
| `select-all` | la.selectAll |
| `select-ellipse` | la.ellipse |
| `select-freehand` | la.freehand |
| `select-rectangle` | la.rect |
| `selection-clear` | la.deselect |
| `selection-difference` | 差集:后框被前框 mask 遮挡(留 gap)+减号 |
| `selection-expand` | la.selEdit |
| `selection-invert` | la.invert |
| `selection-new` | 虚线方框+加号 |
| `selection-union` | 并集:后框被前框 mask 遮挡(留 gap)+加号 |

## edit

| name | 说明 |
|------|------|
| `arrow-redo` | action.redo |
| `arrow-undo` | action.undo |
| `move-to-layer` | 文件+绕行箭头(移到新层) |
| `trash-can` | 垃圾桶 |

## file

| name | 说明 |
|------|------|
| `export` | rack.exportFolder |
| `floppy-disk` | 本地已保存但云端没动 |
| `folder` | ref.load |
| `folder-open` | 打开的文件夹:背板止于盖顶 T 接,不再互相压线 |
| `import` | rack.importJson |
| `new` | gal.chrome.add |

## hierarchy

| name | 说明 |
|------|------|
| `collection` | 收纳箱 (Blender collection · copy of archive-box) |
| `layers-stack` | tool.layers |
| `lock` | 锁:体 13x11+锁梁抬高(腿3.5),整体居中 |
| `unlock` | 开锁:同 lock 体型+锁梁弹开 |
| `visibility-hide` | 隐藏:同一只眼+斜杠(mask 留 gap),与 show 成对 |
| `visibility-show` | 可见:实心大瞳孔(r3.4)+眼睑收小+上眼睑加宽(2.2) |

## common

| name | 说明 |
|------|------|
| `chevron-down` | lp.foot.down |
| `chevron-up` | lp.foot.up |

## cloud

| name | 说明 |
|------|------|
| `cloud` | 云 |
| `cloud-synced` | 云+勾 |
| `cloud-unavailable` | — |
| `cloud-upload` | rack.cloudPush |
| `download` | 下载 |
| `refresh` | cloud.refresh |
| `upload` | 上传 |

## globalization

| name | 说明 |
|------|------|
| `globe-speech` | 语言=地球+对话气泡(mask 抠洞遮挡,留 gap) |

## viewport

| name | 说明 |
|------|------|
| `maximize` | ref.fit |
| `picture-in-picture` | ref.live |

## ui

| name | 说明 |
|------|------|
| `archive-box` | nav.trash |
| `database` | — |
| `menu` | tool.menu |
