// 笔画事务 StrokeSession（C5，提案 §6.1「累积真改 → stroke 档」的唯一档口）。
//
// 一次手势 = 一个 session = 一个 wp2 令牌 = 一步 undo；no-op 笔画（collector 空）不占步。
// **全部笔类共用这一个档口**（brush/eraser/形状笔/液化/filterBrush——census §3.8：差异全在
// ResolvedBrush 快照与 engineKey 内部，不需要 per-tool 档口）。session 对象 = 令牌句柄
// （backend interface `strokeBegin(...): StrokeId` 的进程内化身；C7 api 化时逐字升格）。
//
// 分工（§6.2 两层防线）：input（frontend）只做手势路由 + 投喂 (x,y,p,t) + EditMode fail-safe；
// 令牌开合 / GPU commit / 选区 finalize / 记账编排全在这（令牌墙 fail-loud 兜底）。
// begin 即开令牌（单令牌墙：第二个 begin 会被 workpiece throw——响亮拒绝，不排队不静默）；
// 引擎 beginStroke 由调用方随后自调（各引擎 begin 签名不同：brush 8 参 / filterBrush 吃
// Filter+params+selection）；begin 失败调用方必须 cancel() 收口令牌，否则后续 begin 全被挡死。
//
// deps 全函数面：正好是原 input._endStroke/_abortStroke 摸过的六个点，不多不少。
// commitStamps/invalidate 是屏显侧（board）的注入——终态归 backend 自持（Gl2Port），C7/C8 收编。

import type { BrushEngine } from "./brush.ts";
import type { FilterBrushEngine } from "./filter-brush.ts";
import type { ShapeBrushEngine } from "./shape-brush.ts";
import type { ViewLeaf } from "./workpiece/painting-view.ts";
import type { WriteToken } from "./workpiece/workpiece.ts";
import type { Selection } from "./selection.ts";

// 液化 = filterBrush 的 LiquifyFilter payload（v132 起无直连双轨）。
export type StrokeEngine = BrushEngine | FilterBrushEngine | ShapeBrushEngine;
export type StampCollect = NonNullable<ReturnType<BrushEngine["collectStamps"]>>;

export interface StrokeSessionDeps {
  /** wp2.begin —— 单令牌墙的开口（第二个 begin → throw） */
  begin(historyType: string): WriteToken;
  /** LayerTiles.tokenChanged —— 本令牌内该层是否真动过（finalize 谓词，防白付物化钱） */
  tokenChanged(layerId: number): boolean;
  /** LayerTiles.tokenBeforeImage —— 笔前像素现算（finalize 的 pre 图；只在真动过时才调） */
  tokenBeforeImage(layerId: number): Parameters<Selection["applyMaskPostStroke"]>[1];
  /** doc.selection 读面（finalize 兜底用；无选区 → null） */
  getSelection(): Selection | null;
  /** board.commitBrushStroke —— GPU merge（live 同一 shader）。true = 选区已在 shader 裁 */
  commitStamps(cs: StampCollect): boolean;
  /** board.invalidateAll —— 落层/回滚后的重渲通知 */
  invalidate(): void;
}

// begin 期策略（engine-registry PIXEL_STROKE_SPECS 的子集：session 只关心事务面）
export interface StrokeSessionSpec {
  /** 令牌事务标签（wp2.begin(label)） */
  historyType: string;
  /** 抬笔是否按选区 applyMaskPostStroke（filterBrush 在 begin 已吃 selection → false） */
  finalize: boolean;
}

export class StrokeSession {
  readonly engine: StrokeEngine;
  readonly layer: ViewLeaf;
  /** 描边中原地写真层（liquify/filterBrush/pixelMode）——board live-sync 判据 */
  readonly inPlace: boolean;
  private readonly finalize: boolean;
  private readonly token: WriteToken;
  private readonly deps: StrokeSessionDeps;
  private _open = true;

  constructor(deps: StrokeSessionDeps, engine: StrokeEngine, layer: ViewLeaf, spec: StrokeSessionSpec, inPlace: boolean) {
    this.deps = deps;
    this.engine = engine;
    this.layer = layer;
    this.finalize = spec.finalize;
    this.inPlace = inPlace;
    this.token = deps.begin(spec.historyType);
  }

  get open() { return this._open; }

  /** 投喂一个输入事件（x,y 为 doc 坐标；t = 事件 timeStamp，手感数学的唯一时钟） */
  extend(x: number, y: number, pressure: number, t: number | null = null) {
    this.engine.extendStroke(x, y, pressure, t);
  }

  /** 引擎累积的 dirty bbox（board.markDocDirty 用）；无 → null */
  flushDirty() { return this.engine.flushDirty(); }

  /** GPU stamp overlay 拉取（brush/形状笔有；liquify/filterBrush 无 → null，走 live-sync） */
  collectStamps(): StampCollect | null {
    const eng = this.engine as { collectStamps?: () => StampCollect | null };
    return eng.collectStamps?.() ?? null;
  }

  // 抬笔收口（原 input._endStroke，S8 语义逐字迁入）：
  //   buffered（brush/形状笔）→ engine.endStroke 返 StampCollect → GPU commit（选区/锁α/blend/
  //   opacity 全在 shader，live 即 commit 所见）；liquify/filterBrush/pixelMode 返 null（描边中
  //   已 in-place 落层）→ 只清状态。finalize（applyMaskPostStroke CPU 兜选区）只兜没走 GPU
  //   commit 的路径；pre 图从 collector 现算（tokenBeforeImage）——只有真动过层且带选区才付
  //   物化钱；兜出来的回写仍在令牌内（首捕获已在，undo 包不变）。
  end() {
    if (!this._open) return;
    this._open = false;
    const cs = (this.engine.endStroke() ?? null) as StampCollect | null;
    let gpuCommitted = false;
    if (cs && cs.stamps.length) gpuCommitted = this.deps.commitStamps(cs);
    const sel = (this.finalize && !gpuCommitted && this.deps.tokenChanged(this.layer.id)) ? this.deps.getSelection() : null;
    if (sel) {
      sel.applyMaskPostStroke(
        this.layer as unknown as Parameters<Selection["applyMaskPostStroke"]>[0],
        this.deps.tokenBeforeImage(this.layer.id));
    }
    this.token.commit();
    this.deps.invalidate();
  }

  // 取消（原 input._abortStroke）：引擎丢状态 + collector 倒序回滚，无痕（interrupt=cancel 家规）。
  cancel() {
    if (!this._open) return;
    this._open = false;
    this.engine.cancelStroke();
    this.token.cancel();
    this.deps.invalidate();
  }
}
