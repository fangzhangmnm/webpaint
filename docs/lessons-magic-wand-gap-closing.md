# 魔术棒 + 容隙：经验分享 + future TODO

> v71 我加了「容隙」(gap closing) 想做 Procreate 没有的、对线稿不闭合鲁棒的
> 魔术棒。v79 撤掉。原因 + 经验 + 重做思路。

## 用户痛点（真实需求）

线稿艺术家手画时常有 1-3 px 缝隙：
- 真闭合线 → 普通魔棒 OK
- 有缝隙 → 普通魔棒**泄漏到外面**，整片画都被选中

期望：tap 在缝隙边的某个像素，**像缝是闭合的一样**选到那个小区域。

## v71 设计（错的）

「形态学闭合 + 反向 dilate」3 步：

```
step 1: 标 barrier（线稿像素 = barrier）
step 2: dilate barrier N px → 缝 ≤ 2N 被自动封口
step 3: flood fill 在 non-barrier 区域
step 4: dilate fill mask N px → 选区贴回原线（抵消 step 2 内缩）
```

理论上：fill 区域比真实少 N px (step 2 内缩) → post-dilate 还原 → 贴线。

## 为啥不行

**致命问题 1：tap 点被 dilated barrier 吃掉**

用户 tap 紧贴线（线稿艺术家**就是这么用**——刚画完线想填这个区域，习惯 tap
靠近线）。step 2 把线外扩 N px → user tap 落在「dilated 区」→ `effBarrier[start]
=== 1` → 整个返 null → **「魔棒点了没反应」**。

```
原线（N=4 dilate 后）：

    line: .....█████.....        →     barrier:  ..░░░█████░░░..
    tap →    ^                          tap →   ^ ← 在 dilate 区里
```

user tap 离线 ≤ N px 全部失败。线稿区域**中心**才能 tap。
窄区域（< 2N 宽）**整片不可点**。

**致命问题 2：小特征整片消失**

线稿里 1-3 px 宽的细脖子 / 小连接，被 dilate N=4 完全填实 → flood 区域里不存在
→ 无法选中那个小区域，哪怕 user 在大区域里 tap，flood 也走不进小脖子。

**致命问题 3：默认 4 → 90% 用户体感「魔棒坏了」**

默认 N=4 是为了真实抗缝。但艺术家**绝大多数**线稿是闭合的，N=4 帮不上忙却带来
上述两个 bug。**正确默认应该是 N=0**，问题 1+2 都消失。

但 N=0 = 没有「容隙」功能。功能本身没价值（在默认下），有价值时（N>0）又有
不可接受的副作用。**整个 feature 错了**。

## 经验沉淀

**1. 加 feature 前 user-test 真实工作流**

我自己想出来的算法，没人画 lineart tap 过我能看到。Procreate 工程师不可能没
想过 gap closing，他们不做不是技术问题，是**这个 feature UX 不通**。

→ artist-priorities.md 这种 input 文档真有用，别只看自己 engineer 想法。

**2. 默认值改变 = 改变功能本质**

我把 N 默认成 4 而不是 0，理由是「想让人感受到这个 feature 的价值」。结果是
绝大多数用户**第一次 tap 就坏了**——他们不知道有 N 滑块，也不会去想为啥坏。
**默认值是产品最重要的一行代码**，定错了等于 feature 不存在。

**3. 静默 throw = 红线**

`endPath` 没 try/catch → magic wand 任何 throw 都被浏览器静默吞 → user 看到
「点了没反应」。这种**用户面前没反馈**的 bug 最难复现。

→ v79 起，所有 endPath / magic wand 路径都 try/catch + status 报错。

**4. 用户能区分「bug」和「feature 设计不合理」吗？— 不能**

User 报告「魔棒坏了」实际指「我 tap 在我想 tap 的地方但什么都没发生」。这是
feature 设计不合理，不是 bug——algorithm 按 spec 跑了，spec 错了。

→ 我应该早点意识到「容隙时 tap 紧贴线返 null 是不合理 spec」，而不是怪 user。

## v79 后的魔术棒

干净版（保留的）：
- tap → flood fill 颜色差 ≤ threshold 的连通像素
- 整 doc 尺寸 iterate（修「点空白只选 bbox」经典 bug）
- inline barrier 检查（不 alloc 单独 buffer）
- combined buffer (mask + visited)：0=未访问, 1=接受, 2=访问但 barrier
  比 v71 的三 Uint8Array 省 8MB
- try/catch 包外层 + status 报错

UI 只剩阈值滑块。容隙 row 撤了。

## Future TODO：怎么真的解决线稿缝隙

如果要重做，下面三个方向**任一个**都比 v71 形态学 dilate 强：

**方案 A. 距离场 + 可调流通成本**

```
1. 算每个像素到最近线像素的 EDT（欧氏距离场）
2. flood fill 用 Dijkstra-like：从 tap 出发，每步「成本」= 1 / EDT
   离线越近成本越高
3. 累积成本超过预算就停
```

缝隙 = 缝外像素离线**也很近** → 流通成本高 → 累积超预算 → 不进。
区域中心 = 离线远 → 成本低 → 自由流通。
**自然贴线**，**自然不漏**。

成本：每像素 O(log n) 优先队列。比 dilate 慢 ~3x，但量化指标可控。

**方案 B. dead-end 检测 + 桥接**

```
1. 标线像素图。
2. 找「端点」= 线上只有 1 个线邻居的像素
3. 端点配对（成对 ≤ N px 距离）
4. 在配对端点间画虚拟线段（仅在 flood 的 barrier map 里加，不动 layer 像素）
5. 普通 flood fill on modified barrier
```

只在**真正断开的地方**桥接，不动其他线像素 → tap 紧贴线 OK，细脖子不消失。
比 dilate「精准」但**实现复杂**：dead-end 定义、配对启发、多端点歧义。

**方案 C. 双层混合**

```
1. tap 时 N=0 跑一次普通 flood，看选区有没有「灾难性大」
   （> 某阈值，比如 > 50% doc 面积）
2. 灾难 → 提示 user「线稿有缝，要不要试容隙？」+ 滑块在状态条出
3. user 拉到合适 N → 重跑 N>0 路径
```

把 feature **从默认隐藏到按需启用**。N>0 路径仍有 v71 同样的 tap 紧贴线问题，
但 user 主动开启时心理预期不同，能接受「中心 tap」的 UX。

## 实施 priority

A > B > C。A 是 right way；B 是 nice but hard；C 是 lazy way 但**至少不会
把好用的默认魔棒搞坏**。

短期不做。复杂度高、用户痛点不算 top priority、其他 painting feature 更值得
做。**记小本本，将来再说**。
