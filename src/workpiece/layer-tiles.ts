// layer-tiles —— workpiece v2 的像素组件（tile 扁平仓 + collector，ADR-0008 §3；T2）。
// 取代 PixelTx 的「整层句柄快照」模型：**写时扣押**——令牌开着时，任何 LayerPixels 的 tile 换手
// 经 tile-layer.ts 的全局观察者上报到这里；每 (实例, key) 只收**第一次**换手的旧句柄
// （= 令牌前原件；同 token 内后续换手换下的是本 token 的中间产物，照常 release——Krita memento 语义）。
// 好处：undo 包只含真变过的 tile（旧模型整层 acquire），且**结构上收不漏**（engine 直写 layer.pixels
// 也会被观察者逮到并自动把本组件登记进 touched——写路径不必逐个改造）。
//
// record 形态（纯数据，ADR-0008 §2）：
//   { t:"tiles", layers:[{layerId, across, tiles:[key, 句柄|null][]}] }   null = 令牌前该格为空
//   computed 白名单（省内存可逆变换，双捕获断言）：{t:"flip"} / {t:"rot",dir} / {t:"offset",dx,dy}
// swap 自反：tiles = 逐格 _swapTileHandle 换手（所有权移交）；computed = 再变换一次（rot/offset 取逆参数）。
//
// 实例↔layerId 解析走 TilesHost（T2 = doc 树查找；T3 LayerTree json 化后 = pixelsRef 表）。
// seal 时解析不到 layerId 的实例（临时 LayerPixels/浮层）扣押作废、句柄释放——非 workpiece 权威数据。
// 配额规则沿旧栈：tile 压缩前记 0（走共享 raw 池配额）、压缩后记 compressedBytes/refCount。

import { LayerPixels, setTileSwapObserver } from "../tiles/tile-layer.ts";
import type { TileHandle } from "../tiles/cpu-tile-pool.ts";
import { tilesAcross, tileKey } from "../tiles/tile-geometry.ts";
import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";

/** 实例↔身份解析 + 实例替换（computed 变换用）。T2 由 app 以 doc 树实现；T3 起归 LayerTree json。 */
export interface TilesHost {
  getPixels(layerId: number): LayerPixels | null;
  findLayerIdByPixels(lp: LayerPixels): number | null;
  eachLayer(cb: (layerId: number, lp: LayerPixels) => void): void;
  /** 换整个 tileset 实例（旧实例由 host 负责 dispose）。computed 变换 apply 用。 */
  replacePixels(layerId: number, np: LayerPixels): void;
}

interface TilesetDiff { layerId: number; across: number; tiles: [number, TileHandle | null][] }
type TilesRecord =
  | { t: "tiles"; layers: TilesetDiff[] }
  | { t: "flip" }
  | { t: "rot"; dir: 1 | -1 }               // 1 = CCW（LayerPixels.rotated90CCW 的方向）
  | { t: "offset"; dx: number; dy: number };

/** applyMaskPostStroke 的 preSnap 形状（原 pixel-tx PreSnapImage；selection.ts LayerSnapLike 同构）。 */
export interface PreSnapImage { bboxX: number; bboxY: number; bboxW: number; bboxH: number; imageData: ImageData | null }

export interface Rect { x: number; y: number; w: number; h: number }
export interface TileEntry { tx: number; ty: number; contentId: number; bytes(): Uint8ClampedArray }

export class LayerTiles implements CollectorComponent {
  readonly kind = "layerTiles";
  private _wp: Workpiece;
  private _host: TilesHost;
  private _collected = new Map<LayerPixels, Map<number, TileHandle | null>>();
  private _computed: TilesRecord | null = null;
  private _suspend = 0;

  constructor(wp: Workpiece, host: TilesHost) {
    this._wp = wp;
    this._host = host;
    // 全局观察者（tile-layer.ts 单点）：收集与否在这 gate。多 workpiece 场景（测试）后建者接管——
    // 旧实例令牌恒关不受扰。
    setTileSwapObserver((lp, key, old) => this._onTileSwap(lp, key, old));
  }

  /** legacy-bridge 协作面：旧 operator 应用期间挂起收集（其 undo 自带快照，收了=双记账）。 */
  _suspendCollect(on: boolean): void { this._suspend += on ? 1 : -1; }

  // ── 读 · 档1 render 端口（零拷贝身份制）──
  version(layerId: number): number { return this._host.getPixels(layerId)?.contentVersion ?? -1; }
  *tiles(layerId: number): IterableIterator<TileEntry> {
    const lp = this._host.getPixels(layerId);
    if (!lp) return;
    const out: TileEntry[] = [];
    lp.forEachTileHandle((tx, ty, h) => out.push({ tx, ty, contentId: h.id, bytes: () => h.clampedView() }));
    yield* out;
  }
  contentBounds(layerId: number, tight = false): Rect | null {
    return this._host.getPixels(layerId)?.contentBounds(tight) ?? null;
  }

