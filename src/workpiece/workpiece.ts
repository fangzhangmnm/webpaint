// workpiece —— 文档聚合根 + document-operator 基类 + 写锁（0.4 纪元，spec: journal/20260721 Architecture.md）。
//
// 三件东西**同居一个模块**是设计（privacy 机制）：
//   - WorkpieceInternals 存在模块私有 WeakMap 里（不 export）——比 TS private 硬：模块外**没有任何
//     路径**拿到内部可变数据。DocumentOperator 与数据同模块 → protected mut() 拿得到；
//     继承 operator 的外部代码经 mut() 访问；其余一律窄读接口。
//   - 写 workpiece 的唯一合法路径 = UndoHistory.run(operator)。operator **必须同步**（硬规则：
//     js 单线程 coroutine 下同步 = 天然原子；异步等待期间绝不持锁）。
//   - 锁是防御性 assert（两层保险之二）：run 拿锁→forward→放锁；重入/并发直接 throw。
//
// 迁移期形态（v0.4.4）：internals 以现有 PaintDoc 为载体（hierarchy/layers/selection/reference
// 都在 doc 上）。后续切片把 doc 的可变方法逐步下沉成 operator、组件收窄；渲染/导出经窄读接口。
// workpiece 不碰 store（红线；持久化归 importer/exporter/persistency 管，它们只读写快照）。

import type { PaintingView } from "./painting-view.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
import { enterDocWrite, exitDocWrite } from "./write-gate.ts";
import type { LayerTree } from "./layer-tree.ts";
import type { SelectionFace } from "./selection-face.ts";

// T3b-2：internals 载体从 PaintDoc 换成 PaintingView（树模式端口）。T4 后留桥的 operator
// 只剩 docResize/fillColor，经 mut(w).doc 读写的面由端口同形提供。T5 本类整体退场。
// （float 类型族 + 状态已迁 float-component.ts——T4b。）
export interface WorkpieceInternals {
  doc: PaintingView;
}

const INTERNALS = new WeakMap<Workpiece, WorkpieceInternals>();

export class Workpiece {
  /** 运行时数据是否偏离上次持久化（autosave/保存编排读写；operator 提交自动置 true）。 */
  isDirty = false;

  /** 构造期注入的 undo system（ADR-0007：capability 绑构造期；component 写 API 经它记账）。
   *  T2 起类型收成 HistoryFacade：真 UndoHistory（引擎测试）与 LegacyHistory 桥（app，骑 v2 栈）都满足。 */
  readonly history: HistoryFacade;

  private _commitVersion = 0;
  private _lockHolder: string | null = null;
  private _layers: LayerTree | null = null;
  private _sel: SelectionFace | null = null;

  constructor(doc: PaintingView, history: HistoryFacade) {
    INTERNALS.set(this, { doc });
    this.history = history;
  }

  /** 结构类写面（S1 第一个 component：层树增删/复制/移动/合并/属性/结构 tx）。
   *  写 doc 结构的唯一合法门——app 层不再直接 doc.addLayer + 手工记账。 */
  get layers(): LayerTree {
    if (!this._layers) throw new Error("Workpiece: LayerTree 未装配（组合根须紧随构造 new LayerTree）");
    return this._layers;
  }
  /** LayerTree 构造时自注册（单次；组合根协作面，外部勿调）。
   *  值 import LayerTree 会成环（workpiece→layer-tree→operators→workpiece，operators 的
   *  extends 在模块 eval 期就要 DocumentOperator）→ 组件由组合根构造、注入到此。 */
  _attachLayers(c: LayerTree): void {
    if (this._layers) throw new Error("Workpiece: LayerTree 重复装配");
    this._layers = c;
  }

  /** 选区写面（S2 第二个 component：唯一记账口 + 预览 tx 窗口）。 */
  get sel(): SelectionFace {
    if (!this._sel) throw new Error("Workpiece: SelectionFace 未装配（组合根须紧随构造 new SelectionFace）");
    return this._sel;
  }
  _attachSel(c: SelectionFace): void {
    if (this._sel) throw new Error("Workpiece: SelectionFace 重复装配");
    this._sel = c;
  }

  /** 每次 operator 提交 +1。render-tree 重建 / 缓存失效的 key。 */
  get commitVersion(): number { return this._commitVersion; }

  // ---- 窄读接口（T3b-2：readDoc() 已杀；T4b：float 读口迁 FloatLayerComponent.view()）----
  /** 端口读口（构造期未持 port 的引擎用；T5 随本类拆）。 */
  readView(): PaintingView { return INTERNALS.get(this)!.doc; }

