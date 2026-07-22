# 0.4 batch 2 · S5 —— 选区 tile 化 + 蚂蚁线深模块（施工报告）

> as-of v0.4.6 / 2026-07-22。上游：`docs/20260722-v04-batch1-handoff.md` §4-S5、spec `journal/20260721 Architecture.md`（:18、:208-210、:255）。
> 落在分支 `worktree-v04-s5-selection-tiles`（e981b78 源 + 3752d7c bundle），**未 merge main、未真机**。

## 1. 落了什么

### selection.ts 重写（maskCanvas 死）
- `Selection` 仍是**不可变值对象**（null = 无选区，消费面约定不变），底座从「bbox 对齐的 RGBA
  maskCanvas」换成 **doc 网格对齐的稀疏 gray8 tile**（`Map<packedKey, TileHandle>`，池 = 共享
  `appTilePool()` → 选区自动吃 S3 的后台压缩驻留；undo 里按压缩字节计费）。
- **doc 空间寻址**是 H7（液化选区按 layer.bbox 烤半拉）的数据结构前提——本片只落数据结构，
  液化仍按 layer.bbox 烤（有意保留，见 §4）。
- **所有权纪律**（对齐 batch 1 的 LayerSnap 模式）：`clone()` 零拷贝别名（句柄 acquire）、
  `dispose()` 释放；双 dispose / use-after-dispose 立刻 throw；漏网由池 FR assert 点名。
  持有点：`doc.selection` 槽、SwapSelectionOp 包、`doc.snapshotAll` 快照（现在存 clone 不存裸引用，
  restore 装 clone）、lasso/toolbar 中间产物（消费即弃）。瞬时读者（stroke 引擎、GL 上传）不持有。
- 窄读口：`materializeMaskRegion(x,y,w,h)`（gray8 平面）、`sampleAt`、`bboxMask()`（bbox 对齐
  gray8，懒缓存，GL 直传用）、`materializeMaskCanvas()`（RGBA 白+alpha 物化，懒缓存——剩余
  Canvas2D 消费者的过渡口，S8/S9 收缩时日落）。
- 布尔组合 **per-tile**：union/subtract/intersect 的 AA 公式逐像素对齐旧 Canvas2D 合成
  （src-over/dst-out/dst-in；无对手格时 acquire 共享原 tile，不拷贝）。invert/morph/五个 doc 变换
  走 region 物化（对齐 LayerPixels 先例；resample 仍用 Canvas2D drawImage 当缩放器）。

### marching-ants.ts 新深模块
outline 算法（marching squares + 链化，v113 clamp 行为）原封搬出 selection.ts；缓存自持
（WeakMap keyed by Selection 对象身份——不可变 → 换选区必换对象，自失效）。
**与施工图的一处有意分歧**：施工图写「重算走 background-sync-jobs」，实际保留**同步首算**——
选区一变下一帧就要画蚂蚁线，异步化只会闪空；旧版同为同步 O(bbox)，iPad 实测扛得住。
大 doc 若真卡，再切片化（模块边界已就位，改内部即可）。

### GPU mask 直传（S7 前的临时形态）
- `StampOverlayInput.selMask` 从 canvas 换 `{data: Uint8Array(gray8), ox,oy,ow,oh}`（board 从
  `sel.bboxMask()` 取缓存 buffer）。
- gl-doc-renderer：`texImage2D(R8, …, RED, UNSIGNED_BYTE, data)` + `UNPACK_ALIGNMENT=1`
  （gray8 行宽任意，默认 4 会读歪）；**同 buffer 身份不重传**（旧版每帧重传 canvas，白干）；
  context-loss 恢复时弃 `_selTex`/`_selTexSrc` 重建。
- blend-glsl：`texture(u_ovSel, suv).a` → `.r`。
- S7 落 cpu-gpu-tile-bridge 后改 per-tile 上传。

### 消费面迁移（12 文件）
- filters.ts / filters-adjust.ts / 全部 filter 插件：mask 参数从 RGBA（`mask[o+3]`）换 gray8
  （`mask[o>>2]`）；brush 路径 `selData` 直取 `materializeMaskRegion`。
