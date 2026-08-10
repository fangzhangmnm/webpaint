# ADR-0009 · Gl2Port 注入与 GL 确定性路线（C 骑士 spec 之一）

> created 20260809
> 状态：**accepted**（user 2026-08-09 grill 五轮收敛后授权立 ADR；出处
> `ai-docs/20260809-c-backend-grill.md` + `ai-docs/20260802-v08-gpu-determinism-grill.md`）。
> 关联：ADR-0008（RasterService = 本刀接缝）；施工契约 = `ai-docs/20260808-c-headless-proposal.md`。

## 背景

C 骑士（前后端分域）要求 backend DOM 零依赖，而合成/笔刷栅格化是刻意 GPU-only。全仓 GL 调用面
经核实极小：按名 shader 画 quad、stamp 一次 drawArraysInstanced、FBO 借还、blend 状态、纹理上传、
readPixels——没有几何/线/点/深度。GL context 创建点全仓唯一（造 context 需要 DOM/OffscreenCanvas，
用 gl 对象不需要）。

## 决定

1. **GL 契约 = 手写最小 interface `Gl2Port`，单后端语义**。接口钉死的是「WebGL2 对我们的承诺集」，
   不是通用 device abstraction（多后端抽象已否）；将来接其他 graphics API = 去实现这份承诺，
   实现不了再顺着接口伤筋动骨。命名诚实：叫 GL2 不叫 GPU（我们用的是受限 GL，非 webgpu/cuda）。
   实现两个：**`BrowserGl2Port`**（壳侧造：canvas/OffscreenCanvas.getContext 翻到壳，含真 WebGL2
   的全部 quirk 处理）+ **`SoftGl2Port`**（CPU 软模拟）。壳造好递入，backend 不碰 provider quirk；
   caps/quota 等 meta 由壳填成数据字段。
2. **自愈写进 Port 承诺**（Gl2Port ≠ 1:1 WebGL2）：结构自愈（context-loss 检测、program/FBO/VAO
   重建、generation++ 失效广播）= Port 职责；数据自愈（内容重传）= backend 职责（数据在 CPU SSoT
   池，Port 不认识数据）。**GPU tile arena（纹理仓+generation）归 Port**（多 tab 公共资源）；
   **bridge（cpuId→gpuId 映射）+ 重传逻辑归 backend**。
3. **多 tab 是一等需求**：N 个 WebPaintBackend 租户共享一个 Gl2Port（配额记账）；node 测试含
   多 backend 并发用例。UX 后做，后端形状先按此定。
4. **SoftGl2Port：迂腐语义模拟，测试/MCP 域专用**（本条**修订** 20260802 grill 终态的
   「node 支持=非目标」——修订理由：MCP server、node 全量红队测试、减少真机批的实打实收益，
   非纯度洁癖）。纪律：照 GL 规范公式逐条实现我们用到的子集，不做创造性简化；不复刻的只是硬件
   数值与 instancing 机制。**用户 runtime 不变：无 WebGL2 照旧响亮失败**（「CPU 性能不可接受」
   维持原判，SoftGl 不当用户路径）。
5. **GPU/CPU 对表 = shader 注册表本身**：每 program 名 → {GLSL 源, CPU 等价函数} 同处登记；
   新功能只写 GPU，入 fallback 名单必须补 CPU 版（或显式 GPU-only 登记进 todo）。测试三件套：
   SoftGl 自身测试、真 GPU vs SwiftShader（Playwright headless Chrome，dev-only）vs SoftGl 三方
   golden ±ε、注入真 GL 时热路径不得旁路 Port 的白名单测试。
6. **确定性路线照抄 20260802 grill 终态**（此处收编为 ADR 正文，该 doc 降为推理链存档）：
   - stamp 累积走 fixed-function blend（「走1，不增加复杂性」）→ 定点纲领整体蒸发：全管线照旧
     float、一套 shader、preview==commit 同管线、硬件 filter 保留；定点降级为将来 per-op 备件。
   - determinism 预算存活为 **per-op 同步路由标记位**（multiplayer 地基，本纪元只留标记不实现
     transport）：CPU/JS op 免费重放（commit 载荷带平滑后 stamp 列表，绕开超越函数漂移，顺带
     消解 brush-rack 依赖——回放/同步格式存 stamp 不存 brushId）；GPU 写真相 op（笔画/transform）
     发结果；阈值算子判定在 CPU 且结果随 op 发（蝴蝶两翅皆断）；漂移不累积（每像素最多一个 op
     的校正）。带宽降档阀（模码/Slepian–Wolf）备而不用。
   - **preview 零保证，commit 才保证**：交互进行中的预览帧不参与任何一致性承诺。
   - 明知弱点（记录在案）：GPU 真相 op 永付载荷带宽（仅 multiplayer）；op-log 跨设备回放不保证
     bit 还原；云端权威渲染 hash 校验玩法不可用。解药=将来局部定点（技术备忘见 grill doc）。

## 后果

- gl-context.ts 的 getContext 唯一创建点翻到壳侧装配；GLContext 现体改造为 BrowserGl2Port 实现体。
- backend 域文件禁浏览器词 lint 成立（Port 之外无 GL/DOM 入口）。
- MCP server / node 全量测试成为可能（SoftGl2Port 兜底栅格域）。
- 测试分级：快层（npm test，含 SoftGl 单测）每 build；全量层（test:full：全量画作 round-trip、
  三方 golden、多 backend、mock multiplayer）只在 QA 收尾棒。
- 新独立 CPU 像素算法 = user consent + `backend/algorithms/` 落户 + 注册清单（热路径栅格只准走
  Gl2Port）——语言层面堵不死，靠纪律 + review + 测试。
