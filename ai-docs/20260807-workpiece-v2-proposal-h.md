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

// T3b-1 定形：PaintingData（解码器/编码器唯一交换形；判别同 TreeNode："children" in n）
//   leaf  = { id?; name; visible; opacity; mode; clippingMask; lockAlpha;
//             pixels: { rect; bytes } | null }        // 内联 tile 字节（空叶 null）
//   group = { id?; …props; children: PaintingDataNode[] }
//   root  = { width; height; backgroundColor?; activeId?; referenceLayerId?; nodes }
// load 语义：挂起 tile 收集（树根 record 已携带全部所有权）→ loadRoot 换整根 → commit →
//   undoStack.clear()（旧 doc 根 record 驱逐 = 旧 tileset 全释放，换文档零手工 dispose）→ markSaved。
// 迁移期两形态：opts.host（T2 app，doc 树背）或 opts.tree（树模式，出生单空叶）——cutover 后只剩树模式。

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
  mergeDown(id, merged: { bytes; rect; resultClipping }): boolean;   // 合成字节外部烤好递入（零 GL；
                                                  // under 归一化 opacity=1/source-over/resultClipping——T3a 定形）
  setLayerProp(id, prop, value): boolean;
  setTreeProp(key: "referenceLayerId" | "backgroundColor" | "width" | "height", value): void;
                                                  // 元规则相同才合并动词（doc 级 unique 值）；
                                                  // width/height 是 T3b-2 补——整 doc 几何变换的尺寸位
                                                  //（像素实例交换另记账，同 step 两账同向翻）
  setActive(id): boolean;                         // 唯一不记账 verb（焦点=导航，ADR-0008 §4）
  // T3b-2 补 verb（app cutover 的结构组合动作，语义对齐 v1 doc 同名 op）：
  addLayerTop(name?): TreeLeaf | null;            // 盖印 stampAll 用：新空叶强制置顶（根级末尾）
  collapseGroupToLeaf(id, merged: { bytes; rect } | null): TreeLeaf | null;   // #25 组烤成单叶同位替换
  explodeLeaf(id, parts: { data; name }[], rect): TreeLeaf[] | null;          // v0.7.9 按颜色拆分
}
// T3a 实现注：叶/组判别 = "children" in node（json 纯数据无 isGroup 标志）；结构共享实现为整树浅深拷
//（≤64 叶 KB 级，路径级共享是后续优化，契约不变）；recorded 步的根快照含 activeId → undo 天然还原焦点。
// T3b-1 补 verb（填上面记名的缺口，语义对齐 v1 doc.addGroup）：
//   addGroup(name?): TreeGroup | null;   // 空组插 active 同级之上（active 是组 → 嵌进去）；active=新组；组不计 maxLeaves
//   loadRoot(json): void;                // load 的换整根令牌写（nextId 重播种；调用方净移交新根 tileset）
//   eachLeaf(cb): void;                  // 读 helper（树背 host 的解析用）

// LayerTiles 增设 tileset 注册表（T3a；所有权算术的账房）：
//   createTileset(lp)→id（refs=1 归调用方，json 收养后 release=净移交）/ duplicateTileset(id)（句柄共享零拷贝）
//   acquireTileset / releaseTileset（归零 → lp.dispose 还池）/ tilesetPixels(id) / swapTilesetPixels(id, np)
//   exchangeTilesetPixels(id, np)→旧实例（T3b-2：swap 的非销毁变体——crop/resample 的 undo 包持前一侧实例）
//   持有者 = LayerTree 每个活根（substrate/collector/record）按 leaf.pixelsRef 各 +1；swap 交换根计数不动。

## layer-tiles.ts（tile 扁平仓；tileset 引用计数）