- liquify-engine.ts：mask 烤制走窄读口（gray8 索引），**bbox 对齐语义原样保留**（H7 见 §4）。
- floating-transform / selection-ops / 剪贴板：drawImage 换 `materializeMaskCanvas()`；
  lift 的本地隐式全选（`Selection.full`）用完即 dispose。
- lasso：freehand/ellipse 仍用 Canvas2D 光栅（AA vetted）→ `fromAlphaCanvas` 入库；rect 直建
  （整数硬边）；魔术棒 flood 结果**直转 gray8 tile**（canvas 中转死）；clip-to-doc 走 `croppedTo`。
- toolbar 扩缩预览（transient，不走 operator）：每次预览产物 dispose 上一个；cancel 弃预览还原 before。
- SwapSelectionOp：`estimateQuotaBytes` 按压缩字节/refCount（同 LayerSnap 规），`disposeData`
  释放包内 Selection；DocTransformOp 释放快照选区。
- build.sh 分层 lint 新增：selection.ts / marching-ants.ts 不 import gl/**、store。

## 2. 有意的行为变化（真机注意）

1. **bbox 恒紧**（per-tile bbox 聚合）：旧版 compose 的 bbox「可能略大」（有 TODO）、收缩 morph
   沿用原 bbox、offsetWrapped bbox=整幅——现在一律紧内容框。消费面只拿 bbox 当提取范围，紧=同或更好。
2. **subtract 减光 → null（选区消失）**：旧版留一个全透明「隐形选区」（蚂蚁线空但 hasSelection=true，
   笔画会被 mask 全裁）。新版按 tile bbox 精确判空 → 诚实回「无选区」。
3. 反选到全空同理 → null。

## 3. 真机待验（并入 batch 1 §3 清单，同批交付）

- 四种圈选（freehand/rect/ellipse/魔术棒）× 四种集合模式（新建/并/减/交），蚂蚁线形状与旧版一致
  （尤其 AA 边：椭圆边缘、魔术棒半透明停线）。
- 选区扩张/收缩 modal：实时预览、应用/取消、undo。
- 减光选区 → 蚂蚁线消失且「取消选区」按钮态正确（行为变化 §2.2）。
- 带选区的描边（GL live 预览裁剪 = R8 直传路径）+ 抬笔 applyMaskPostStroke；选区外必须一像素不动。
- 填充/清除/选区转新层/复制粘贴/浮层变换（lift→拖→stamp→commit→undo 整链）。
- 液化带选区（行为应与 v0.4.5 一致，含 H7 的旧 bug 也一致——别误报「修了」）。
- crop/flip/rotate/resample/offset 带选区 + undo（快照 clone 路径）。
- 长 session 后 console 无 `[tile-pool] … GC'd without release` 刷屏（选区所有权链漏网检测）。
- 切后台/context-loss 后带选区继续画（`_selTex` 重建路径）。

## 4. 遗留 / 挂线

- **H7 RED ×3**（`test/selection-tiles.test.mjs` 尾部 todo）：液化 mask 仍按 layer.bbox 烤。
  S8 液化重写（doc 空间 mask 采样）转绿。
- 蚂蚁线 bg-jobs 切片重算：暂缓（同步保留，理由见 §1）；S7/S8 大 doc 实测卡再做。
- brush GPU mask 为 bbox 整平面直传；S7 bridge 化改 per-tile。
- `materializeMaskCanvas()` 是 Canvas2D 消费者（filters apply/浮层 lift/剪贴板）的过渡口，
  S8/S9 收缩 Canvas2D 残余时日落。

## 5. 工程备注

- worktree 无 node_modules：本次施工用 `ln -s` 指回主 checkout 的 node_modules（**未入 git**，
  完工已删）。在 worktree 跑 `npm test`/`npx tsc` 前需重做这一步，或照 handoff §2.5 手动跑。
- 测试：789 绿 + 3 todo（新 `test/selection-tiles.test.mjs`；selection-morph / doc-offset /
  doc-rotate 适配紧 bbox 语义 + dispose 卫生）。AA 与旧 canvas 路径的逐像素对拍无法在 node 做
  （node 无真 canvas）——公式按合成定义写死 + 单元锚点（128∪128=192），视觉 parity 归真机批。
