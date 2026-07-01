// TileStore —— 稀疏分块图层存储的簿记层（内存杠杆深模块；docs/20260614-perf-webgl-memory-clip.md §3 模块 2）。
//
// 职责：把「图层像素」拆成 256² tile，只为**有画的** tile 占一个 GPU 池 slice（空 tile=0 内存）。
//   这是突破 11 层上限的核心——实占 = 已分配 tile 数 × 256²×4，而非 层数 × 满幅。
//
// 分层（都是纯簿记，GPU 像素操作全在 TileBackend seam 后面，故 node 全可测）：
//   - TilePool：全局 slice 自由表 + 容量 + 内存核算。所有图层共享一个池。
//   - LayerTileMap：单层的 (tx,ty)→Tile 稀疏 map，向池借/还 slice。每个 doc Layer 持一个。
//   - TileBackend：唯一接触 GPU 的 seam（清空/上传/读回某 slice 的像素）。两 adapter：
//       真 WebGL2（TEXTURE_2D_ARRAY，后续接）；测试用内存 fake（round-trip 验稀疏/回收）。
//
// 不在本模块：判断「tile 变全透明该回收」需扫像素/占用查询，是 commit/TileResidency 的策略，
//   本模块只提供 freeTile 原语（见 §4.3 per-tile delta、§4.2 冷层逐出）。

import { TILE_SIZE, tileKey } from "./tile-geometry.ts";

// 单 tile：网格坐标 + 它占的池 slice 索引。像素本体在 backend 的 slice 里，不在此。
export interface Tile {
  readonly tx: number;
  readonly ty: number;
  slice: number;
}

// GPU 池的唯一接触面。slice = TILE_SIZE² 的一格 RGBA8。pixels 一律长 TILE_SIZE·TILE_SIZE·4。
export interface TileBackend {
  readonly capacity: number;               // 池最多容纳多少 slice（array texture 深度）
  clearSlice(slice: number): void;         // 置全透明
  uploadSlice(slice: number, pixels: Uint8Array): void;
  readSlice(slice: number): Uint8Array;    // 读回（存盘/undo readback）
}

export const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;

// 全局 slice 池：自由表 + 核算。所有 LayerTileMap 共享一个实例。
export class TilePool {
  readonly backend: TileBackend;
  private _free: number[] = [];      // 回收待复用的 slice 索引（LIFO）
  private _next = 0;                 // 尚未用过的下一个新 slice
  private _used = 0;                 // 当前在用 slice 数（= 已分配 tile 数）

  constructor(backend: TileBackend) {
    this.backend = backend;
  }

  get capacity(): number { return this.backend.capacity; }
  get allocatedCount(): number { return this._used; }
  get byteUsage(): number { return this._used * TILE_BYTES; }
  // 池是否已满（再 acquire 会失败）。满 = 软上限压力点（caller/TileResidency 决定逐出或拒绝）。
  get isFull(): boolean { return this._used >= this.backend.capacity; }

  // 借一个 slice（优先复用回收的）。满 → 返回 -1（caller 处理：逐冷层后重试 / 软上限警告）。
  acquireSlice(): number {
    if (this._used >= this.backend.capacity) return -1;
    const slice = this._free.length > 0 ? this._free.pop()! : this._next++;
    this._used++;
    this.backend.clearSlice(slice);   // 新借的 slice 必为透明初值
    return slice;
  }

  // 还一个 slice 进自由表（不立即清，复用时 acquire 会 clear）。
  releaseSlice(slice: number): void {
    if (slice < 0) return;
    this._free.push(slice);
    this._used--;
  }

  // 全池复位（context-loss 后端重建后调）：底层 array texture 已换新、所有 slice 内容没了 → 自由表清零、
  //   从头重新分配。caller 须同时丢弃所有 LayerTileMap（其 Tile.slice 引用已失效），再 syncAll 全新重传。
  reset(): void {
    this._free = [];
    this._next = 0;
    this._used = 0;
  }
}

// 单层稀疏 tile map。across = 该 doc 的列数（tilesAcross(docW)），用于 tileKey。
export class LayerTileMap {
  private _pool: TilePool;
  private _across: number;
  private _tiles = new Map<number, Tile>();   // tileKey → Tile

  constructor(pool: TilePool, across: number) {
    this._pool = pool;
    this._across = across;
  }

  get tileCount(): number { return this._tiles.size; }

  // 取 (tx,ty) 的 tile。create:true 时若不存在则借 slice 新建（池满返回 null）。
  tileAt(tx: number, ty: number, opts: { create?: boolean } = {}): Tile | null {
    const key = tileKey(tx, ty, this._across);
    const existing = this._tiles.get(key);
    if (existing) return existing;
    if (!opts.create) return null;
    const slice = this._pool.acquireSlice();
    if (slice < 0) return null;   // 池满：软上限压力，caller 处理
    const tile: Tile = { tx, ty, slice };
    this._tiles.set(key, tile);
    return tile;
  }

  // 遍历本层所有已分配 tile（顺序无保证；合成时由 caller 按需排）。
  forEachTile(cb: (tile: Tile) => void): void {
    this._tiles.forEach(cb);
  }

  // 释放 (tx,ty)：还 slice 进池、从 map 删。返回是否真的删了一个。
  freeTile(tx: number, ty: number): boolean {
    const key = tileKey(tx, ty, this._across);
    const tile = this._tiles.get(key);
    if (!tile) return false;
    this._pool.releaseSlice(tile.slice);
    this._tiles.delete(key);
    return true;
  }

  // 释放全层 tile（删层/清层）。
  clear(): void {
    this._tiles.forEach((t) => this._pool.releaseSlice(t.slice));
    this._tiles.clear();
  }
}