  // ── 读 · 档2 便捷（引擎/导出/吸管）──
  getRegion(layerId: number, x: number, y: number, w: number, h: number): Uint8ClampedArray {
    const lp = this._host.getPixels(layerId);
    if (!lp) return new Uint8ClampedArray(w * h * 4);
    return lp.getRegion(x, y, w, h);
  }

  // ── 写（token 开着才合法；collector 经观察者自动扣押）──
  putRegion(layerId: number, x: number, y: number, w: number, h: number, bytes: Uint8ClampedArray): void {
    this._write(layerId).putRegion(x, y, w, h, bytes);
  }
  editRegion(layerId: number, rect: Rect, fn: (buf: Uint8ClampedArray, ox: number, oy: number) => void): void {
    const lp = this._write(layerId);
    if (rect.w <= 0 || rect.h <= 0) return;
    const buf = lp.getRegion(rect.x, rect.y, rect.w, rect.h);
    fn(buf, rect.x, rect.y);
    lp.putRegion(rect.x, rect.y, rect.w, rect.h, buf);
  }
  /** 整层替换（merge-down/滤镜 commit）：清空 + rect 整块写入（= 旧 replaceFromBytes 语义）。 */
  replaceLayer(layerId: number, bytes: Uint8ClampedArray, rect: Rect): void {
    const lp = this._write(layerId);
    lp.clear();
    if (rect.w > 0 && rect.h > 0) lp.putRegion(rect.x, rect.y, rect.w, rect.h, bytes);
  }
  clearLayer(layerId: number): void { this._write(layerId).clear(); }

  // ── computed record 白名单（双捕获断言：verb 内 collector 必须零收集，否则 throw）──
  flipHorizontalAll(): void { this._computedVerb({ t: "flip" }); }
  rotate90All(dir: 1 | -1): void { this._computedVerb({ t: "rot", dir }); }
  offsetWrapAll(dx: number, dy: number): void { this._computedVerb({ t: "offset", dx, dy }); }

