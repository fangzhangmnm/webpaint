// AppContext —— 组合根（app.js）一次构造、即刻冻结的显式装配上下文（CONTEXT「AppContext」）。
//
// 背景：god-file 肢解后，~20 个深模块靠 `let doc:any, board:any…; initX(ctx)` 接 app 单例
// （survey「每 initX 声明自用 key」）。那 ~150 个 `any` 不是 20 个独立问题——是**同一份缺失契约**
// 抄了 20 遍。这里把那份契约收成**一处** interface：app.js 的 ctx 字面量（39 键）= 此接口的实现，
// 每个 initX(ctx: AppContext) 签它 → 一处真理、处处复用、改 ctx 形状编译器即点出受影响模块。
//
// 类型策略（见 ai-docs/20260619-ts-migration.md「seam 优先 + 诚实描述现状」）：
//   · 引擎单例（doc/board/input/editMode/history）= `import type` 自未类型化的 .js class
//     → 拿 tsc 从 JS 推断出的真实实例形状，**零额外迁移**、不连带把别的 .ts 拖进门（.js 走 checkJs:false）。
//   · currentBrush 的 ResolvedBrush 来自已入门的 resolved-brush.ts。
//   · 反应式 state / dialReactive / rack / 浮窗 / gallery 的形状暂在此**诚实描述**（不 import 其 .ts 源，
//     避免 cascade 把屎山拖进门）——随各源逐步类型化再收敛引用。本接口是增量推进的锚，不是终态。

import type { PaintingView } from "./workpiece/painting-view.ts";
import type { Board } from "./board.ts";
import type { InputController } from "./input.ts";
import type { EditMode } from "./edit-mode.ts";
import type { History } from "./workpiece/history.ts";
import type { LayersFace } from "./layers-face.ts";
import type { PaintingWorkpiece } from "./workpiece/painting-workpiece.ts";
import type { LayerTiles } from "./workpiece/layer-tiles.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";

// ---- 反应式 RAM 态（editor-state.ts 的 state/dialReactive；此处描述消费方读到的字段）----

export interface ToolDial {
  size: number;
  opacity?: number;
  activeBrushId?: string | null;
  activeBrushName?: string | null;
  variantId?: string | null;
}
export interface EditorRuntimeState {
  filterBrush: { Filter: unknown; params: Record<string, unknown>; variantId?: string; variantLabel?: string } | null;
  color: string;
  longPressPick: boolean;
  singleFingerDraw: boolean;
  pickMode: string;
  checkerboard: boolean;
  toolStates: Record<string, ToolDial>;
}
export interface DialReactive {
  tool: string;
  color: string;
  canDraw: boolean;
  pressureOff: boolean;   // 禁用笔压（per-doc desk：desk.pressureDisabled 绑定于此）
}

// ---- 句柄类（深源未入门，先描述消费方用到的接口；grow as needed）----

// 笔架（brush-rack-controller.ts）。仅列消费方实际调到的成员。
export interface RackHandle {
  getRackToolKey(tool: string): string;
  findToolBrush(dial: ToolDial): { id: string; name?: string } | null;
  findToolBrushPure(dial: ToolDial): { name?: string; size?: { max?: number } } | null;
  openBrushSettings(id: string): void;
  applyToolState(tool: string): void;
  // boot 编排（initRackBoot）用到的：
  load(): Promise<unknown>;
  defaultToolStateFor(tool: string): Partial<ToolDial>;
  get(): { brushes: unknown[] };
  // 云端事件驱动重拉（刷新按钮 / 前台）：
  reconcileWithRemote(): Promise<{ status: string; pushed?: boolean; error?: unknown }>;   // 读 status，别只 await（v436）
  // 重置出厂笔（topbar-menu · 非破坏性覆盖同 id）：
  restoreBuiltins(): Promise<number>;   // 返回还原了几支内置笔；0 = 失败（已 surface）
  // v319：去掉 [k:string]:unknown index sig —— 真 controller 类无 index sig 故装不进；
  //   去掉后 controller 直接 assignable（已满足上列全部具名成员），ctx 得以验证而非 cast。
}
// 浮窗（side-windows.ts）：参考窗 / 调色板窗——方法集不同，分两个句柄。
export interface ReferenceWindowHandle {
  // 参考窗 open/位置/vp 已迁 desk.refPanel（2026-07-14）；不再 getSerializedState/applySerializedState。
  clearBitmap(): void;
  setBitmap(bitmap: ImageBitmap, opts?: { persistBlob?: Blob | null; skipFit?: boolean }): void;
  getPersistBlob(): Blob | null;
  close?(): void;
}
export interface PaletteWindowHandle {
  getSerializedState(): unknown;
  applySerializedState(s: unknown): void;
  clear?(): void;
  close?(): void;
}
// 图库句柄 = ui/gallery.ts mountGallery 的真返回类型（单一真源，弃本地镜像 v319）。
import type { GalleryHandle } from "./ui/gallery.ts";
export type { GalleryHandle };
// 左栏 dial 组件句柄 = ui/left-dial.ts 的真返回类型（单一真源，弃本地占位 v319）。
import type { LeftDialHandle } from "./ui/left-dial.ts";
export type { LeftDialHandle };
// 当前笔：Vue computed of ResolvedBrush（引擎只读 .value）。
export interface CurrentBrushRef { readonly value: ResolvedBrush; }

