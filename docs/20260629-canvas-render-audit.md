# 全库 Canvas2D 用途审计 —— 确认无遗留 display 渲染路径

> as-of v355 / 2026-06-28。审计结论（耐老化）：**GL 是唯一 display 路径，全库无任何「把图层内容合成到可见 canvas」的 Canvas2D 残留**。优化前给 fresh agent 的地基保证——别去优化死的 CPU 路径。
> 方法：subagent 全仓 grep `getContext("2d")` / `drawImage` / `putImageData` / `createElement("canvas")` / `OffscreenCanvas` / `compositeLayers`，逐处归类。

---

## 结论（一句话）
**没有遗留的 display（图层内容→可见 canvas）Canvas2D 路径。** v351 起 GL 是唯一 display；v352-355 把自由变换 warp（live+commit）也全收进 GPU。剩下的 Canvas2D 全是：GL 叠层 chrome、离屏图层存储/编辑、选区蒙版、滤镜/液化像素计算、吸管 composite、导出/缩略图、UI 控件。**单一 GPU 渲染 SSoT。**

## display 链（唯一）
- `board._renderFullGL`（board.ts）→ `glBoard.render()`：doc 底+背景+图层+浮层+overlay 全 GPU 合成 + `presentToScreenAffine` 上屏。
- 本 2D overlay canvas（`board.ctx`，alpha 透明叠 GL 之上）**只画 chrome**：lasso 蚂蚁线/handles/gizmo 框（`_drawLassoOverlay`）、doc 1px 边框、像素栅格（`gctx`）、GL 失败提示（`_drawGLRequiredMessage`）。**无任何图层/浮层像素 drawImage。**

## 合法的离屏 Canvas2D（非 display，别动）
| 用途 | 位置（代表） | 说明 |
|---|---|---|
| 吸管 composite 取色 | `board.ensureCompositeCache` → `compositeLayers`（board.ts）；读 `input._doPick`（input.ts） | 按需离屏合成一张 1:1，读单像素。非每帧、非 display。 |
| 导出 PNG/JPG/ORA/PSD | `session.ts`（renderDocToImageBlob）、`ora.ts`、`psd.ts` → `compositeLayers` | 离屏，存盘用。 |
| 图库缩略图 | `session.renderThumbBlob` → `compositeLayers` | 离屏。 |
| 图层像素存储/编辑/物化 | `doc.ts` editRegion、`gl/tile-pixels.ts`（tile SoT + materialize）、`pixel-edit.ts` | doc 的 CPU SoT；GL 从 tile 上传。 |
| 选区/蒙版 | `selection.ts`、`lasso.ts`、`selection-ops.ts` | mask canvas，离屏。 |
| 滤镜/液化像素计算 | `filters.ts`、`filters-adjust.ts`、`plugins/liquify-engine.ts`、`resample.ts` | 图像算法，CPU；结果经 editRegion 落 tile，GL live-sync 上屏（v350 seam）。 |
| 实时 overlay 裁剪 tmp | `board._clipOverlayMasks` | 笔刷 live overlay 的选区/锁α 离屏裁剪。 |
| UI 控件 | `palette.ts`、`reference.ts`、`ui/color-wheel.ts`、`plugins/curves.ts` | 色轮/参考窗/曲线，非 doc 内容。 |
| GL commit readback | `gl/gl-doc-renderer.ts` rasterizeStroke/warpToCanvas | FBO→readback→canvas→editRegion（笔刷 + 变换 commit）。 |
| 组隔离/clip/erase 合成 tmp | `layer-composite.ts` 内部 buffer | 仅服务上面那些离屏 compositeLayers。 |

## `compositeLayers`（src/layer-composite.ts）调用点 —— 全部非 display
- board.ts `ensureCompositeCache`（吸管）、ora.ts/psd.ts/session.ts（导出/缩略图）、layer-composite 内部递归、harness（golden）。**无 display caller**（旧 `_renderLayers`/`_blitCompositeCache` 已于 v351 归档）。

## CPU warp 现状（v355 归档后）
- 运行时**零** CPU warp：display 走 `gl-compositor._floatPass`（GPU），commit 走 `glBoard.warpToCanvas`（GPU readback）。
- `renderSource`/`renderForLayer`/`renderQuadPerPixel`/3 采样器已删；`renderQuadPerPixel`+采样器的 golden 对照基准搬进 `test/gl-smoke/harness.ts`（test-only）。
- 保留（GPU warp 依赖，**非 CPU 渲染**）：`quadWarp`/`sourceWarpMatrix`/`sourceDestQuad`/`homographyFromUnitSquareToQuad`/`invertMat3`/`homographySample`（纯矩阵/几何）。

## 给优化 agent 的提醒
- 优化只针对 **GPU 合成/warp 热路径**（见 docs/20260629-perf-optimization-backlog.md）。
- 上表「离屏 CPU」项**不是** display 瓶颈，别花时间 GPU 化（除非专门做导出/吸管加速，那是另一回事）。
- `_layerCompositeOpts` / `ensureCompositeCache` 只剩吸管，别误当 display。
