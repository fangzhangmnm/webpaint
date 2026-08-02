# v0.8 C 骑士 · GPU 与 determinism grill 收敛记录

> as-of v0.8.0 / 2026-08-02
> 性质：**grill 收敛记录**——recon-c 标注的「唯一未定大架构题」经两轮讨论（user 在 claude.ai webui 的长聊转述 + 本 CLI thread 的技术 spiral）收敛后的终态。供后续 C 骑士施工引用。**非 ADR**（user 要求立 ADR 时再立；user 明示 brainstorm 中间态不算承诺，本文只记录收敛终点与关键推理链）。
> 上游：`20260802-v08-recon-c-headless-browser-deps.md`（勘探事实）；该文「拷问中断点」节的候选切法是收敛**前**的中间态，以本文为准。

## 收敛终态（一句话）

**最小 WebGL2 注入单后端 + 照旧 float 一套 shader + per-op 同步路由（CPU op 重放 / GPU 写真相 op 发结果）+ preview 零保证 commit 才保证。定点从纲领降级为 per-op 工具箱备件。**

## 分条（标注谁定的）

1. **最小 WebGL2 注入，单后端**（user，webui 转述）：headless 的 GPU 契约 = ctor 注入最小 WebGL2 子集；不做 device abstraction 多后端；**node 支持 = 非目标**（user 原话「洁癖假需求」）；平台移植 = 将来按 pinned spec 用 rust 之类重写。DOM 零依赖仍是硬承诺（Worker 里 `new OffscreenCanvas(w,h).getContext('webgl2')` 不碰 DOM）。
2. **stamp 累积走 fixed-function blend**（user 本 thread：「走1，不增加复杂性」）——即笔刷 splat 保持现有 float blend 管线，不做 per-pixel 循环定点累积、不做 per-stamp ping-pong。
3. **由 2 推导的连锁（本 thread 收敛）：定点纲领整体蒸发**。笔画（最高频真相写入者）一旦接受非确定，「全系统逐位一致」目标即放弃 → 手写定点采样/整数纹理/双 shader 账本全部失去存在理由 → **全管线照旧 float、一套 shader、preview==commit 同管线、硬件 filter 保留**。定点降级为：将来哪个具体 op 的同步载荷账单真的疼了，再对那一个 kernel 单独上（施工面=单 kernel，远小于全铺）。
4. **determinism 预算存活为 per-op 同步路由**（multiplayer 期的架构地基，现在只留分类标记位）：
   - **CPU/JS op 免费重放**：JS 基础算术 IEEE754 spec 级钉死、跨浏览器逐位一致。⚠ caveat：`Math.sin/exp` 等超越函数 implementation-defined 跨引擎会漂——**commit 载荷带平滑后的 stamp 列表**（手感数学只在发起端跑）即可绕开，顺带让 brush.ts 壁钟 dt 问题降级为「本地回放/timelapse 质量项」而非多人前置。
   - **GPU 写真相的 op 屈指可数**（笔画 commit / transform bake / 滤镜笔）→ **发结果**：笔画发累积 coverage（bbox 单通道，压缩后几十 KB/笔）、transform 发 tile（低频）。
   - **乐观并发不需要 bit 一致**：远端先 float 重放当即时预览（LSB 级误差不可见），权威载荷到达后原地校正。
   - **漂移不累积**：每个 op 的 owner 发校正 → 任何像素的漂移最多来自一个 op。
5. **preview 零保证，commit 才保证**（user，webui 转述；在 float 单管线下退化为「preview 只关时序/合帧，不关数学」）。
6. **阈值算子（油漆桶/魔棒/按色选择）的蝴蝶掐在判定层**：判定类 op 在 CPU 且**输出（mask/区域）随 op 发**——比「同步参与判定的输入 tile」便宜且免分布式协调。真相收敛靠载荷、判定结果随 op 走 → 蝴蝶两翅皆断，不依赖算术确定性。
7. **带宽降档阀（信息论，备而不用）**：场景=接收端有 LSB 级漂移的近似值、双方无法互相模拟——这是 **Slepian–Wolf/Wyner–Ziv** 设定，编码端不知道对方的值**率上不吃亏**，理论下界 = H(X|Y) ≈ 漂移的熵。初等实现 = **模码/发低位**：漂移保证 ±k 内，发每像素低 m 位（2^m>2k+1），接收端在同余候选中取离自己最近的 → **逐位精确重建**（高位翻车自动纠正，优于「各自量化取整」的边界分叉）。账：±1 LSB → 2 bit/像素=16KB/256²tile（低位面是噪声态、熵编码压不动=实付价）；对照平滑内容整 tile PNG 5-15KB 已打平，纹理内容 30-50KB 时模码赢。前提=漂移硬上界不存在（GPU blend 只有经验值）→ **必须 hash 校验+超界 fallback 发全量**（=「小差异容忍、中等差异报警」机制在编解码层复用）。**默认整 tile 压缩发；疼了再上模码**——此阀的存在证明「非确定+发结果」路线的带宽上限有 3-4× 信息论余量，不是刚性墙。

## 本版 vs 定点版：明知弱在哪（将来疼了的解药=局部定点）

- GPU 真相 op 永付载荷带宽（仅 multiplayer 出现，单人零成本）。
- op-log 回放文件跨设备重放不保证 bit 还原（视觉一致；timelapse 不受影响）。
- 「云端权威渲染 hash 校验」类玩法不可用。

## 技术备忘（spiral 中钉下的事实，实现期防重新踩）

- **frag shader determinism 判据只有一条**：输出像素的值是否完全在自己写的 shader 代码里算出（texture fetch 进、只写自己像素）。满足=逐位确定。卡脖子的唯一硬件事实：**frag shader 读不了正在写的 render target**（WebGL2 无 programmable blend/framebuffer fetch）→ 跨 primitive 累积只有三路：fixed-function blend（顺序 spec 有保证、**算术舍入 implementation-defined**；整数格式根本不许 blend）/ per-stamp ping-pong（确定但全 tile 读写×stamp 数，带宽爆炸）/ per-pixel 循环。已选第一路（见 §2）。
- 若将来局部上定点：**u8 真相 + u32 寄存器（highp int，乘后移位钉舍入）随便挥霍，u16 存储只有一个真需求=笔画进行中的累积缓冲**（1% flow 在 u8 只有 2.55 个量化级会 banding）；`precision highp int` 必须显式写（mediump int 移动端可能真 16 位，最易踩最难查）；WebGL2 整数纹理只有 NEAREST（双线性得手写）；wash 若为 `max` 整数下真·结合交换零舍入，buildup 若为非负饱和加**任意顺序同结果**——stamp 累积的 order 焦虑大半是虚的，真正 order-sensitive 的只有 over 型图层合成（本来就逐层单 pass shader）。
- 999 层 u8 中间量逐层舍入的 banding 是显示/导出质量项，不是确定性项（真相层不受影响）。
- 附带（B 骑士相关，webui 转述）：**单文件发行 = 单 .html 非 mhtml**（mhtml 不执行脚本）；file:// 是 secure context；SharedArrayBuffer 需 COOP/COEP（压缩线程化的制约）。

## 讨论中途出现又被超越的分支（防后人捡起来）

- 定点全铺纲领（webui 版「热路径定点」）→ 被「走1」连锁取代（本文 §2-3）。
- CPU 参照转正 runtime：否（user：「CPU 性能不可接受」）；仍留测试域当 golden。
- WebGPU 双写 / headless-gl node 后端：否（单 GL2）。
- per-pixel 循环 stamp 累积、模码即刻上马：均为「疼了再买」的备件，不进首期。
