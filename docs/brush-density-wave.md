# Brush 密度波 bug 复盘（2026-05-26, v27 修复）

下个 AI / 自己 6 个月后看：iPad Pencil 笔触出现波长几十 doc-px 的周期性疏密波，鼠标无、关压感仍有。最终发现是 **Safari iOS `getCoalescedEvents()` 在批次边界把历史样本一起回放**，brush 按接收顺序累加 path arc-length 时把这些"反向小段"算进了真实路径。修法是 input.js 端按 `ev.timeStamp` 严格单调过滤。

## 现象

- 笔划上肉眼可见的疏密节律，间距几十 doc-px
- 蓝牙鼠标拉同样轨迹无问题
- 关闭压感（pressureToSize / pressureToOpacity 都关）仍有
- 加 debug overlay：raw input 蓝圈视觉均匀，stamp 红点有明显波

## 排除的方向（不要再走一遍）

| 假设 | 为什么排除 |
|---|---|
| 整数像素量化 | Apple Pencil clientX/Y 是 integer，但波长尺度对不上：量化只会引入 1~2 px 级阶梯，疏密波是几十 doc-px 波长 |
| 压感→size/alpha 噪声 | 关压感后仍有 |
| Catmull-Rom / 输入平滑器 bug | v24 起 input 完全不做位置平滑，仍有 |
| chord-kink（路径折角处 Euclidean < step 缩短）| 蓝圈"相当规整"，没有可见折角 |
| 浮点累加漂移 | `accumDist += L - pos` 数量级远低于波长 |
| stamp 渲染层的 PNG halo / sprite 白边 | 与疏密无关，那是 RGB 漂移不是位置漂移 |

## 真正的根因

iPad Safari 在 `pointermove` 批次边界**回放历史 coalesced 样本**。dump 一笔到 CSV 看得很清楚：

```
t_ms  clientX clientY
4     398     765
8     397     765
13    396     765
17    395     765
21    395     765    ← 第一批 _move 的最后一个
4     398     765    ← 第二批 _move 的第一个，时间倒退！
8     397     765
13    396     765
17    395     765
21    395     765
25    395     765    ← 真正的新样本只有这一颗
29    395     764
```

蓝点 scatter 只画位置看不出，因为这些样本都落在同一条窄轨迹上。但 brush 是按**接收顺序**走 polyline 的：

```
extendStroke(398, 765)   // 从 (395, 765) 跳回 (398, 765)，L=3
extendStroke(397, 765)   // L=1
extendStroke(396, 765)   // L=1
...
extendStroke(395, 765)   // 又回到 (395, 765)
extendStroke(395, 764)   // 真正的新位移，L=1
```

`accumDist + L` 多算了几乎一整轮的 `step` 距离 → `accumDist >= step` 提前触发 → 多吐一颗 stamp 出来。视觉上：在用户眼里没动的地方多吐了 stamp（密），后面真正走的距离里 stamp 数量被这"额外吐出"占掉一部分（疏）。

**为什么波长是几十 doc-px**：批次回放的频率 ≈ 屏幕刷新节奏（60/120Hz），笔速 × 批次周期 = 几十 doc-px。

**为什么鼠标无问题**：鼠标 coalesced 列表通常只有 1 个 event，没有跨批次重叠的机会。

**为什么关压感还有**：path arc-length 注水是**几何**误差，跟 pressure 无关。

## 修法（input.js）

```js
// _down: 起手锚 lastEventTs
rec.lastEventTs = -Infinity;

// _move: coalesced 循环里，丢非递增 timeStamp 的 event
for (const ev of list) {
  if (ev.timeStamp <= rec.lastEventTs) continue;
  rec.lastEventTs = ev.timeStamp;
  // ... 原本的位置 / 压感处理
}
```

一行 if 解决全部疏密波。注意是 `<=` 不是 `<`，重复 timeStamp 也要丢（同一个事件被重放）。

## 关键诊断工具

bug 卡了三四天，真正破局的是 dump raw event 到 CSV + NumPy 跑统计。两个数字最重要：

1. **去重后剩多少行 vs 原始行数** —— 如果去重砍掉一半，就是 coalesced 回放了
2. **模拟 stamp 的 `std/mean`** —— 理论上 std/mean 应该 < 0.05；疏密波时会到 0.3+

工具脚本：`debug/plot_trajectory.py`（CSV 输入，6 图诊断 + 控制台数字）。

raw CSV recorder 在 ultraclean 中已经拆掉了，再调试新输入问题的话从 git history 翻 v25 的 `input.js` `_logRawEvent` + clipboard 复制那段。

## 留下来的硬约束

- `extendStroke` **必须**按时间单调收事件，否则 path arc-length 失真
- 任何把 raw event 排序、合并、补点的逻辑都要保留时间戳
- 未来如果接 WebGPU / look-ahead 平滑，仍然先 timeStamp 过滤再做几何

## 教训（给自己写的）

1. **不要相信 scatter 可视化**：蓝点 r=4 的圆遮住了所有 ±2px 的位置回退。用户说"蓝色相当规整"误导我以为输入端干净 —— 实际是渲染粒度盖住了时间维度的回放。
2. **不要猜，dump 数据**：我前期围绕"整数量化"、"chord kink"、"PNG halo"猜了三轮都不对。dump 142 行 CSV 跑 5 分钟就看出来了。
3. **平台 bug 不会自我标注**：MDN 没有写"Safari iOS getCoalescedEvents() 会回放历史样本"。WebKit bug tracker 有相关报告但搜起来要懂关键词。第一性方法是 dump 数据自己看。
