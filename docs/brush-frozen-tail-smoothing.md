# 笔刷平滑：frozen / tail 模型（v148 已实现 Tier 2，**未浏览器验证**）

> **v148 实现状态**：Tier 2 已落地，esbuild 通过 + smoother 数学已 Node 单测，但**没在
> 浏览器/iPad 实测**。要验证的点见本节末「待验证」。代码：
> - `src/stroke-smoother.js` —— lookahead 窗口平滑器（纯几何，端点钉 raw，frozenIndex）
> - `src/brush.js` —— buffered（brush/erase 非 pixel）走 frozen/tail；smudge/pixel 仍 immediate。
>   关键方法：`_extendBuffered` / `_walkStamps` / `_emitFrozen` / `_renderTail` /
>   `_composeOverlay` / `_blitFrozen` / `_blitTail`；overlay 同帧缓存（`_composeAtCount`）。
> - `src/input.js` —— buffered 直传 raw（`rec.rawToEngine`）；四件套抽成 `_fourStageSmooth`
>   只服务 smudge/pixel/liquify/filterBrush；`_streamlineToLookaheadPx` 映射。
>
> **调参旋钮**：`localStorage['webpaint.lookahead']` = streamline=1 时的窗口（screen px，默认 90）。
> 窗口（doc px）= streamline × cap ÷ viewport.scale，在 beginStroke 时定。
>
> **待验证（浏览器/iPad）**：① 描线是否真的跟到笔尖、无持久滞后；② wash/buildup 接缝
> 有无双盖/暗边；③ erase 同样路径是否正常；④ 笔尖落笔/抬笔 taper、单点 tap 圆点；
> ⑤ 大笔刷 + 长笔触帧率；⑥ 选区内绘制 clip；⑦ 高 zoom / 低 zoom 手感（窗口 ÷scale）；
> ⑧ 默认 streamline=0.3 手感是否可接受。下面是设计依据，照旧。

---

# 笔刷平滑：frozen / tail 模型（原设计 note）

> 写这份的动机：现状平滑是「立即烤死滞后的 EMA 位置」，导致笔迹和笔尖之间永远有
> 一段追赶（lag gap）。Procreate 高平滑时笔迹会**跟到笔尖**，对描线帮助很大。这份
> 钉住我们讨论出的正解（frozen/tail 分段 + 每帧重画尾巴），以及接缝、成本、buffer
> 的具体解法。**还没写代码**——这是给下一次的我的施工图。
>
> 配套阅读：[brush-architecture.md](brush-architecture.md)（wash/buildup 算子）、
> [streamline-velocity-math.md](streamline-velocity-math.md)（现状平滑，注意已漂移，见下）、
> [brush-density-wave.md](brush-density-wave.md)（spacing 连续性的前车之鉴）。

## TL;DR

```
把一笔切成两段（按弧长，永不共享同一个 stamp）：
  frozen  —— 后面已经有更靠后的样本，平滑定型，永不再变 → 烤进 stroke buffer
  tail    —— 靠近笔尖、还缺 lookahead 样本的一段 → 每帧清掉重画，不烤

显示 = F ⊕ T        ⊕ = max (wash) / source-over (buildup)
不变式：只要按弧长切分不共享 stamp，F ⊕ T ≡ 整条笔触的真实结果（任意时刻）
        ⇒ 冻结一个 stamp = 视觉 no-op（无几何 pop、无双重压暗）

每帧成本 ∝ tail 长度（≈ lookahead 窗口 / spacing），与整条笔触长度无关
```

## 1. 现状诊断（病根）

落点平滑全在 [input.js](../src/input.js) 的 pointermove，引擎不管位置。链路：

```
raw → 静止门限 → timeStamp 单调过滤(Safari coalesced 回放坑)
    → ① Motion Filter(角速度钳) → ② Stabilization(滑动平均)
    → ③ Pull-Stabilizer(速度上限) → ④ StreamLine(一阶 EMA + 速度自适应)
    → screenToDoc → engine.extendStroke → 按 arc-length 等距烤 stamp
```

两个病：

