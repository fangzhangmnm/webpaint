# v0.6.33–52 大批总结：变换保锐 + 去 canvas 化战役 + 定尺寸裁切

> as-of v0.6.52 / 2026-07-30。写给下一个不熟 codebase 的 AI：这两天（2026-07-28/29）一口气改了什么、
> 为什么、哪些是 user 拍死的不许再动。逐版细节看 git log v0.6.33..v0.6.52（commit message 都是全的）。

## 一、变换保锐批（v0.6.33–37）

**起点 bug**：自由变换 lift 一瞬间图就糊+偏移半像素。根因 = GPU warp 采样器（`src/gl/gl-compositor.ts`
`WARP_FUNCS`）坐标是 edge 约定、bilinear/bicubic 内核是 center 约定，恒差 0.5 texel；且 commit 无
identity 快路。golden 的 CPU 参照抄了同一份错约定所以测试全绿抓不到——教训：**对拍自洽 ≠ 正确**。

落地（全在 `floating-transform.ts` / `gl-compositor.ts` / `workpiece/float-ops.ts`）：
- 半 texel 相位修正（mode≠nearest 喂 `sx-0.5`）；
- **整数刚体快路**：identity/整数平移/90°倍数/翻转 → `integerRigidOf` + `composeRigidWriteback`
  像素置换逐字节（ε=0.05px；rotate90 奇偶尺寸落 0.5 格 → 刚体态取整回格）；
- **拖动取整**：整数刚体态下 translate 拖动取整（预览=落地，反煤气灯）；旋转/缩放态不取整；
- **模式切换记账制**（usedClass similarity/affine/projective 随 corner/edge 拖动升级、undo 回退、
  降不回去置灰）——**取代 projectOnEnter 投影**（user 否决"切模式悄悄改 mesh"）；
- 采样模式：**双三次=默认**（真机终裁：spline 修完反振铃后无显著优势且微卡——**别再把 spline 提回默认**）、
  **像素完美**（RotSprite：CPU EPX 8×/4×/2× 放大缓存 + GPU nearest 采样大纹理，零新 shader；
  `src/rotsprite.ts`）、样条（`src/bspline.ts` 预滤波 B 样条，多次重采样最保真，自选档）；
- **反振铃限幅**（方案 A，user 拍板）：bicubic/spline 的 α clamp 进邻域 [min,max]、premult RGB 等比缩
  （C=r/α 不变→零色偏）。修"半透明笔画旋转边缘变深"。GPU + harness CPU + bspline（液化共享）三处逐位同步。
- 液化采样核可选（bilinear 默认/nearest/spline，`editorState.liquify.sample`）。

## 二、去 canvas 化战役（v0.6.38–47）

**硬原则（user 2026-07-29 拍板，记忆里也有）**：**输入输出都是字节就不走 canvas；任何数学不走 canvas；
全库目标 0–1 个 canvas（屏幕显示那个）**。起因 = 真机"半压柔边笔画 lift 边缘变黑"：canvas 源
`texImage2D` 的 `UNPACK_PREMULTIPLY_ALPHA_WEBGL` 在 Safari 不可靠 → 双重 premultiply。
作战地图 + 保留区清单：`docs/reports/20260728-canvas-audit.md`（本机，gitignored）。

- 浮层管线全 typed-array（live 上传 `u8Plane`/`splinePlane`、commit `warpToBytes`、落层
  `composeOverWriteback`）；
- **merge-down 归位 GL render tree**：`renderNodesToBytes`（S9 字节合成面，`doc-render.ts` →
  `RenderTreeGL.compositeToBytes`）——**合成/混合数学永远走 GL 单引擎，不许 CPU 复刻**
  （中途写过 blend-cpu.ts 被 user 驳回删除）。E2E golden：合并前后整图 composite maxΔ=0；
- 快照（液化源/undo preSnap）、psd、魔棒、collapse/盖印、滤镜 apply+surrogate、笔刷像素模式
  （`editRegionBytes` + 共享字节核）、选区填/清/挖/剪贴板提取——全字节化；