  // ---- 锁（operator/undo-history 协作面；外部勿碰）----
  _acquireLock(holder: string): void {
    if (this._lockHolder !== null) {
      throw new Error(`Workpiece: 写锁冲突——"${this._lockHolder}" 持有中，"${holder}" 被拒（operator 禁止嵌套/并发）`);
    }
    this._lockHolder = holder;
    enterDocWrite();   // S4 割3：锁内 = 合法写窗口
  }
  _releaseLock(holder: string): void {
    if (this._lockHolder !== holder) {
      throw new Error(`Workpiece: 释放非自己持有的锁（holder=${String(this._lockHolder)}, releaser=${holder}）`);
    }
    this._lockHolder = null;
    exitDocWrite();
  }
  _isLocked(): boolean { return this._lockHolder !== null; }
  _bumpCommit(): void { this._commitVersion++; this.isDirty = true; }
}

export type OpStatus = { ok: true } | { ok: false; msg?: string };

/** undo 编排门面的公共面（T2 桥接期抽出）：真 UndoHistory 与 legacy-bridge 的 LegacyHistory 都结构满足。
 *  调用方（LayerTree/SelectionFace/doc-ops/fill/float/layers-panel/import-image）只准依赖这个形状。 */
export interface HistoryFacade {
  run<A, D>(w: Workpiece, op: DocumentOperator<A, D>, args: A, o?: { checkpoint?: boolean; label?: string }): OpStatus;
  compound<T>(w: Workpiece, fn: () => T, o?: { label?: string; hint?: (dir: "undo" | "redo") => void }): { ok: boolean; value?: T; msg?: string };
  /** v2-verb 迁移载具（T3b-2；见 legacy-bridge.withPoint）：fn 直写 v2 组件，共享令牌开/续/封。 */
  withPoint<T>(label: string | undefined, o: { checkpoint?: boolean; hint?: (dir: "undo" | "redo") => void } | undefined, fn: () => T): { ok: boolean; value?: T; msg?: string };
  sealCheckpoint(): void;
  undo(w: Workpiece): boolean;
  redo(w: Workpiece): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  readonly depth: number;
  quotaUsage(): number;
  clear(): void;
}

// forward/backward 的对称 swap 契约（spec lines 55-60）：
//   - 首次执行：forward(w, args, data=undefined) —— 从 args 推导目标态，应用，吐 replaced（= undo 包）。
//   - undo：backward(w, args, data=上次的 replaced) —— 应用逆包，吐 replaced（= redo 包）。
//   - redo：forward(w, args, data=backward 吐的 replaced) —— 再吐 undo 包。……对称往复。
// 失败语义（spec lines 64-68）：
//   - 可原子回滚的失败 → return { ok:false }（**必须已自行回滚到调用前状态**，栈安全）。
//   - 无法保证原子性的异常（罕见）→ throw —— UndoHistory 走不可恢复路径（弃整栈+integrity heal+banner）。
export interface OpResult<D> { ok: boolean; msg?: string; replaced?: D }

export abstract class DocumentOperator<A, D> {
  /** 标签（调试/状态栏/统计 key）。 */
  abstract readonly kind: string;

  /** 拿内部可变数据。仅在持锁的 forward/backward 里合法（其余时机 throw）。 */
  protected mut(w: Workpiece): WorkpieceInternals {
    if (!w._isLocked()) {
      throw new Error(`DocumentOperator(${this.kind}): mut() 只能在持锁的 forward/backward 里调`);
    }
    return INTERNALS.get(w)!;
  }

  /** 必须同步（硬规则）。见 OpResult 契约。 */
  abstract forward(w: Workpiece, args: A, data: D | undefined): OpResult<D>;
  abstract backward(w: Workpiece, args: A, data: D): OpResult<D>;

  /** 该步 undo 包的内存估计（undo-history 配额驱逐用）。tile 句柄：压缩前记 0（走共享 raw
   *  池配额）、压缩后记 compressedBytes/refCount——每次 push 全量重扫，压缩会让 usage 变。 */
  estimateQuotaBytes(_args: A, _data: D | undefined): number { return 1024; }

  /** 驱逐/清栈/截断 redo 时释放 data 持有的资源（tile 句柄 release 等）。 */
  disposeData(_args: A, _data: D | undefined): void { /* 默认无资源 */ }

  /** UI 提示（可选）：undo/redo 后的状态栏 toast 文案。UI 编排在 app 侧消费，workpiece 不碰 DOM。 */
  statusFor?(dir: "do" | "undo" | "redo", args: A): string | undefined;
}