// ---- 装配上下文（= app.js ctx 字面量，39 键）----

export interface AppContext {
  // 反应式 SSoT
  state: EditorRuntimeState;
  dialReactive: DialReactive;
  currentBrush: CurrentBrushRef;

  // 核心引擎单例
  editMode: EditMode;
  doc: PaintingView;             // T3b-2：树模式端口（DocView 同形读面 + 选区过渡宿）。docRaw 已杀——
                                 // 装载/换文档走 wp2.load()（令牌写），不存在 raw 逃生门。
  board: Board;
  input: InputController;
  history: History;              // v2 undo 编排器（共享令牌开/续/封 + undo/redo 门 + 不可恢复协议）
  layers: LayersFace;            // 结构类写面门面（图层结构入口：withPoint 整点 + statuses hint）
  wp2: PaintingWorkpiece;        // v2 工件（令牌工厂；像素写 = begin() + 直写，collector 自动记账）
  layerTiles: LayerTiles;        // v2 像素组件（= wp2.layerTiles，热路径直取）
  rack: RackHandle;

  // 同步存储 / HUD
  store: typeof import("./app-store.ts").store;     // app-store.js re-export store/** 的真 store（类型穿 .js 存活，batch 4 验证）
  setStatus: (text: string, persist?: boolean) => void;
  withBusy: <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;
  leftDial: LeftDialHandle;
  updateSaveStatus: () => void;
  // 「操作做到一半」统一谓词（user pin 2026-07-24：auto 不打断半成品操作）。true = 笔画进行中 /
  //   浮层变换挂着 / transient 待决 / fill 预览挂着。idle autosave 之类的自动动作据此让路；
  //   crash-safety flush（pagehide/blur）**不受此门**——数据安全词典序优先。
  isMidOperation: () => boolean;
  // 把 4 个 settings/state collection 拉云对齐（per-key LWW；离线/local-only 内部 no-op）。
  // 组合根拥有（它是唯一同时认识 app-prefs 和 app-state 的地方）。**fire-and-forget，调用方别 await。**
  pullSettingsAndState: () => void;
  updateZoomLabel: () => void;
  updateNewerBanner: () => void;   // v319：真实现无参（save-status.ts）

  // transient 面板 / 变换护栏（transient-panels.ts）
  _suppressTransientPanels: (mode: string) => void;   // v319：真实现 mode 必填（allow[mode]），原 reason?: 太松
  _restoreTransientPanels: () => void;
  _bringPanelTop: (el: HTMLElement | null) => void;   // v319：= surfaces.raiseWindow
  _commitTransform: () => void;
  _cancelTransform: () => void;
  selectionToNewLayer: (arg: { move: boolean }) => void;   // v319：真实现解构 { move }
  importImageAsLayer: (file: File, opts?: { center?: { x: number; y: number } }) => Promise<void>;   // v319：真实现 async，opts 有默认值
  afterDocChange: () => void;   // 面板刷新+重绘（组合根内联定义）

  // 浮窗（side-windows.ts，module-eval 即构造）
  referenceWindow: ReferenceWindowHandle;
  paletteWindow: PaletteWindowHandle;

  // 跨模块函数
  setColor: (hex: string) => void;
  applyCheckerboard: (on: boolean) => void;   // v319：真实现 settings-menu.applyCheckerboard
  renderLayersPanel: () => void;
  setGalleryOpen: (open: boolean) => void;
  checkQuotaAndWarn: () => Promise<void>;   // v319：真实现 gallery-shell，async 无参无返回值
  uniqueNameFor: (stem: string) => Promise<string>;    // 取一个不占用的名字（走 store.files.nameOccupied；本地+在线云端）
  showFullscreenBusy: (msg?: string) => void;   // v319：真实现 fullscreen-busy
  hideFullscreenBusy: () => void;

  // S8：空闲调度深模块（tile 压缩 + autosave 共用；app.ts 的 initTileJobs 造）。
  bgJobs: { register(name: string, priority: number, handler: (deadlineTs: number) => "done" | "requeue", opts?: { minIdleMs?: number }): () => void };

  // 晚绑（app.js 用 getter 透传，gallery const 在 mountGallery 后构造）
  readonly gallery: GalleryHandle;
}
