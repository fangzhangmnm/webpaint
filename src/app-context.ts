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

import type { PaintDoc } from "./doc.js";
import type { Board } from "./board.js";
import type { InputController } from "./input.js";
import type { EditMode } from "./edit-mode.js";
import type { UndoStack } from "./history.js";
import type { PixelEdit } from "./pixel-edit.js";
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
  filterBrush: { Filter: unknown; params: unknown; variantLabel?: string } | null;
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
  get(): unknown;
  setRack(rack: unknown): void;
  persist(): Promise<unknown>;
  [k: string]: unknown;
}
// 浮窗（side-windows.ts）：参考窗 / 调色板窗——方法集不同，分两个句柄。
export interface ReferenceWindowHandle {
  getSerializedState(): unknown;
  applySerializedState(s: unknown): void;
  clearBitmap(): void;
  setBitmap(bitmap: ImageBitmap, opts?: { persistBlob?: Blob | null }): void;
  getPersistBlob(): Blob | null;
  close?(): void;
  [k: string]: unknown;
}
export interface PaletteWindowHandle {
  getSerializedState(): unknown;
  applySerializedState(s: unknown): void;
  clear?(): void;
  close?(): void;
  [k: string]: unknown;
}
// 图库（ui/gallery.ts mountGallery 返回）。
export interface GalleryHandle {
  refresh(): void;
  setFolder(folder: string): void;
  [k: string]: unknown;
}
// 左栏 dial 组件句柄（ui/left-dial.ts）。
export interface LeftDialHandle { [k: string]: unknown; }
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
  store: typeof import("./app-store.js").store;     // app-store.js re-export store/** 的真 store（类型穿 .js 存活，batch 4 验证）
  setStatus: (text: string, persist?: boolean) => void;
  withBusy: <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;
  leftDial: LeftDialHandle;
  updateSaveStatus: () => void;
  updateZoomLabel: () => void;
  updateNewerBanner: (...args: unknown[]) => void;

  // transient 面板 / 变换护栏（transient-panels.ts / layer-undo.ts）
  _suppressTransientPanels: () => void;
  _restoreTransientPanels: () => void;
  layerSpecFrom: (...args: unknown[]) => unknown;
  _bringPanelTop: (...args: unknown[]) => void;
  _commitTransform: () => void;
  _cancelTransform: () => void;
  selectionToNewLayer: (...args: unknown[]) => void;
  importImageAsLayer: (...args: unknown[]) => unknown;
  afterDocChange: (...args: unknown[]) => void;

  // 浮窗（side-windows.ts，module-eval 即构造）
  referenceWindow: ReferenceWindowHandle;
  paletteWindow: PaletteWindowHandle;

  // 跨模块函数
  setColor: (hex: string) => void;
  applyCheckerboard: (...args: unknown[]) => void;
  renderLayersPanel: () => void;
  setGalleryOpen: (open: boolean) => void;
  gateCloudSyncOnOpen: (...args: unknown[]) => Promise<unknown>;
  checkQuotaAndWarn: (...args: unknown[]) => unknown;
  uniqueLocalName: (...args: unknown[]) => string;
  getLocalSavedAtLabel: (...args: unknown[]) => string;
  showFullscreenBusy: (...args: unknown[]) => void;
  hideFullscreenBusy: () => void;

  // 晚绑（app.js 用 getter 透传，gallery const 在 mountGallery 后构造）
  readonly gallery: GalleryHandle;
}
