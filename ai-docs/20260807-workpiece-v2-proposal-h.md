# workpiece v2 · 提案 .h（目标 API 全签名）
> as-of 提案 / 2026-08-07。拍板依据 = ADR-0008；施工序 = `20260807-workpiece-v2-handoff.md`。
> 现状 .h = `api/`（scripts/gen-api.sh 生成的 .d.ts 树；重构策划 ritual：现状+提案并排）。
> 性质：**契约提案**，实现时字段细节可微调，但形状/边界改动要回本文件更新（这是 pin 下来的接口）。

## undo-stack.ts（app-agnostic，零 import）

```ts
type RecordData = unknown;                       // 纯数据（句柄集/json 引用/方向位）；禁函数引用

interface WorkpieceComponent {
  readonly kind: string;                          // "layerTree" | "layerTiles" | … 开放集
  swapRecord(data: RecordData): RecordData;       // 自反：undo 倒序调、redo 正序再调一次
  recordBytes(data: RecordData): number;          // 配额估计（tile 按压缩后/refCount，规则沿用）
  disposeRecord(data: RecordData): void;          // 驱逐/清栈/cancel 释放句柄（引用计数 −1）
}

interface UndoStep {
  readonly id: number;                            // stateVersion 的锚（栈单调分配，永不复用）
  entries: { c: WorkpieceComponent; data: RecordData }[];
  label?: string;
  hint?: (dir: "undo" | "redo") => void;          // 非权威附注（ADR-0008 §7 三纪律；只捕小值）
}
type UndoStepInput = Omit<UndoStep, "id">;        // T1 实现：id 由栈分配（唯一 id 权威），push 收 input

class UndoStack {
  constructor(opts: { maxQuotaBytes: number;
                      onChange?: () => void;                     // 栈形变（按钮态/编辑门）
                      onApplied?: (step: UndoStep, dir: "undo" | "redo") => void });
  push(step: UndoStepInput): void;                // 由 WriteToken.commit 调，app 不直调
  undo(): boolean;  redo(): boolean;
  canUndo(): boolean;  canRedo(): boolean;
  cursorStepId(): number;                         // = stateVersion（栈底 = baseId：初始 0，驱逐后 = 末驱逐步 id）
  depth(): number;                                // 栈内步数（驱逐观测/调试；T1 补）
  quotaUsage(): number;  clear(): void;
  _bindWorkpiece(hooks): void;                    // Workpiece 独占协作面（beforeApply 令牌门 / afterApply 计数+信号）；app 勿碰
}
```

## workpiece.ts（app-agnostic 基类）

```ts
// T1 实现补的 collector 面（token 协作）：注册进 workpiece 的组件除 WorkpieceComponent 三方法外
// 还须 sealRecord()——commit/cancel 时打包并清空本 token 的 collector（null = 本 token 没被摸）。
interface CollectorComponent extends WorkpieceComponent { sealRecord(): RecordData | null }

class Workpiece {
  constructor(opts?: { undo?: UndoStack;          // 不传 = 无 undo（写照走令牌，record 即弃，touched 即 silentDirty）
                       onTokenLeak?: (label?: string) => void });   // FR 兜底报警（T1 补；默认 console.error）
  // ── 令牌（唯一写门）──
  begin(label?: string): WriteToken;              // 已有开着的 → throw（泄漏查获点；FR 兜底）
  // ── meta ──
  readonly commitVersion: number;                 // 单调：每次 step 应用（含 undo/redo）+1 → 渲染缓存失效
  readonly stateVersion: number;                  // 位置身份：= 游标处 step id → dirty 派生
  readonly silentDirty: boolean;                  // silent 组件动过未存
  markSaved(): void;                              // 持久层存盘后调：记 lastSaved + 清 silentDirty
  isDirty(): boolean;                             // = stateVersion !== lastSaved || silentDirty
  // ── 组件注册（子类 ctor 调）──
  protected register(c: CollectorComponent, policy: { undo: "recorded" | "silent" }): void;
  onChange(cb: (e: { kind: string; recorded: boolean }) => void): () => void;   // 统一变更信号（histchange/sidecarchange 后继）
  _componentWrite(c: CollectorComponent): void;   // 组件写路径守门（写 substrate 前必调；无令牌/未注册 → throw）；app 勿碰
}

class WriteToken {
  commit(opts?: { label?: string; hint?: (dir: "undo" | "redo") => void }): void;
  cancel(): void;                                 // 各被摸 collector 倒序回滚，无痕
  readonly open: boolean;                         // commit/cancel 后再写 → throw
}
```

## painting-workpiece.ts

```ts
class PaintingWorkpiece extends Workpiece {
  readonly layerTree: LayerTree;          // recorded
  readonly layerTiles: LayerTiles;        // recorded
  readonly selection: SelectionComponent; // recorded（不持久化，跨 session 清）
  readonly floatLayer: FloatLayerComponent; // recorded（不持久化，退出前 settle）
  readonly pendingFill: PendingFill;      // recorded（不持久化）
  readonly persp: PerspComponent;         // recorded（ADR-0008 升格；持久化去向=desk 文件）
  readonly referenceGallery: ReferenceGallery; // silent
  readonly palette: PaletteState;         // silent
  // 装载：全白构造 + load 令牌写（解码器产 plain data；随后 undo.clear）
  load(data: PaintingData): void;         // 杀 docRaw/adoptState 的后继
  exportData(): PaintingData;             // 编码器读口（冻结快照语义沿 freezeDocForEncode）
}
```

