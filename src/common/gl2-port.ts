// Gl2Port —— 「WebGL2 对我们的承诺集」手写最小 interface（ADR-0009 决定 1；C1 落地）。
//
// 性质：**单后端语义契约**，不是通用 device abstraction——将来接其他 graphics API = 实现这份承诺，
//   实现不了再顺着接口伤筋动骨。命名诚实：叫 GL2 不叫 GPU（我们用的是受限 GL 子集）。
// 实现体：BrowserGl2Port（src/shell/browser-gl2-port.ts，真 WebGL2 + 全部 quirk，壳造好递入）；
//   SoftGl2Port（C8，迂腐语义软模拟，测试/MCP 域专用——用户 runtime 无 WebGL2 照旧响亮失败）。
//
// 自愈分工（ADR-0009 决定 2）：
//   - **结构自愈归 Port**：context-loss 检测、program/FBO/VAO 重建、generation++、onInvalidated 广播。
//   - **数据自愈归 backend**：内容重传（CPU tile 池恒 SSoT；bridge cpuId→gpuId 映射在 backend 侧）。
//
// ⚠ 过渡负债（C1 现状，显式记账）：`gl` 裸口 = 尚未收编成动词的调用面（合成 pass 的 uniform/纹理
//   绑定、stamp instanced draw、readPixels……全在消费侧直呼 gl.*）。终态契约（提案 §2）没有它——
//   动词面随 C5（笔画事务）/C8（SoftGl2Port 落地，被迫收口）逐片收编，SoftGl2Port 进场前必须清零。
//   新代码不许扩大 gl 裸口的用法面（handoff §1 C1：「接口就这几个动词，别扩」）。

// 渲染目标精度档：u8=RGBA8（present/屏显），f16=RGBA16F（合成累积，§7 banding bonus），
//   f32=RGBA32F（精度验证/陡 blend 模式；比 f16 多一倍 transient，仅累积器一张、不乘层数）。
export type FBOPrec = "u8" | "f16" | "f32";

// 壳填好的能力数据（Port 构造时探测一次；backend 只读）。
export interface Gl2Caps {
  maxTextureSize: number;        // MAX_TEXTURE_SIZE（iPad Apple GPU ≥ 16384）
  maxArrayLayers: number;        // MAX_ARRAY_TEXTURE_LAYERS（tile 池深度上界）
  maxTextureUnits: number;       // MAX_TEXTURE_IMAGE_UNITS（≥16；用不到那么多，ping-pong 逐层叠）
  floatColorBuffer: boolean;     // 能否渲到 RGBA16F/32F（EXT_color_buffer_float）
}

// 池化的离屏渲染目标：framebuffer + 它的颜色纹理。句柄对 backend 不透明（SoftGl2Port 可自造同形对象）。
export interface PooledFBO {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
  prec: FBOPrec;
}

export interface Gl2Port {
  readonly caps: Gl2Caps;

  // ---- 结构自愈契约 ----
  // context 丢失中（真机后台切走等）。丢失期渲染调用方自行早退（板级契约：isLost → 本帧放弃）。
  readonly isLost: boolean;
  // 结构自愈纪元：每次 loss→重建 +1。持久 GL 对象 holder（如 stamp 实例 VAO）缓存创建时的
  //   generation，与此不等即重建（restore 后旧句柄全废）。
  readonly generation: number;
  // 失效广播（多播）：重建完成（generation 已 ++、program 已重编、FBO 池已清）后通知——
  //   全部驻留/映射作废，backend 惰性从 CPU SSoT 重传。
  onInvalidated(cb: () => void): void;

  // ---- shader program（按名注册缓存；restore 后自动重编） ----
  // 按 name 取已编译 program；首次需给源。（C8 起注册表扩成 { GLSL 源, CPU 等价函数 } 的
  //   GPU/CPU 对表——新 shader 不配 CPU 版必须显式 GPU-only 登记，ADR-0009 决定 5。）
  program(name: string, vert?: string, frag?: string): WebGLProgram;

  // ---- FBO 借还（有界池：MRU 复用、LRU 驱逐真删） ----
  borrowFBO(w: number, h: number, prec?: FBOPrec): PooledFBO;
  returnFBO(f: PooledFBO): void;
  // 清空 FBO 池并真删资源（doc 尺寸变——池里全是旧尺寸永不再命中，主动清）。
  clearPool(): void;
  // dev HUD：池占用（确认有界）。
  readonly fboPoolStats: { count: number; bytes: number };

  // ---- 单位 quad（两三角覆盖 [0,1]²；位置即 uv）——按名 shader 画 quad 的公共载具 ----
  quadVAO(): WebGLVertexArrayObject;

  // ---- ⚠ 过渡裸口（见文件头「过渡负债」）：未收编的动词面。终态删除。 ----
  readonly gl: WebGL2RenderingContext;
}