- **png-codec.ts = 全库 PNG 编解码唯一接缝**（"伪装的 png 库"，库外禁越狱 canvas）→ v0.6.47 内脏
  换 **vendored UPNG**（`vendor/upng/`，上游 88f504b + ESM 适配：pako shim=fflate zlibSync、
  `setDeflateLevel` 压缩级旋钮）。**ora 层存读零 premult 损**（低 α 逐字节 roundtrip 金测）；
  pHYs（DPI）可选；iCCP/解码失败回退 canvas **安全网永不删**；
- `resample-bytes.ts`：面积平均（缩小正解，整数比=严格 box）/bicubic（带 α 限幅）/bilinear/nearest；
  resize、导入、Blender、选区缩放全走它；
- 选区不变量：**mask 恒二值 0/255**（自由套索/椭圆从 canvas AA 改硬边光栅；羽化=将来显式后处理）；
  蚂蚁线 marching squares → **boundary tracing 整数阶梯**（所见=真像素集边界）。

**仍是 canvas 的（保留区，都有理由）**：屏幕 GL canvas（唯一显示通道）；外来格式（jpeg/webp/heic）
解码边界读出一次（`imageSourceToBytes`）；扁平化导出/缩略图 encode（canvas 语义即输出）+ JPEG 编码
（原生只有 toBlob）；参考窗/调色盘 UI 显示面。

## 三、裁剪·定尺寸模式（v0.6.48–52）

设计定稿 + 否决记录：`docs/20260729-crop-template-mode.md`（**先读它再动这块**）。要点：
- 裁剪工具双模式：自由（原样）/ **定尺寸**（曾叫"模板"，user 纠正——含自定义所以名不副实）；
- 锁比框动（2B；微信式内容动被否）、**无 rotation**（user 砍）、框内整体平移（定尺寸专属）；
- **fit 基准 = 原画布**（不是内容 bbox——AI 首版选错被纠正）；文案对齐 Windows 壁纸：
  **填充**(Fill/cover)/**适应**(Fit/contain)；
- 默认=自定义 + 预填当前画布尺寸（初始框=整画布零跳变）；
- commit = `doc.cropResampleTo` 原子 op 保层（frame=目标 px 整数时恒等路径逐字节）；
- 模板 SSoT `src/canvas-templates.ts`（照片横竖成对/方形 512–4096/像素画 32–256 + 自定义）；
  **DPI 只活在模板与导出 pHYs，永不进 ora**（防小白改乱）；desk 记 `crop.templateId`；
- 工具条全图标化；三枚新图标 2026-07-30 已从库收货（crop-fixed-size / fit-fill / fit-contain，
  sprite 重钉 a069c8c，stopgap 清零）。

## 四、教训（都付过学费）

1. **批量文本替换必须 fail-loud**：v0.6.48 接线块因 replace 未命中静默漏落 → 真机 UI 全死。
2. **新建测试文件先查重名**：覆盖过既有 `test/freeze-encode.test.mjs`（S8 四条静默消失），
   靠测试总数异常（1049→1045）救回。
3. **unsafe cast 是类型洞**：session push 走冻结视图缺 `getImageData` 炸真机推送（v0.6.44 热修），
   `as unknown as` 挡住了 tsc——洞已堵（EncodeDoc 收编 FrozenNode）。
4. golden 参照与产品代码同源抄写 → 同错互证全绿；要有"外部真值"测试（如 identity 逐字节）。

## 五、悬而未办

- PointerSession registry 深模块（多笔会话/两级 abort 散在 LassoEngine+input.ts 三处 if 链）→ 0.7 纪元；
- B 类扁平导出 encode 可切 UPNG 统一（无必要性论证，未动）；JPEG 编码 vendor（等真需要质量控制）；
- 自定义模板 v1 只收 px（mm/in+DPI 未做）；安全线常显无开关；
- **真机验收**：v0.6.46–52 全部未验（清单见 2026-07-29 会话；重点=ora 存读换 UPNG 后的开旧档、
  定尺寸裁切全流程、图标观感）。