## layer-tree.ts（纯 json + 可持久化树）

```ts
// 节点 = 纯 json（结构共享：写=换新根，旧根进 record）。像素只持 pixelsRef。
interface TreeLeaf  { id; name; visible; opacity; mode; clippingMask; lockAlpha; pixelsRef: TilesetId }
interface TreeGroup { id; name; visible; opacity; mode; clippingMask; children: TreeNode[] }
type TreeNode = TreeLeaf | TreeGroup;
interface TreeJson  { nodes: TreeNode[]; activeId; referenceLayerId; backgroundColor; width; height }

class LayerTree implements WorkpieceComponent {
  view(): Readonly<TreeJson>;                     // 不可变值：发出去的引用永不被改
  // 读 helper（纯函数复用 doc.ts 树工具族：findNodeById/countLeaves/…）
  // ── verbs（token 开着才合法；边界行为写进名字）──
  addLayer(name?): TreeLeaf | null;               // null = maxLayers
  duplicateLayer(id): TreeLeaf | null;
  removeLayer(id): boolean;                       // keep-one 守卫
  removeGroupAndFillEmpty(id): boolean;           // 删组连带 children；删空补一叶
  explodeGroupInPlace(id): boolean;               // 解组：children 提到原位
  moveLayer(id, delta): boolean;
  moveIntoGroup(id, gid) / moveOutOfGroup(id): boolean;
  mergeDown(id, mergedBytes): boolean;            // 合成字节外部烤好递入（零 GL）
  setLayerProp(id, prop, value): boolean;
  setTreeProp(key: "referenceLayerId" | "backgroundColor", value): void;   // 元规则相同才合并动词
  setActive(id): boolean;                         // 唯一不记账 verb（焦点=导航，ADR-0008 §4）
}
```

## layer-tiles.ts（tile 扁平仓；tileset 引用计数）

```ts
class LayerTiles implements WorkpieceComponent {
  // ── 读 · 档1 render 端口（零拷贝身份制）──
  version(layerId): number;                       // contentVersion；没变整层跳过
  tiles(layerId): Iterable<[TileKey, TileView]>;  // TileView = { contentId; bytes(): Uint8ClampedArray }
  contentBounds(layerId): Rect | null;
  // ── 读 · 档2 便捷（引擎/导出/吸管）──
  getRegion(layerId, x, y, w, h): Uint8ClampedArray;
  // ── 写（token 开着才合法；collector 自动扣押被换句柄）──
  putRegion(layerId, x, y, w, h, bytes): void;
  editRegion(layerId, rect, fn): void;
  replaceLayer(layerId, bytes, rect): void;       // merge-down/滤镜 commit 用
  clearLayer(layerId): void;
  // ── computed record 白名单（双捕获断言：verb 内 collector 必须零收集）──
  flipHorizontalAll(): void;  rotate90All(dir): void;  offsetWrapAll(dx, dy): void;
}
// tileset 生命周期：json.pixelsRef 持有 +1 / record 持有 +1 / 归零还池（FR assert 兜漏）
```

## 其余组件（形状同族，从简列）

```ts
class SelectionComponent { view(): Selection | null; set(sel): void /* token */ }
class FloatLayerComponent {   // 组 lift 每叶一 source、共享 transform（现状语义迁移）
  view(): Readonly<FloatState> | null;   // { sources:[{sourceLayerId,rect,tilesRef}], transform } | null
  lift(...) / setTransform(...) / commit(...) / reject(...)   // 各自 token 写；identity 走 CPU 快路
}
class PendingFill { view(): { color: string } | null; begin(initColor) / setColor(c) / clear() }
class PerspComponent { view(): Readonly<PerspConfig> | null; set(cfg) / remapForDocTransform(...) }
class ReferenceGallery /* silent */ { view(); setImage(blob, bitmap) / clear() }
```

## render 侧拆分（gl/）

```ts
// 机房五件套不动：GLContext / GpuTilePool / CpuGpuTileBridge / GLCompositor / GLStampRasterizer
class RenderTree {        // 单一职责：tree composite
  constructor(room: GlRoom);                      // GlRoom = 共享机房引用包（唯一实例！）
  renderFrame(tree, viewport, bg, flags): void;   // flags = { floats[], overlay, surrogate, liveSyncLeafId }
  markDirty(): void;  handleContextRestored(): void;
}
class RasterService {     // 一次性算像素（C 骑士接缝）
  constructor(room: GlRoom);                      // 与 RenderTree 同一 room（搭 base-tile 便车）
  bakeStamps(leafId, stamps, …): boolean;         // 笔迹烤定（原 commitBrushStroke）
  warpToBytes(...): Bytes;
  compositeToBytes(tree, w, h): Bytes;  compositeToCanvas(...): HTMLCanvasElement;
  pickColor(tree, …, x, y): [r, g, b, a];
}
```

## dials / desk（改名，形状不变）

```ts
useDials(): Dials     // 现 createEditorState() 反应式层（Vue composable 惯例）
desk                  // 现 editorState struct；文件名 .webpaint/editor-state.json 暂不改
// 旧轨 webpaint/state.json：停写；读兼容留存量
```
