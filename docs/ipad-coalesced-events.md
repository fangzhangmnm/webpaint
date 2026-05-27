# iPad Safari pointer event 量化（兄弟项目可复用）

任何在 iPad / Safari 上接 `pointermove` + `getCoalescedEvents()` 的项目都该读一下这页，特别是手写、画图、签名、轨迹采集类。最早在 WebPaint v27 撞上，2026-05-26 修。

## 已知坑

### 1. `clientX/Y` 是整数（Apple Pencil）

Safari iOS 的 PointerEvent.clientX/Y 在 Pencil 模式下是 **integer**（其他平台是 double）。参考：Apple Developer Forum thread #31124、jquery-archive PEP issue #380。

影响：
- 在 1:1 zoom 下，所有位置都在像素网格上
- 移动方向接近水平/垂直时会出现可见的"阶梯"polyline
- 任何对位置做差分、曲率、速度估计的算法都要意识到 ±0.5 px 量化噪声

不能"修"，只能加亚像素重建（用相邻事件的时间戳+方向反推），或者直接低通滤位置。但**别先动这个 —— 真正的疏密波 bug 不是它**（见下条）。

### 2. `getCoalescedEvents()` 跨批次回放历史样本

**这才是大坑**。每次 `pointermove` 回调里 `e.getCoalescedEvents()` 返回的列表，可能把上一批的样本一起带回来。例如：

```
_move 调用 1：getCoalescedEvents() → [t=4, t=8, t=13, t=17, t=21]
_move 调用 2：getCoalescedEvents() → [t=4, t=8, t=13, t=17, t=21, t=25, t=29]
                                    ↑ 重复 ↑                  ↑ 新样本 ↑
```

直接把整列丢进笔触算法 → 在批次边界处出现时间倒退 → polyline 折返 → 任何 arc-length 累计算法都被注水。

**症状**：肉眼可见的周期性疏密波，周期对应于屏幕刷新节奏（60/120Hz）。鼠标输入不触发（鼠标 coalesced 通常只 1 个 event）。

**修法**：在每个 pointer 的状态里记 `lastEventTs`，coalesced 循环里丢非递增的：

```js
// in _down / beginStroke
rec.lastEventTs = -Infinity;

// in _move
const list = e.getCoalescedEvents?.() ?? [e];
for (const ev of list) {
  if (ev.timeStamp <= rec.lastEventTs) continue;
  rec.lastEventTs = ev.timeStamp;
  // ...
}
```

一行 if，挡住所有疏密波。`<=` 不是 `<`：完全重复的事件也要丢。

### 3. PWA WKWebView bytecode cache 按 URL 键

JS 模块更新后 PWA 仍然跑旧版本，因为 WKWebView 按 URL 缓存 V8 bytecode，SW 即使返回了新 JS 内容也被忽略。

**修法**：SW 在 fetch handler 里**重写 import URL**，给每个 `./xxx.js` 加 `?v=VERSION`。版本变了 = URL 变了 = bytecode 缓存键变了 = 强制重编译。WebPaint `service-worker.js` 的 `rewriteImportUrls` 那段可以照抄。

只针对 `.js` 文件做就行，HTML / CSS / 图片不用。

### 4. PointerEvent.pressure 在 pen 抬起瞬间 = 0

`pointerup` 时（甚至 `pointermove` 末尾）pressure 会突然掉到 0，不是真实的笔压。**症状**：笔画末尾突然变粗（如果 pressureToSize 用 `1 - pressure` 调小直径）或突然变细（直接乘）。

**修法**：记录 `lastP`（上一帧的有效压感），抬笔瞬间 pressure==0 时 fallback 到 lastP。WebPaint `input.js` 的 `effectivePressureFor` 实现。

### 5. Pencil 自带 ~10Hz 握笔抖动

Apple Pencil 传回的 pressure 信号本身有约 10Hz 的抖动（手腕和食指的生理频率）。直接灌进 `size = base × pressure^0.6` 会让笔每秒 10 次缩胀 → 视觉上的"结节" / mid-bulb。

**修法**：pressure 加一阶 LPF（`α ≈ 0.4`）做 stabilizer。位置不需要这么做，位置抖动是 #1 的量化，不是手抖。

## 调试 SOP

撞到任何"iPad 上看着不均匀"的笔迹问题时：

1. **先 dump CSV** —— `t_ms, clientX, clientY, pressure, coalesced` 五列足够
2. NumPy 跑去重 + 单调过滤 + 模拟笔触算法，看 std/mean
3. 蓝点 / 红点叠加可视化只能看大概，**时间维度的 bug 只有 CSV 看得清**

参考 `WebPaint/debug/plot_trajectory.py`。

## 兄弟项目 checklist

如果你的项目接了 `pointermove` 处理手写 / 画笔，至少要做：

- [x] `lastEventTs` 单调过滤（这页第 2 条，最重要）
- [x] PWA：SW 重写 import URL ?v= cache-bust（第 3 条）
- [x] 抬笔 pressure==0 fallback lastP（第 4 条）
- [x] pressure 一阶 LPF（第 5 条）
- [ ] 位置整数量化的亚像素重建 —— 一般不必，除非要做曲率分析

WebPaint 的 `input.js` 是这些都做了的小参考实现。