```ts
// T2 实现补：实例↔身份解析走 TilesHost（T2 = doc 树查找；T3 起 = LayerTree json 的 pixelsRef 表）。
interface TilesHost {
  getPixels(layerId): LayerPixels | null;
  findLayerIdByPixels(lp): number | null;         // seal 时解析；解析不到（临时实例/浮层）→ 扣押作废
  eachLayer(cb): void;
  replacePixels(layerId, np): void;               // computed 变换换整 tileset 实例
}

class LayerTiles implements WorkpieceComponent {
  // ── 读 · 档1 render 端口（零拷贝身份制）──
  version(layerId): number;                       // contentVersion；没变整层跳过
  tiles(layerId): Iterable<TileEntry>;            // TileEntry = { tx; ty; contentId; bytes(): Uint8ClampedArray }（T2 定形）
  contentBounds(layerId, tight?): Rect | null;
  // ── 读 · 档2 便捷（引擎/导出/吸管）──
  getRegion(layerId, x, y, w, h): Uint8ClampedArray;
  // ── 写（token 开着才合法；collector 自动扣押被换句柄）──
  // ⚠ 收集在 **substrate 层**（tile-layer.ts setTileSwapObserver）：engine 直写 layer 像素也被
  //   写时扣押并自动登记 touched——verbs 是便捷面不是唯一口（「结构上收不漏」的实现形态）。
  putRegion(layerId, x, y, w, h, bytes): void;
  editRegion(layerId, rect, fn): void;            // fn(buf, ox, oy) 字节版（editRegionBytes 同构）
  replaceLayer(layerId, bytes, rect): void;       // merge-down/滤镜 commit 用（清空+整块写）
  clearLayer(layerId): void;
  // ── computed record 白名单（双捕获断言：verb 内 collector 必须零收集）──
  // record 恒存 undo 包（seal 时取逆）；swap = 原样应用 + 返回其逆（rot/offset 非自逆，T2 定形）
  flipHorizontalAll(): void;  rotate90All(dir): void;  offsetWrapAll(dx, dy): void;
  // ── token 内读口（T2 补：input 选区 finalize / no-op 判定）──
  tokenChanged(layerId): boolean;                 // collector 有它的扣押？（no-op 笔画守卫 v0.6.17 后继）
  tokenBeforeImage(layerId): PreSnapImage;        // 令牌前内容紧 bbox 物化（applyMaskPostStroke 的 pre）
  _suspendCollect(on): void;                      // 迁移期协作面：legacy op 应用窗口挂起收集（T5 随桥拆）
}
// tileset 生命周期：json.pixelsRef 持有 +1 / record 持有 +1 / 归零还池（FR assert 兜漏）——T3 落地；
// T2 现状：record 持 tile 句柄（池引用计数 +1），tileset 实例仍归 doc.Layer 所有。
```

## 其余组件（T4 实现定形；record 皆自反 swap、collector 首捕获赢、净零变化不占步）