  // ── token 内读口（input 选区 finalize / no-op 判定）──
  /** 本 token 是否真的动过该层（collector 有它的扣押）。 */
  tokenChanged(layerId: number): boolean {
    const lp = this._host.getPixels(layerId);
    return !!lp && (this._collected.get(lp)?.size ?? 0) > 0;
  }
  /** 令牌前该层内容的紧 bbox 物化（applyMaskPostStroke 的 preSnap）。
   *  = 现内容 + collector 扣押件盖回（未变 tile 现值即前值）。仅带选区 finalize 才付这份钱。 */
  tokenBeforeImage(layerId: number): PreSnapImage {
    const lp = this._host.getPixels(layerId);
    const empty: PreSnapImage = { bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
    if (!lp) return empty;
    const diff = this._collected.get(lp);
    this._suspendCollect(true);
    const tmp = new LayerPixels(lp.docW, lp.docH);
    try {
      const across = tilesAcross(lp.docW);
      const synth: [number, TileHandle][] = [];
      const overridden = new Set<number>();
      if (diff) for (const [key, h] of diff) { overridden.add(key); if (h) synth.push([key, h]); }
      lp.forEachTileHandle((tx, ty, h) => {
        const key = tileKey(tx, ty, across);
        if (!overridden.has(key)) synth.push([key, h]);
      });
      tmp.restore({ across, tiles: synth });   // restore 自己 acquire，synth 不持有
      const b = tmp.contentBounds(true);
      if (!b) return empty;
      return { bboxX: b.x, bboxY: b.y, bboxW: b.w, bboxH: b.h, imageData: new ImageData(tmp.getRegion(b.x, b.y, b.w, b.h), b.w, b.h) };
    } finally {
      tmp.dispose();
      this._suspendCollect(false);
    }
  }

  // ── CollectorComponent ──

  sealRecord(): RecordData | null {
    if (this._computed) {
      if (this._collectedCount() > 0) {
        this._disposeCollected();
        this._computed = null;
        throw new Error("LayerTiles: computed record 双捕获断言——computed verb 与 tile 收集同 token 并存（multiple-parallel-path 违规）");
      }
      const r = this._computed;
      this._computed = null;
      return r;
    }
    if (this._collected.size === 0) return null;
    const layers: TilesetDiff[] = [];
    for (const [lp, tiles] of this._collected) {
      const layerId = this._host.findLayerIdByPixels(lp);
      if (layerId === null) {
        // 非 workpiece 权威数据（临时实例/浮层）：扣押作废
        for (const [, h] of tiles) if (h && !h.released) h.release();
        continue;
      }
      layers.push({ layerId, across: tilesAcross(lp.docW), tiles: [...tiles.entries()] });
    }
    this._collected = new Map();
    return layers.length ? { t: "tiles", layers } : null;
  }

  swapRecord(data: RecordData): RecordData {
    const r = data as TilesRecord;
    if (r.t === "tiles") {
      for (const entry of r.layers) {
        const lp = this._host.getPixels(entry.layerId);
        if (!lp) throw new Error(`LayerTiles: undo swap 时层已不在（layerId=${entry.layerId}——栈序 bug）`);
        if (tilesAcross(lp.docW) !== entry.across) throw new Error("LayerTiles: undo swap 时层网格宽不匹配（across drift）");
        entry.tiles = entry.tiles.map(([key, h]) => [key, lp._swapTileHandle(key, h)]);
      }
      return r;
    }
    // computed：record 恒存「应用它 = 回到另一侧」的变换（seal 时已取逆）——swap = 原样应用 + 返回其逆。
    this._suspendCollect(true);
    try {
      this._applyComputed(r);
      return this._invertComputed(r);
    } finally {
      this._suspendCollect(false);
    }
  }

  recordBytes(data: RecordData): number {
    const r = data as TilesRecord;
    if (r.t !== "tiles") return 64;
    let sum = 0;
    for (const entry of r.layers) {
      sum += 64;
      for (const [, h] of entry.tiles) {
        if (!h || h.released) continue;
        if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
      }
    }
    return sum;
  }

  disposeRecord(data: RecordData): void {
    const r = data as TilesRecord;
    if (r.t !== "tiles") return;
    for (const entry of r.layers) for (const [, h] of entry.tiles) if (h && !h.released) h.release();
  }

  // ── 内部 ──

  private _onTileSwap(lp: LayerPixels, key: number, old: TileHandle | null): void {
    if (this._suspend > 0 || !this._wp.tokenOpen) return;
    this._wp._componentWrite(this);   // 写即登记 touched（无令牌不可能到这——tokenOpen 已 gate）
    let tiles = this._collected.get(lp);
    if (!tiles) { tiles = new Map(); this._collected.set(lp, tiles); }
    if (!tiles.has(key)) tiles.set(key, old ? old.acquire() : null);   // 首捕获赢：只留令牌前原件
  }

  private _write(layerId: number): LayerPixels {
    this._wp._componentWrite(this);
    const lp = this._host.getPixels(layerId);
    if (!lp) throw new Error(`LayerTiles: 层不存在（layerId=${layerId}）`);
    return lp;
  }

  private _computedVerb(r: TilesRecord): void {
    this._wp._componentWrite(this);
    if (this._computed) throw new Error("LayerTiles: 一个 token 只准一个 computed record");
    if (this._collectedCount() > 0) throw new Error("LayerTiles: computed verb 前本 token 已有 tile 收集（双捕获断言）");
    this._suspendCollect(true);
    try {
      this._applyComputed(r);
    } finally {
      this._suspendCollect(false);
    }
    if (this._collectedCount() > 0) throw new Error("LayerTiles: computed verb 期间发生 tile 收集（双捕获断言）");
    this._computed = this._invertComputed(r);   // 入栈的是 undo 包：应用它 = 撤销刚做的变换
  }

  private _applyComputed(r: TilesRecord): void {
    if (r.t === "flip") this._applyAll((lp) => lp.flippedHorizontal());
    else if (r.t === "rot") this._applyRot(r.dir);
    else if (r.t === "offset") this._applyAll((lp) => lp.offsetWrapped(((r.dx % lp.docW) + lp.docW) % lp.docW, ((r.dy % lp.docH) + lp.docH) % lp.docH));
  }
  private _invertComputed(r: TilesRecord): TilesRecord {
    if (r.t === "rot") return { t: "rot", dir: r.dir === 1 ? -1 : 1 };
    if (r.t === "offset") return { t: "offset", dx: -r.dx, dy: -r.dy };
    return r;   // flip 自逆；tiles 不走这
  }

  private _applyAll(f: (lp: LayerPixels) => LayerPixels): void {
    const jobs: [number, LayerPixels][] = [];
    this._host.eachLayer((id, lp) => jobs.push([id, f(lp)]));
    for (const [id, np] of jobs) this._host.replacePixels(id, np);
  }
  private _applyRot(dir: 1 | -1): void {
    // dir=1 CCW 一次；dir=-1 CW = CCW×3（rotated90CCW 是唯一原语；rot 低频，绕三圈可承受）
    this._applyAll((lp) => {
      let cur = lp.rotated90CCW();
      if (dir === -1) {
        for (let i = 0; i < 2; i++) { const nx = cur.rotated90CCW(); cur.dispose(); cur = nx; }
      }
      return cur;
    });
  }

  private _collectedCount(): number {
    let n = 0;
    for (const [, tiles] of this._collected) n += tiles.size;
    return n;
  }
  private _disposeCollected(): void {
    for (const [, tiles] of this._collected) for (const [, h] of tiles) if (h && !h.released) h.release();
    this._collected = new Map();
  }
}
