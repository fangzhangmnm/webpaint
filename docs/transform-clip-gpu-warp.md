# 组变换浮层 clip —— in-shader gather 基底 alpha（零额外内存）

> as-of v353 / 2026-06-28。**why + 设计 + 实现方案**（耐老化）。做 #5 GPU warp 时，真机发现「组变换拖动中组内剪切蒙版不生效」。本 doc 记设计，万一实现翻车也能据此慢慢重来。
> 决策：**不走 baked proxy，走「浮层路径上 in-shader 重建 clip」**（基底浮层源纹理已常驻 → clip 浮层 shader 顺手 gather 基底 alpha 相乘，零额外持久内存，比 proxy 还省）。

---

## 0. 问题

GL-only 下自由变换**组**时，组内每个叶子被 lift 成独立浮层、各自 GPU warp。但 clip（剪切蒙版）层和它的基底之间的裁剪关系在浮层路径上**断了** → 拖动预览期 clip 层 warp 后整个显出来，没被基底裁住。（抬笔 commit 后正常：像素烤回各层、组重新合成、clip 按新基底 alpha 复活。所以**只在拖动预览期**坏。）

## 1. clip 机制（复习）

`layer-composite.ts:13`：**clip 层的最终 alpha = 自身 alpha × 下方基底 alpha**。
- 基底 = 同级最近的「非 clip、可见、有内容」层；连续 clip 链共基底；不跨组。
- 操作 = clip 层画进 buffer 后 `destination-in 基底 alpha`（CPU）/ 采基底 tile alpha 相乘（GPU `_pass` 的 u_clipIndex）。
- 基底没了 → clip 层不渲染。

GPU 合成器**非浮层**路径已正确 clip（`_applyNodes` 解析 `base`，`_pass` 用 `clipIndex` 采基底 tile alpha）。坏的只有**浮层** pass（`_floatPass` 一律 source-over，无 clip）。

## 2. 为什么不用 baked proxy

baked proxy = 把整组合成一张 flat 纹理（clip 已在源分辨率应用）再 warp 一张。能修，但：
- **pass-through 组废**：pass-through 子层要和组**下方**层混，没法预先拍平。
- **要多一张组 bbox 尺寸的 flat FBO**（内存）+ preview(拍平)/commit(逐层) 两套路径。

## 3. 方案：in-shader gather 基底 alpha（巧办法）

clip 浮层的 warp shader 里，**顺手再用基底浮层的 Hinv gather 一次基底源纹理**，拿基底在该 dst 像素的 warp 后 alpha，`clipα ×= baseα`。

**为什么零额外内存**：基底也是浮层源、lift 时已上传一次、**常驻**。clip 时只是 clip 浮层 pass 里**多绑一张已驻留的基底纹理 + 多传一个 base Hinv uniform**，不新建任何 FBO/纹理。代价是**计算**（clip 像素多一遍采样；bicubic 多 16 taps），clip 层少、可忽略。**比 proxy 省一张 flat FBO。**

### 关键内聚点（实现为何小）
`gl-compositor.ts:_applyNodes` **已经解析好 clip 基底** `base`（`resolveClipBases`），而 `base.float`（CompLeaf.float = 基底浮层的 FloatDesc）就在手边。所以「clip 浮层 → 基底浮层」的链路**合成器本来就有** → **不需要 board 端改动、不需要新数据管道**。fix 全在 compositor + shader。

### 实现（compositor + shader 两处）
1. **WARP_FRAG**：`sampleSrc` 参数化成 `(sampler2D tex, vec2 size, int mode, sx, sy)`（GLSL ES 3.00 允许 sampler 形参）。新增 uniform `u_clip`(int)、`u_baseTex`、`u_baseHinv`(mat3)、`u_baseSrcSize`、`u_baseMode`。main 里 `u_clip==1` 时：用 `u_baseHinv·docXY` 求基底 (ub,vb)，落 [0,1]² 则 `baseA = sampleSrc(u_baseTex,…).a` 否则 0；`s.a *= baseA`，再预乘。
2. **`_floatPass(f, acc, docW, docH, clipBase?: FloatDesc|null)`**：clipBase 非空时设 `u_clip=1` + 绑 baseTex + 设 base uniforms；否则 `u_clip=0`。
3. **`_applyNodes`**：`if (node.float) this._floatPass(node.float, acc, docW, docH, (node.clip && base?.kind==="leaf") ? base.float : null);`
4. **golden**（harness）：warp+clip GPU vs CPU（renderQuadPerPixel(clip源) + renderQuadPerPixel(base源) → destination-in），扭曲 quad，Δ 小。

## 4. 边界 / 已知限制（留给那时的自己）
- **基底静止（单 clip 层变换、基底不动）**：`base.float` 为 null → 本方案下 clip 浮层不裁（退化回当前 bug）。正解 = 基底 alpha 改采**基底 tile**（doc 空间，复用 compositor 的 tile 采样），或把静止基底也当 identity-Hinv 浮层 lift。**本期先做组（基底也是浮层）的情形**——即真机报的 bug；静止基底案留 follow-up。
- **基底是组**：`base.kind!=="leaf"` → 不裁（compositor `:211` 早有「组作基底暂不支持」，一致）。
- **clip 链**：多个 clip 浮层共一个基底浮层 → 各自 gather 同一基底源（共享引用），天然支持。
- **采样一致性**：基底 alpha 最好用和基底浮层渲染**同档**采样（保 preview 裁剪边缘 == commit）；想省可基底 alpha 用 bilinear（蒙版边缘对质量不敏感）= 可调质量/性能点。本期用同档（mode 一致）求稳。
- **commit**：commit 仍逐层 warp 烤回（保层结构），clip 在 commit 后的正常合成里复活——本方案只修**预览期**，commit 路径不碰。

## 5. 和 baked proxy 的最终账
| | per-float clip（本方案） | baked proxy |
|---|---|---|
| 额外持久内存 | 0（in-shader gather 已驻留基底） | +1 张组 bbox flat FBO |
| pass-through 组 | 对 | 废（要特判） |
| 保层结构 | 是 | preview 拍平、commit 另走 |
| 改动面 | compositor + shader 两处 | lift + 合成 + 双路径 |
| 代价 | clip 像素多几次采样（计算） | 多一遍组合成 + FBO |

---

参考：[[perf-webgl-memory-clip]]、`src/gl/gl-compositor.ts`（`_applyNodes`/`_floatPass`/`WARP_FRAG`）、`src/layer-composite.ts`（CPU clip 语义基准）、[[bodypaint-texture-space]]（同 gather 骨架）。