```ts
// T4a：pre-applied 双轨（引擎预览直写 + 记账写）——lasso/预览 tx 生态零改造的实现形态。
class SelectionComponent {
  view(): Selection | null;
  _rawWrite(v): void;               // 预览直写（lasso 引擎/预览 tx/pre-applied 换手；显式声明态）
  set(next): void;                  // token 写：组件自己换手（替换值所有权交 collector/即弃）
  commitPreApplied(before): void;   // token 写：after 已直写上台，before 所有权交入
  clearOnLoad(): void;              // 换文档收尾（无 token；栈随后清）
}
// record = { v: Selection|null }（另一侧，所有权归 record）。
// app 调用面 = SelectionFace 门面（workpiece.sel，T5 评估收编）：commitPreApplied 经
// history.withPoint 骑共享令牌；beginPreview() tx 窗口语义原样。

// T4b：组件 = 状态机 verbs；lift/commit/reject 的**编排**留在 FloatingTransform 引擎
// （GPU bake/采样缓存/gizmo 数学在引擎；挖洞/烤层像素由 LayerTiles 写时扣押同 step 分账、
//  选区由 SelectionComponent 分账——旧 LiftFloatOp 三元组/pre-applied ops.pixels 链死）。
class FloatLayerComponent {
  view(): Readonly<FloatState> | null;   // FloatState = { floats:[{sourceLayerId,rect,pixels}], transform }
  install(fs): void;                // lift 收尾（token）：FloatState 所有权交入；已有浮层 throw
  setTransform(meta): void;         // 变换整点（token）：只换 metadata（入参克隆）
  drop(): void;                     // 收摊（token）：accept/reject 的收尾微步
  dropForLoad(): void;              // 换文档 escape hatch（无 token；栈随后清）
}
// record 双轨：{t:"state",fs} 整包移交 / {t:"meta",meta}；同 token meta→drop 升格 state。
// float 类型族（FloatState/WorkpieceFloat/FloatTransformMeta/…）随组件迁 float-component.ts。

// T4c：色板 target 切换（fill 预览期 setColor/吸管/色词全改本组件，**笔刷色不被 undo 碰**）。
class PendingFill {
  view(): { color: string } | null;
  begin(initColor) / clear();       // 导航态声明写（进/出 fill 工具；无 token 不记账）
  setColorLive(hex): void;          // 预览直写（防抖窗口中间值）
  commitPreApplied(before): void;   // token 写：防抖 flush 一步（v0.7.8 合并语义）
}

// T4d：记账面刻意收窄 = 只有 doc 变换 remap（VP 编辑器仍 desk 直写不进栈——user 拍板
// 「VP setting 不进 undo history」在案；ADR-0008 升格解决的是 undo 与 doc 几何的同步还原）。
class PerspComponent {
  constructor(wp, host: PerspHost); // host = desk 读写口（snapshot/restore/remap——app 接 workbench-state）
  view(): unknown;                  // = host.snapshot()
  remapForDocTransform(f, opts): void;   // token 写（doc-ops compound 内）；record = 整包快照
  set(cfg): void;                   // 预留口（VP 编辑可撤化时用；现无调用方）
}

class ReferenceGallery /* silent */ { view(); setImage(blob, bitmap) / clear() }   // 未组件化（现状 sidecar）
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

## 迁移期形状（T3b-2 落，非终态契约；T4/T5 收编或拆除）

```ts
// PaintingView（src/workpiece/painting-view.ts）：app 的文档读写端口 = 旧 ctx.doc(DocView) 同形
//   （width/height/layers(view 节点)/activeId/selection/maxLayers/activeEditableLeaf/…）。
//   ViewLeaf 带旧 Layer 的读写面（pixels/bbox 物化缓存/editRegion/snapshot…），像素 = tileset
//   注册表活实例——引擎（brush/liquify/lasso/float）与 codec 消费面零改动。selection 已迁
//   SelectionComponent（T4a——端口只留镜像口 getter/setter）。终态归宿 T5 评估：要么正名
//   （app 读口保留端口形），要么随引擎迁 LayerTiles 读口后拆。
// LegacyHistory.withPoint(label, {checkpoint, hint}, fn)：v2-verb 迁移载具（共享令牌开/续/封；
//   门面 layer-tree.ts 的所有 verb 走它）。T5 随桥拆——那时调用方直接 wp2.begin。
// DocResizeOp（operators.ts——T4 后残余集的**唯一**住户）：crop/cropResample/resample 的实例
//   交换记账（undo 包 = 另一侧 LayerPixels 实例；json 尺寸走 setTreeProp width/height 进树
//   record，同 step 两账同向翻）。flip/rot90/offsetWrap 已走 computed 白名单。step.hint 已落地
//   （compound({hint})），唯一住户 = docTransform 的 viewport 还原（T4d 后 persp 归组件 record）。
```

## dials / desk（改名，形状不变）

```ts
useDials(): Dials     // 现 createEditorState() 反应式层（Vue composable 惯例）
desk                  // 现 editorState struct；文件名 .webpaint/editor-state.json 暂不改
// 旧轨 webpaint/state.json：停写；读兼容留存量
```
