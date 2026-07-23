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

import type { PaintDoc } from "../doc.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";

// ---- 浮层变换状态（S6：float 从 floating-transform 的 _ft 私有态收进 workpiece internals）----
// 像素所有权：WorkpieceFloat.pixels 归当前持有者（internals 或某个 operator 的 undo 包）所有，
// 状态对象在 internals ↔ undo 包之间**整体移交**（同一时刻只有一个 owner），漏 dispose 由池 FR 点名。
export interface FloatRect { x: number; y: number; w: number; h: number }
export type FloatMesh = { x: number; y: number }[][];   // 2×2：[[TL,TR],[BL,BR]]（doc 坐标）
export interface WorkpieceFloat {
  id: number;
  sourceLayerId: number;
  /** lift 时像素的 identity 位置（内容紧 bbox）；reject 按此写回，不走 warp 采样器。 */
  rect: FloatRect;
  /** doc 网格对齐的稀疏 tile（池驻留、可压缩；不可变——变换只动 transform metadata）。 */
  pixels: LayerPixels;
}
/** 共享 gizmo 的变换元数据（组 lift 多 float 共用一份；per-float dest quad 由 rect×单应性派生）。 */
export interface FloatTransformMeta {
  gizmoBbox: FloatRect;
  mesh: FloatMesh;
  meshN: number;
  mode: "free" | "uniform" | "distort" | null;
  uniformAspect: number;
}
export interface FloatState {
  floats: WorkpieceFloat[];
  transform: FloatTransformMeta;
}

export interface WorkpieceInternals {
  doc: PaintDoc;
  floats: FloatState | null;
}

const INTERNALS = new WeakMap<Workpiece, WorkpieceInternals>();

export class Workpiece {
  /** 运行时数据是否偏离上次持久化（autosave/保存编排读写；operator 提交自动置 true）。 */
  isDirty = false;

  private _commitVersion = 0;
  private _lockHolder: string | null = null;

  constructor(doc: PaintDoc) {
    INTERNALS.set(this, { doc, floats: null });
  }

  /** 每次 operator 提交 +1。render-tree 重建 / 缓存失效的 key。 */
  get commitVersion(): number { return this._commitVersion; }

  // ---- 窄读接口（迁移期最小集：导出数据的 escape hatch。写必须走 operator。）----
  /** 只读视图。⚠ 迁移期 escape hatch：老代码（board 渲染/导出/吸管）直读；新代码请依赖更窄的读口。 */
  readDoc(): Readonly<PaintDoc> { return INTERNALS.get(this)!.doc; }

  /** 浮层变换状态只读视图（board GPU warp 预览 / gizmo 引擎消费）。null = 无活动浮层。 */
  readFloatState(): Readonly<FloatState> | null { return INTERNALS.get(this)!.floats; }

  /** 换文档 escape hatch：直接清浮层状态并释放句柄（clearHistory/adoptState 同步调；
   *  正常编辑流走 DropFloatOp，别拿这个绕 undo）。 */
  dropFloats(): void {
    const its = INTERNALS.get(this)!;
    if (!its.floats) return;
    for (const f of its.floats.floats) f.pixels.dispose();
    its.floats = null;
  }

  // ---- 锁（operator/undo-history 协作面；外部勿碰）----
  _acquireLock(holder: string): void {
    if (this._lockHolder !== null) {
      throw new Error(`Workpiece: 写锁冲突——"${this._lockHolder}" 持有中，"${holder}" 被拒（operator 禁止嵌套/并发）`);
    }
    this._lockHolder = holder;
  }
  _releaseLock(holder: string): void {
    if (this._lockHolder !== holder) {
      throw new Error(`Workpiece: 释放非自己持有的锁（holder=${String(this._lockHolder)}, releaser=${holder}）`);
    }
    this._lockHolder = null;
  }
  _isLocked(): boolean { return this._lockHolder !== null; }
  _bumpCommit(): void { this._commitVersion++; this.isDirty = true; }
}

export type OpStatus = { ok: true } | { ok: false; msg?: string };

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
