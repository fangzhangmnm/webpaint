// AppContext —— 组合根（app.js）一次构造、即刻冻结的显式装配上下文（CONTEXT「AppContext」）。
//
// 背景：god-file 肢解后，~20 个深模块靠 `let doc:any, board:any…; initX(ctx)` 接 app 单例
// （survey「每 initX 声明自用 key」）。那 ~150 个 `any` 不是 20 个独立问题——是**同一份缺失契约**
// 抄了 20 遍。这里把那份契约收成**一处** interface：app.js 的 ctx 字面量（39 键）= 此接口的实现，
// 每个 initX(ctx: AppContext) 签它 → 一处真理、处处复用、改 ctx 形状编译器即点出受影响模块。
//
// 类型策略（见 docs/ts-migration.md「seam 优先 + 诚实描述现状」）：
//   · 引擎单例（doc/board/input/editMode/history/pixelHistory）= `import type` 自未类型化的 .js class
//     → 拿 tsc 从 JS 推断出的真实实例形状，**零额外迁移**、不连带把别的 .ts 拖进门（.js 走 checkJs:false）。
//   · currentBrush 的 ResolvedBrush 来自已入门的 resolved-brush.ts。
//   · 反应式 state / dialReactive / rack / 浮窗 / gallery 的形状暂在此**诚实描述**（不 import 其 .ts 源，
//     避免 cascade 把屎山拖进门）——随各源逐步类型化再收敛引用。本接口是增量推进的锚，不是终态。

import type { PaintDoc } from "./doc.ts";
import type { Board } from "./board.ts";
import type { InputController } from "./input.ts";
import type { EditMode } from "./edit-mode.ts";
import type { UndoStack } from "./history.ts";
import type { PixelEdit } from "./pixel-edit.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";

// ---- 反应式 RAM 态（editor-state.ts 的 state/dialReactive；此处描述消费方读到的字段）----

export interface ToolDial {
  size: number;
  opacity?: number;
  flow?: number;
  activeBrushId?: string | null;
  activeBrushName?: string | null;
  variantId?: string | null;
}
export interface EditorRuntimeState {
  filterBrush: { Filter: unknown; params: Record<string, unknown>; variantId?: string; variantLabel?: string } | null;
  color: string;
  pressureToSize: boolean;
  pressureToOpacity: boolean;
  longPressPick: boolean;
  singleFingerDraw: boolean;
  pickMode: string;
  checkerboard: boolean;
  toolStates: Record<string, ToolDial>;
}
export interface DialReactive {
  tool: string;
  color: string;
  pressureToSize: boolean;
  pressureToOpacity: boolean;
  rackVersion: number;
  canDraw: boolean;
}

// ---- 句柄类（深源未入门，先描述消费方用到的接口；grow as needed）----

// 笔架（brush-rack.ts）。仅列消费方实际调到的成员；随 brush-rack 类型化再收敛。
export interface RackHandle {
  getRackToolKey(tool: string): string;
  findToolBrush(dial: ToolDial): { id: string; name?: string } | null;
  findToolBrushPure(dial: ToolDial): { name?: string; size?: { max?: number } } | null;
  openBrushSettings(id: string): void;
  applyToolState(tool: string): void;
  // boot 编排（initRackBoot）用到的：
  load(): Promise<unknown>;
  defaultToolStateFor(tool: string): Partial<ToolDial>;
  checkCloud(): Promise<unknown>;
  refreshCloudState(): void;
  get(): { brushes: unknown[] } | null;
  setRack(rack: unknown): void;
  persist(): Promise<unknown>;
  // 重置笔架（topbar-menu）：
  reset(force?: boolean): void;
  syncCloud(): void;
  // v319：去掉 [k:string]:unknown index sig —— 真 BrushRack 类无 index sig 故装不进；
  //   去掉后 BrushRack 直接 assignable（已满足上列全部具名成员），ctx 得以验证而非 cast。
}
// 浮窗（side-windows.ts）：参考窗 / 调色板窗——方法集不同，分两个句柄。
export interface ReferenceWindowHandle {
  getSerializedState(): unknown;
  applySerializedState(s: unknown): void;
  clearBitmap(): void;
  setBitmap(bitmap: ImageBitmap, opts?: { persistBlob?: Blob | null }): void;
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
  doc: PaintDoc;
  board: Board;
  input: InputController;
  history: UndoStack;
  pixelHistory: PixelEdit;
  rack: RackHandle;

  // 同步存储 / HUD
  store: typeof import("./app-store.ts").store;     // app-store.js re-export store/** 的真 store（类型穿 .js 存活，batch 4 验证）
  setStatus: (text: string, persist?: boolean) => void;
  withBusy: <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;
  leftDial: LeftDialHandle;
  updateSaveStatus: () => void;
  updateZoomLabel: () => void;
  updateNewerBanner: () => void;   // v319：真实现无参（save-status.ts）

  // transient 面板 / 变换护栏（transient-panels.ts / layer-undo.ts）
  _suppressTransientPanels: (mode: string) => void;   // v319：真实现 mode 必填（allow[mode]），原 reason?: 太松
  _restoreTransientPanels: () => void;
  layerSpecFrom: (L: unknown) => ReturnType<PaintDoc["layerSpec"]>;   // v319：真返回 doc.layerSpec 的 LayerSpecShape（doc.ts 未导出 → 经 ReturnType 取）
  _bringPanelTop: (el: HTMLElement | null) => void;   // v319：= surfaces.raiseWindow
  _commitTransform: () => void;
  _cancelTransform: () => void;
  selectionToNewLayer: (arg: { move: boolean }) => void;   // v319：真实现解构 { move }
  importImageAsLayer: (file: File, opts?: { center?: { x: number; y: number } }) => Promise<void>;   // v319：真实现 async，opts 有默认值
  afterDocChange: () => void;   // v319：= layer-undo._afterDocChange，无参

  // 浮窗（side-windows.ts，module-eval 即构造）
  referenceWindow: ReferenceWindowHandle;
  paletteWindow: PaletteWindowHandle;

  // 跨模块函数
  setColor: (hex: string) => void;
  applyCheckerboard: (on: boolean) => void;   // v319：真实现 settings-menu.applyCheckerboard
  renderLayersPanel: () => void;
  setGalleryOpen: (open: boolean) => void;
  gateCloudSyncOnOpen: (sessionName: string) => Promise<void>;   // v319：真实现 cloud-freshness，async 无显式返回值
  checkQuotaAndWarn: () => Promise<void>;   // v319：真实现 gallery-shell，async 无参无返回值
  uniqueLocalName: (stem: string) => Promise<string>;   // v319：真实现 gallery-shell，async
  getLocalSavedAtLabel: () => string;   // v319：真实现 cloud-freshness，无参
  showFullscreenBusy: (msg?: string) => void;   // v319：真实现 fullscreen-busy
  hideFullscreenBusy: () => void;

  // 晚绑（app.js 用 getter 透传，gallery const 在 mountGallery 后构造）
  readonly gallery: GalleryHandle;
}