1. **因果 IIR EMA 没有冻结边界**：④ 的 EMA 整条历史都在无限微动，没有"这一段定型了"
   的概念。而 `extendStroke` 每来一个事件就把**滞后的 EMA 位置立即烤死**
   （[brush.js:300](../src/brush.js#L300)）。烤进画布的就是那条永远落后的中心线
   → **持久追赶滞后**。这是要解的主问题。

2. **自适应其实已经死了（doc 漂移）**：
   - [streamline-velocity-math.md](streamline-velocity-math.md) 写 `adapt = streamline`、
     `V_REF = 0.3`；代码是 `adapt = 1 - sl`（v124h，[input.js:612](../src/input.js#L612)）、
     `V_REF = 0.1`（v124i，[input.js:63](../src/input.js#L63)）。
   - 后果：V_REF=0.1≈1in/s，任何正常画速都 `ramp=1` → `(1-ramp)=0` → `αPos≡αBase`。
     速度自适应那坨数学**基本不触发**，④ 退化成固定-α=`1-sl` 的普通 LPF。
   - 且 ②③④ 都是 **per-event** 不是 per-time/per-distance → 平滑强度随设备帧率漂
     （iPad 120–240Hz vs 鼠标 60–125Hz）。

> 文档要么改对、要么承认现状=固定-α LPF。本 note 的重构会顺手处理（见 §6）。

## 2. 目标

- 可见线**到达笔尖**（消掉持久追赶），同时仍然平滑 —— 描线手感对齐 Procreate。
- 设备无关（dt / 距离窗口）。**与本重构同次做**（见 §6），别分两轮各调一次手感。

## 3. 核心模型：frozen vs tail = 「有没有未来样本」

不是 extrapolate（猜笔尖前面），是 **lookahead 平滑 + 两端钉死**：曲线起点钉落笔点、
末端钉当前笔尖，中间平滑。笔尖一动，靠近笔尖那段重算 → 这就是"扭来扭去 → 每帧重绘"。

把因果 IIR 换成**有限支撑的 lookahead / 窗口平滑器**（居中移动平均 / 局部样条）。这样
冻结边界天然存在：

```
窗口半宽 h（按距离定义）：smoothed 点 s 的形状依赖 raw ∈ [s-h, s+h]
⇒ 笔走到 s+h 之后，s 定型 → 冻结
⇒ 冻结滞后 = h（弧长）；tail = 最后 h 那一段
```

- **frozen**：弧长 < (笔尖弧长 − h)，已有右侧样本，定型 → 烤进 stroke buffer。
- **tail**：最后 h，缺右侧 lookahead，每帧用单边平滑/凑到笔尖重画，不烤。

## 4. 接缝解法（本设计的核心，wash/buildup 都对）

### 不变式

只要 frozen 与 tail **按弧长切分、永不共享同一个 stamp**，则任意时刻：

```
F ⊕ T  ≡  整条笔触真实结果
  wash    ⊕ = 逐像素 max(F, T)        （max 幂等）
  buildup ⊕ = T source-over F         （tail 在时间上全在 frozen 之后）
```

推论：**冻结一个 stamp = 视觉 no-op**（它本来就在 display 里，只是从"每帧重画"挪进
"不再清除"）。⇒ 无几何 pop、无 wash 双重压暗。**接缝变成非事件。**

这正是 Tier 1（见 §7）做不到的：Tier 1 的尾巴是"凑过去的假线"、和 committed 不是同
一批 stamp，committed 又用滞后 EMA → 冻结瞬间几何跳 + wash 双盖。Tier 2 里 tail 就是
**真 stamp，只是还没冻**，用真算子合成。

### self-crossing 安全

哪怕 tail 绕回去盖到很早的 frozen 区域，重算时在 tail bbox 里读 F 做 `max`/`over`，
结果照样精确。要重算的区域永远就是 **tail bbox**。

### ⚠️ buildup 的 opacity 坑

别让 board 画 `F` 再画 `T` 两次、各 `globalAlpha=opacity`。buildup 在 opacity≠1 时
**会过暗**：

```
F α=1, T α=1 同像素, opacity=0.5
正确: (T over F)=1 → ×0.5 = 0.5
拆画: F×0.5=0.5; T×0.5 over = 0.5 + 0.5×0.5 = 0.75   ✗ 过暗
```

必须 **先 `T over F`（不带 opacity），最后整体乘一次 opacity**（=现状 endStroke 的
`globalAlpha = user.opacity`，见 [brush-architecture.md](brush-architecture.md) 的
"opacity 在 Π 外"）。wash 同理：先 `max(F,T)` 再 ×opacity。

⇒ wash 和 buildup **共用一套机制**："每帧重算 display 的 tail bbox 区域"，只是算子
不同（max / over），opacity 都只在最后乘一次。

## 5. 成本与 buffer

### 不重算整条，只重算 tail

- tail 长度 = lookahead 窗口 `h`（按距离），tail 内 stamp 数 ≈ `h / spacing`，有界。
- frozen 一次性增量烤好，不动。
- 每帧成本 ∝ tail 长度，**与笔触总长无关**。大笔刷也只是这几十颗 stamp 的 blit。

### buffer 账：净增一个**小**的

| buffer | 角色 | 备注 |
|---|---|---|
| `F` | frozen 缓冲 | 复用现 `bufferData`(wash Uint8)/`bufferCanvas`(buildup)，语义改成"只装已冻结" |
| `T` | tail 临时缓冲 | **新增**，只覆盖 tail bbox 的小 buffer |
| overlay RGBA | 每帧显示 | 复用现 `overlayCanvas`，每帧只 `putImageData` 补 tail bbox 一小块（读 F 那块 ⊕ T → RGBA） |

净增 = 一个 tail 尺度的小 buffer。想省掉它就得每帧 copy 整个 F → 反而更贵。值。

### ⚠️ tail buffer 不要每帧 malloc，也不要全屏

- **每帧按 tail bbox 新建** → 60fps 的 GC churn，卡顿源。否。
- **全屏 / 全笔触大小**（像现 stroke buffer grow 到整条 [brush.js:222](../src/brush.js#L222)）
  → 又回到每帧清/扫一大片，丢掉有界成本。否。
- ✅ **预分配、grow-only、复用的小 buffer**：尺寸 = `lookahead 距离 + 最大笔径 + headroom`
  的上界，一次性分配；每帧只 `fill(0)` 用到的子矩形 + 记一个 doc 空间 origin 偏移；
  笔径变大超容量才 realloc（grow-only，钳在 tail 尺度）。沿用现成 grow-only 哲学，
  只是留小、复用。

## 6. 与设备无关化（dt）的关系：同次做

§3 的窗口若**按距离/时间**定义，则同时干掉 §1 病 2 的 per-event 设备依赖。所以
"调手感一轮"的成本和 reach-tail 一起付：一次重构换两个收益（冻结边界 + 设备无关）。
**别分两轮**。

## 7. 两档方案

- **Tier 1（最小，先验证手感方向）**：committed 保持现状烤法；额外加一条 provisional
  reach-tail overlay，从平滑位 → raw 笔尖每帧重画、不烤，pen-up snap。infra 现成
  （board 已每帧 composite `getLiveOverlay`，[brush.js:365](../src/brush.js#L365)）。
  **缺点**：尾段平滑弱、接缝随 EMA 推进 pop、wash 双盖 —— 即 §4 列的那些病。
- **Tier 2（正解，本 note 主体）**：lookahead 窗口平滑 + frozen/tail + §4 接缝不变式。

> 决定：倾向 **Tier 2**（接缝是主痛点，Tier 1 解不掉）。Tier 1 可作为半天的手感探针，
> 但别把它当终点。

## 8. 施工坑清单

1. **`accumDist` 跨界连续**：spacing 累积量要在"tail stamp 转正为 frozen"时无缝接上，
   否则冻结瞬间疏密跳一下（参 [brush-density-wave.md](brush-density-wave.md)）。
2. **pen-up tail snap**：抬笔把 tail 平滑收到真正 pen-up 点，否则末端留钩。
3. **pressure 双 LPF**：现状 input 端固定-α=0.4（[input.js:1264](../src/input.js#L1264)，
   设备相关）＋引擎端 τ-LPF（[brush.js:265](../src/brush.js#L265)，设备无关）串联两次。
   重构时一并收敛成一处、设备无关。
4. **spacing 用 LPF 压感**：现状 step 用 LPF'd 压感算（[brush.js:286](../src/brush.js#L286)），
   tail 重画时压感取最新值，冻结时定死该点压感。
5. **culling**：现状整颗在画布外的 stamp 跳过但循环推进（[brush.js:299](../src/brush.js#L299)），
   tail 同样要保留这个边缘连续性。

## 8.5 已知问题 / backlog（v148 实测后）

- **layer bbox 不自动扩**（v148 已修）：layer 存储是**裁剪过的**（只存 bbox 内像素，见
  `doc.js Layer.ensureBbox`）。老的逐 stamp 路径每颗都 `layer.ensureBbox` 把 layer 长大；
  新 frozen/tail 进的是 stroke buffer，漏了这步 → commit 时 `drawImage` 把 buffer 画进过小的
  layer canvas，画到旧 bbox 外的部分被裁掉。**live overlay 不经 layer bbox（doc 坐标直画）
  → 画的时候看不出，pen-up commit 才丢像素**（这就是「边缘 degenerate」）。
  修（v148）：**bbox 扩张是 pixel 引擎的事**（`PixelEditTx.ensureCovers`），不是 brush 的。
  brush.endStroke 收一个 `ensureLayerBbox(x0,y0,x1,y1)` 回调，在 **freeze-all 之后、composite
  之前**（freeze-all 可能再扩 bufBbox，时机要紧）调它；input 把 `tx.ensureCovers` 传进去。
  brush 只报「我要写哪」，layer.ensureBbox 由 tx 调。immediate(smudge/pixel)逐 stamp 直画 layer，
  仍由 brush._stampOne 调 layer.ensureBbox（无法预批，是另一回事）。
- **曲线弯曲不自然**（待论证数学）：windowed 位置平均会系统性「瘪」曲率（把点往弯内侧
  拉）。Procreate 感更自然。需重新论证平滑算子（见 §10 候选：tangent/heading 域平滑、
  Catmull-Rom / Bézier 拟合、Taubin λ|μ 防收缩、one-euro）。
- **tail taper 可实装**（user）：有了 tail rendering，描线收尾的 taper-out（笔尖渐细/渐淡）
  现在可以做了——tail 段每帧重画，末端按到笔尖距离施加包络即可，不污染 frozen。

## 9. Open questions

- 窗口平滑器具体选型：居中移动平均（简单、线性相位）vs 局部三次样条（更顺、贵一点）。
- lookahead `h` 暴露给用户吗？还是从 streamline 单参映射？（手感参数别爆炸）
- pen 预测（latency hiding）要不要做？浏览器无 `getPredictedEvents`，先不碰，记 backlog。
- 冻结边界 monotonic 推进的实现：维护 raw 样本 ring buffer + smoothed 点队列。
