# 0.4 batch 2 · S9 —— 日落 + 改名 + 体重合同（施工报告）

> as-of v0.4.10 / 2026-07-22。上游：`docs/20260722-v04-s7-session-handoff.md` §S9、
> batch1-handoff §4-S9。分支 `worktree-v04-s8-s9-edit-migration`。
> 838 node + tsc + SwiftShader smoke 全绿。

## 1. 落了什么

1. **layer-composite.ts 全删**（S9a）：生产合成只剩一个引擎（GL render-tree）。新 30 行注入面
   `src/doc-render.ts`（app.ts 接 board.compositeNodesToCanvas）承接全部旧消费者：
   - ora `mergedimage.png`/`Thumbnails`：encode 收 `opts.mergedCanvas`，由 session-state 在
     **freeze 同一同步刻**从活 doc GL 渲出 → mergedimage/缩略图/层数据三者一致；
     GL lost 的 autosave 兜透明占位（层数据完整，不阻塞落盘）。
   - 导出 png/jpg（含「仅当前层」，剥自身 clippingMask = 旧 ignoreSelfClip 语义）、剪贴板、
     打印、Blender 推拉、PSD merged 通道、图库缩略图（renderThumbBlob → thumbBlobFromCanvas）。
   - 参考窗镜像：手抄扁平合成删（漏组漏 clip 的那份）→ GL + 300ms 节流。
2. **GL 树递归对拍参照归档**（S9a）：GLCompositor.composite()/_composeFresh/_applyNodes +
   gl-compose-plan.ts（CompNode/clip 判定）+ docTreeToComp → `test/gl-smoke/
   reference-gl-compositor.ts`；layer-composite → `test/gl-smoke/reference-2d.ts`。
   **对拍能力零损失**（smoke 的 vs-compositeLayers diff 全在），生产 src 零调用；
   build.sh 防复活 lint（src 禁 import 两死模块）。
3. **改名归位**（S9b）：`editor-state.ts` → `workbench-state.ts`（ORA 内
   `.webpaint/editor-state.json` key 不动，向后兼容）；`gl/tile-pixels.ts` →
   `tiles/tile-layer.ts`（纯 tile 门面非 GL 专属）。
4. **死码清理**（S9c）：LayerPixels 的 dirty 跟踪机器整套（S7 起 GL 增量走 contentVersion +
   句柄身份，零消费者）、BBOX_GROW_MARGIN、coordKey、iconEl、role="liquify" 死双轨（S8b 已删）、
   一批写而不读的 ctx 绑定（tsc noUnusedLocals 扫）。

## 2. 体重合同（诚实交代：**没达标**）

秤 = `python3 tools/count-src-loc.py`（实质行：src 非 vendor，剔空行纯注释）。

| 点位 | 实质行 |
|---|---|
| 纪元开工 v0.4.0 (895fd20) | **23,280** |
| 本棒接手 v0.4.8 (3d1d7b8) | 24,658 |
| S8 完工 v0.4.9 | 24,727（+GPU commit/冻结快照/pickColor 三大件，−双轨/board 缓存 cluster） |
| S9 完工 v0.4.10 | **24,384** |
| 合同目标 | ≤23,280 —— **差 1,104 行** |

S8+S9 本棒净 −274（vs 接手时）；S9 单独净 −343。点名对象**全部执行**：

- layer-composite.ts 301 行 → src 0（归档 test 域）✅
- reference.ts 手抄扁平合成 ✅（该文件其余 540 行是参考窗 UI/手势，活的）
- GLCompositor 树递归 + gl-compose-plan ✅（归档）
- board.ts 旧显示路径/合成缓存/hint 机器 ✅（S8c/S8e，board 978→668）
- brush 旧栅格 commit 路径 ✅（S8a，brush 423→392）
- 改名 ×2 ✅；防复活 lint ✅

**没砍到的 1,104 在哪、为什么砍不动（逐项）**：

1. **纪元净增的主体是 spec 钦点的新管线本体**，不是旧代码：对 v0.4.0 逐文件 diff，增量集中在
   render-tree-gl(+506)、workpiece 四件套(+966)、tiles 池/压缩/门面(+633)、render-plan(+157)、
   gpu-tile-pool(+227)、bg-jobs(+66)、marching-ants(+90)——全部活役。被它们替死的旧管线
   （history/pixel-edit/layer-undo/tile-residency/tile-store/tile-index/tile-backend/
   gl-doc-renderer/layer-composite/gl-compose-plan/editor-state 旧半身 ≈ −1,700）**已在
   S1–S9 逐批删完**。「净增清零」要求新机器体积 ≤ 被替旧机器体积——现实是新渲染/undo/池
   机器比旧的大一圈（它们多扛了：配额 undo、后台压缩、段缓存、自愈、冻结快照）。
2. **src/store/ 4,043 行在秤内但是红线区**：家规不碰 + 与 JRP byte-identical 收敛在途，
   本 slice 无权动（即便里面有可省的）。
3. **其余大文件均过审无成建制死管线**：input(980)/board(668)/floating-transform(764)/
   lasso(405)/selection(540)/filters 家族(1,087)/UI(1,559)/i18n(814)/session-state(583)——
   活功能、手感红线、或翻译数据。剩余 Canvas2D 使用（像素笔 stamp、选区填充、滤镜
   ImageData、psd/import 读写）都已收缩在绘制/import/export 边界，spec 附录允许。
4. **口径禁止凑数**：注释已被秤排除，压行/删注释无效也不做。

**结论**：要再砍 1,100 行需要新的产品级决策（例：砍活功能、动 store、或对 input/floating-
transform 这类手感相邻区做超出本棒授权的深切）。留给人类拍板，不糊弄。

## 3. 遗留 / 下一棒

- 真机总批（总单 §0–§11，对水印 ≥ v0.4.10）= 纪元收尾。
- 拍板累积清单：见 `docs/20260722-v04-s8-s9-session-handoff.md`。
- spec 已列未做（按 handoff 授权范围外）：液化/滤镜笔迁 GPU（spec:207「现在可以先 cpu 算」）、
  选区 per-tile GPU 池（等真机数据）、#4 frozen/tail GPU 缓存、workbench-session 重组
  （用户亲自）、reference-gallery 归属（spec:26 留空）。
