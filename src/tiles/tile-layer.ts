// tile-layer（原 gl/tile-pixels，S9 归位 tiles/——纯 tile 门面非 GL 专属）。LayerPixels —— 图层像素门面：**稀疏 256² tile**，doc 坐标接口，**bbox-free**。
// v0.4 起底层换到 cpu-tile-pool：每格是**不可变、引用计数**的 TileHandle（copy-on-write），
// 不再是可变裸数组。这带来：
//   - snapshot()/restore() = 句柄 acquire/release，**零拷贝**（undo 内存压力交给池的压缩管）。
//   - 压缩驻留对读者透明（handle.bytes() 同步解压），tile-residency 的备份/驱逐机器失去存在理由（S3 删）。
//   - **js 没析构**：LayerPixels 被替换/丢弃前必须显式 dispose()（释放句柄），漏了由池的
//     FinalizationRegistry 泄漏 assert 兜底上报。持有点：Layer.setPixels/remapPixels、doc.adoptState、
//     doc.removeLayer、gl-doc-renderer 的 tmp、undo 快照 disposePixelsSnapshot。
//
// 接口不变（putRegion/getRegion/sampleAt/contentBounds/editRegion facade…），写者读者照旧。
// ⚠ getTile/forEachTile 返回的数组是句柄的零拷贝视图，**只读红线**——要改走 putRegion/putTile。
//
// 纯核心零 DOM 依赖 → node 全测。Canvas2D facade（materialize/editRegion）需浏览器。

import { TILE_SIZE, tilesAcross, tileKey, tileCoord, forEachTileInRect } from "./tile-geometry.ts";
import { appTilePool } from "./app-tile-pool.ts";
import { computeBBox, type TileHandle } from "./cpu-tile-pool.ts";

const TILE_RGBA = TILE_SIZE * TILE_SIZE * 4;

// undo 快照：共享句柄（acquire 过的）。用完必须 disposePixelsSnapshot 释放。
export interface PixelsSnapshot { across: number; tiles: [number, TileHandle][] }
export function disposePixelsSnapshot(snap: PixelsSnapshot): void {
  for (const [, h] of snap.tiles) if (!h.released) h.release();
  snap.tiles.length = 0;
}

export class LayerPixels {
  readonly docW: number;
  readonly docH: number;
  private _across: number;
  private _tiles = new Map<number, TileHandle>();           // tileKey → 只读 tile 句柄
  private _dirty = new Set<number>();                       // 自上次 markAllClean 后变更的 tileKey
  private _contentVersion = 0;                              // 单调递增，每次内容 mutation +1

  constructor(docW: number, docH: number) {
    this.docW = docW;
    this.docH = docH;
    this._across = tilesAcross(docW);
  }

  // 释放全部句柄。**被替换/丢弃前必须调**（js 无析构；漏调 = 池泄漏，FR assert 会点名）。
  // dispose 后这个实例语义 = 空层；再写会重新长 tile（无害，但通常是 bug 的味道）。
  dispose(): void { this.clear(); }

  // （v0.4.3：TileResidency 的备份/驱逐/重物化机器已日落——tile 不可变 + 池内 deflate 压缩驻留
  //   使「冷层 raw 驱逐」失去存在理由：冷 tile 由 bg-jobs 压缩，读时透明解压，CPU 恒为 SSoT。）

  get tileCount(): number { return this._tiles.size; }
  get contentVersion(): number { return this._contentVersion; }
  // 名义 CPU tile 字节（稀疏：只数已分配格）。压缩驻留的格也按 raw 计（预算取保守上界）。
  get byteUsage(): number { return this._tiles.size * TILE_RGBA; }
  isEmpty(): boolean { return this._tiles.size === 0; }

  // ---- 低层 tile 访问 ----
  // 取 tile 像素视图（不存在返 null）。**零拷贝只读**——写走 putTile/putRegion。
  getTile(tx: number, ty: number): Uint8ClampedArray | null {
    const h = this._tiles.get(tileKey(tx, ty, this._across));
    return h ? h.clampedView() : null;
  }
  // 取 tile 句柄（S4+ 的 operator/undo 用；不 acquire，需持有请自己 acquire）。
  getTileHandle(tx: number, ty: number): TileHandle | null {
    return this._tiles.get(tileKey(tx, ty, this._across)) ?? null;
  }
  // 只读句柄遍历（undo 配额估计用；不 acquire，别持有）。
  handles(): IterableIterator<TileHandle> { return this._tiles.values(); }
  // 整 tile 写入（拷贝进来；全透明则回收该格）。
  putTile(tx: number, ty: number, pixels: Uint8ClampedArray): void {
    this._contentVersion++;
    const buf = new Uint8ClampedArray(TILE_RGBA);
    buf.set(pixels.subarray(0, TILE_RGBA));
    this._setTileBuf(tileKey(tx, ty, this._across), buf, true);
  }
  forEachTile(cb: (tx: number, ty: number, pixels: Uint8ClampedArray) => void): void {
    this._tiles.forEach((h, key) => { const { tx, ty } = tileCoord(key, this._across); cb(tx, ty, h.clampedView()); });
  }
  // 带句柄遍历（GPU 上传走 cpu-gpu-tile-bridge 按 handle.id 去重；不 acquire，别持有）。
  forEachTileHandle(cb: (tx: number, ty: number, h: TileHandle) => void): void {
    this._tiles.forEach((h, key) => { const { tx, ty } = tileCoord(key, this._across); cb(tx, ty, h); });
  }

  // ---- 写：把 doc 矩形 [sx0,sy0,sw,sh] 的像素**整块替换**为 src（flat RGBA，行优先，sw 宽）----
  // src 的透明像素也会写入（= 该处变透明）。覆盖后全透明的格回收。copy-on-write：每格封新 tile。
  putRegion(sx0: number, sy0: number, sw: number, sh: number, src: Uint8ClampedArray): void {
    if (sw <= 0 || sh <= 0) return;
    this._contentVersion++;
    forEachTileInRect(sx0, sy0, sw, sh, this.docW, this.docH, (tx, ty) => {
      const key = tileKey(tx, ty, this._across);
      const old = this._tiles.get(key);
      const tile = new Uint8ClampedArray(TILE_RGBA);
      if (old) tile.set(old.clampedView());
      const tox = tx * TILE_SIZE, toy = ty * TILE_SIZE;
      // 该 tile 与 src 矩形的交集（doc 坐标）
      const ix0 = Math.max(tox, sx0), iy0 = Math.max(toy, sy0);
      const ix1 = Math.min(tox + TILE_SIZE, sx0 + sw), iy1 = Math.min(toy + TILE_SIZE, sy0 + sh);
      for (let y = iy0; y < iy1; y++) {
        let di = ((y - toy) * TILE_SIZE + (ix0 - tox)) * 4;
        let si = ((y - sy0) * sw + (ix0 - sx0)) * 4;
        for (let x = ix0; x < ix1; x++) {
          tile[di] = src[si]; tile[di + 1] = src[si + 1]; tile[di + 2] = src[si + 2]; tile[di + 3] = src[si + 3];
          di += 4; si += 4;
        }
      }
      this._setTileBuf(key, tile, true);
    });
  }

  // ---- 写（S8 brush GPU commit 落盘口）：语义同 putRegion（整块替换，区域内透明也写入），
  //   区别是逐 tile 与现有字节比对，**只封真变了的 tile**——undo 快照交换不背未变 tile，
  //   GPU 收养（registerPair）也只对变更 tile 做。返回变更 tile 坐标（含被擦空回收的）。
  applyRegionDiff(sx0: number, sy0: number, sw: number, sh: number, src: Uint8ClampedArray): { tx: number; ty: number }[] {
    const changed: { tx: number; ty: number }[] = [];
    if (sw <= 0 || sh <= 0) return changed;
    forEachTileInRect(sx0, sy0, sw, sh, this.docW, this.docH, (tx, ty) => {
      const key = tileKey(tx, ty, this._across);
      const old = this._tiles.get(key);
      const tile = new Uint8ClampedArray(TILE_RGBA);
      if (old) tile.set(old.clampedView());
      const tox = tx * TILE_SIZE, toy = ty * TILE_SIZE;
      const ix0 = Math.max(tox, sx0), iy0 = Math.max(toy, sy0);
      const ix1 = Math.min(tox + TILE_SIZE, sx0 + sw), iy1 = Math.min(toy + TILE_SIZE, sy0 + sh);
      for (let y = iy0; y < iy1; y++) {
        const di = ((y - toy) * TILE_SIZE + (ix0 - tox)) * 4;
        const si = ((y - sy0) * sw + (ix0 - sx0)) * 4;
        tile.set(src.subarray(si, si + (ix1 - ix0) * 4), di);
      }
      // 比对（u32 视图 memcmp）：无旧 tile 时与全透明比。相同 → 跳过（零封装零 dirty）。
      const cand32 = new Uint32Array(tile.buffer);
      let differs = false;
      if (old) {
        const oldV = old.clampedView();
        const old32 = new Uint32Array(oldV.buffer, oldV.byteOffset, oldV.byteLength >> 2);
        for (let i = 0; i < cand32.length; i++) if (cand32[i] !== old32[i]) { differs = true; break; }
      } else {
        for (let i = 0; i < cand32.length; i++) if (cand32[i] !== 0) { differs = true; break; }
      }
      if (!differs) return;
      this._contentVersion++;
      this._setTileBuf(key, tile, true);
      changed.push({ tx, ty });
    });
    return changed;
  }

  // ---- 读：doc 矩形 → flat RGBA（缺 tile = 透明 0）----
  getRegion(x0: number, y0: number, w: number, h: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(w * h * 4);
    forEachTileInRect(x0, y0, w, h, this.docW, this.docH, (tx, ty) => {
      const handle = this._tiles.get(tileKey(tx, ty, this._across));
      if (!handle) return;   // 透明
      const tile = handle.clampedView();
      const tox = tx * TILE_SIZE, toy = ty * TILE_SIZE;
      const ix0 = Math.max(tox, x0), iy0 = Math.max(toy, y0);
      const ix1 = Math.min(tox + TILE_SIZE, x0 + w), iy1 = Math.min(toy + TILE_SIZE, y0 + h);
      for (let y = iy0; y < iy1; y++) {
        let si = ((y - toy) * TILE_SIZE + (ix0 - tox)) * 4;
        let di = ((y - y0) * w + (ix0 - x0)) * 4;
        for (let x = ix0; x < ix1; x++) {
          out[di] = tile[si]; out[di + 1] = tile[si + 1]; out[di + 2] = tile[si + 2]; out[di + 3] = tile[si + 3];
          di += 4; si += 4;
        }
      }
    });
    return out;
  }

  sampleAt(x: number, y: number): [number, number, number, number] {
    if (x < 0 || y < 0 || x >= this.docW || y >= this.docH) return [0, 0, 0, 0];
    const tx = Math.floor(x / TILE_SIZE), ty = Math.floor(y / TILE_SIZE);
    const h = this._tiles.get(tileKey(tx, ty, this._across));
    if (!h) return [0, 0, 0, 0];
    const tile = h.clampedView();
    const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
    return [tile[i], tile[i + 1], tile[i + 2], tile[i + 3]];
  }

  // ---- 派生内容框（bbox 替代）----
  // tile 粒度并集；tight=true 用池里各 tile 的 per-tile bbox 聚合（池建 tile 时已扫过，不再全量扫像素）。
  contentBounds(tight = false): { x: number; y: number; w: number; h: number } | null {
    if (this._tiles.size === 0) return null;
    if (tight) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      this._tiles.forEach((h, key) => {
        const b = h.bbox();
        if (!b) return;   // 全透明格（理论上不存——_setTileBuf 会回收；防御）
        const { tx, ty } = tileCoord(key, this._across);
        const x0 = tx * TILE_SIZE + b.x, y0 = ty * TILE_SIZE + b.y;
        if (x0 < minX) minX = x0; if (y0 < minY) minY = y0;
        if (x0 + b.w > maxX) maxX = x0 + b.w; if (y0 + b.h > maxY) maxY = y0 + b.h;
      });
      if (minX === Infinity) return null;
      return { x: minX, y: minY, w: Math.min(maxX, this.docW) - minX, h: Math.min(maxY, this.docH) - minY };
    }
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
    this._tiles.forEach((_h, key) => {
      const { tx, ty } = tileCoord(key, this._across);
      if (tx < tx0) tx0 = tx; if (tx > tx1) tx1 = tx; if (ty < ty0) ty0 = ty; if (ty > ty1) ty1 = ty;
    });
    const x0 = tx0 * TILE_SIZE, y0 = ty0 * TILE_SIZE;
    const x1 = Math.min(this.docW, (tx1 + 1) * TILE_SIZE), y1 = Math.min(this.docH, (ty1 + 1) * TILE_SIZE);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  clear(): void {
    this._contentVersion++;
    this._tiles.forEach((_h, k) => this._dirty.add(k));
    this._releaseAll();
  }

  // ---- 纯变换（返回新 LayerPixels；doc 变换用。老实例由 Layer.setPixels dispose）----
  flippedHorizontal(): LayerPixels {
    const np = new LayerPixels(this.docW, this.docH);
    const b = this.contentBounds();
    if (!b) return np;
    const src = this.getRegion(b.x, b.y, b.w, b.h);
    const dst = new Uint8ClampedArray(b.w * b.h * 4);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const si = (y * b.w + x) * 4, di = (y * b.w + (b.w - 1 - x)) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
    np.putRegion(this.docW - (b.x + b.w), b.y, b.w, b.h, dst);
    return np;
  }
  // 逆时针旋转 90°：old doc (x,y) → new doc (y, W-1-x)，W=旧宽。新 doc 尺寸 = (旧高 × 旧宽)。
  rotated90CCW(): LayerPixels {
    const W = this.docW;
    const np = new LayerPixels(this.docH, W);   // 新 doc = H × W
    const b = this.contentBounds();
    if (!b) return np;
    const src = this.getRegion(b.x, b.y, b.w, b.h);
    const nw = b.h, nh = b.w;
    const dst = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const si = (y * b.w + x) * 4, di = ((b.w - 1 - x) * nw + y) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
    np.putRegion(b.y, W - (b.x + b.w), nw, nh, dst);
    return np;
  }
  // 环绕偏移：new (x+ox)%W, (y+oy)%H。doc 尺寸不变（seamless 贴图）。
  offsetWrapped(ox: number, oy: number): LayerPixels {
    const W = this.docW, H = this.docH;
    const np = new LayerPixels(W, H);
    if (this.isEmpty()) return np;
    const src = this.getRegion(0, 0, W, H);   // 整幅（2K=16MB，offsetWrap 低频）
    const dst = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const nx = (x + ox) % W, ny = (y + oy) % H;
      const si = (y * W + x) * 4, di = (ny * W + nx) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
    np.putRegion(0, 0, W, H, dst);
    return np;
  }
  // 裁切到新 doc 尺寸：old (x,y) → new (x-dx, y-dy)，clip 到 [0,newW)×[0,newH)。
  cropped(dx: number, dy: number, newW: number, newH: number): LayerPixels {
    const np = new LayerPixels(newW, newH);
    const b = this.contentBounds();
    if (!b) return np;
    const tL = b.x - dx, tT = b.y - dy;
    const nL = Math.max(0, tL), nT = Math.max(0, tT);
    const nR = Math.min(newW, tL + b.w), nB = Math.min(newH, tT + b.h);
    const nw = nR - nL, nh = nB - nT;
    if (nw <= 0 || nh <= 0) return np;
    const src = this.getRegion(nL + dx, nT + dy, nw, nh);   // 对应旧 doc 坐标
    np.putRegion(nL, nT, nw, nh, src);
    return np;
  }

  // ---- dirty 跟踪（GL 增量上传）----
  dirtyTileKeys(): number[] { return [...this._dirty]; }
  markAllClean(): void { this._dirty.clear(); }

  // ---- undo 快照：**句柄共享，零拷贝**（tile 只读 → 快照与活层安全共享同一批 tile）----
  snapshot(): PixelsSnapshot {
    const tiles: [number, TileHandle][] = [];
    this._tiles.forEach((h, key) => tiles.push([key, h.acquire()]));
    return { across: this._across, tiles };
  }
  // 还原快照（快照可反复用：restore 装的是 acquire 副本，快照自身句柄不消耗，
  // 最终仍需 disposePixelsSnapshot）。
  restore(snap: PixelsSnapshot): void {
    this._contentVersion++;
    this._tiles.forEach((_h, k) => this._dirty.add(k));
    this._releaseAll();
    for (const [key, h] of snap.tiles) {
      this._tiles.set(key, h.acquire());
      this._dirty.add(key);
    }
  }

  // ---- 内部 ----
  // 收养 buf（调用方新建、之后不得再碰）为该格的新 tile；全透明 → 回收该格。释放旧句柄。
  private _setTileBuf(key: number, buf: Uint8ClampedArray, markDirty: boolean): void {
    const bbox = computeBBox("rgba8", asBytes(buf), TILE_SIZE);
    const old = this._tiles.get(key);
    if (bbox === null) {
      if (old) { old.release(); this._tiles.delete(key); }
    } else {
      this._tiles.set(key, appTilePool().createTile("rgba8", asBytes(buf), bbox));
      if (old) old.release();
    }
    if (markDirty) this._dirty.add(key);
  }

  private _releaseAll(): void {
    this._tiles.forEach((h) => { if (!h.released) h.release(); });
    this._tiles.clear();
  }
}

function asBytes(buf: Uint8ClampedArray): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ---- Canvas2D facade（browser-only；给旧 layer.canvas/ctx 写者读者过渡）----
type Bitmap2D = HTMLCanvasElement | OffscreenCanvas;
function scratch2D(w: number, h: number): Bitmap2D {
  if (typeof OffscreenCanvas !== "undefined") { try { return new OffscreenCanvas(w, h); } catch { /* fall */ } }
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}

// 物化整个内容为一张 bbox 画布（+ doc 原点）。给 2D 读者（旧 layer.canvas）。空 → null。
//   tight=true 用 per-tile bbox 聚合收紧（导出/crop）；默认 tile 粒度（够 2D 合成用）。
export function materialize(lp: LayerPixels, tight = false): { canvas: Bitmap2D; ox: number; oy: number } | null {
  const b = lp.contentBounds(tight);
  if (!b) return null;
  const c = scratch2D(b.w, b.h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(lp.getRegion(b.x, b.y, b.w, b.h), b.w, b.h), 0, 0);
  return { canvas: c, ox: b.x, oy: b.y };
}

// 编辑事务（替代旧 ensureBbox + layer.ctx）：物化 doc 矩形 [rx0,ry0,rw,rh]（含已有像素）→ 给 ctx 让 fn 画
//   → 结果切片回 tile。fn(ctx, ox, oy)：ctx 原点 = doc(ox,oy)，即在 doc 坐标 d 处画 = ctx 坐标 d-ox/d-oy。
export function editRegion(lp: LayerPixels, rx0: number, ry0: number, rw: number, rh: number, fn: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void): void {
  if (rw <= 0 || rh <= 0) return;
  const c = scratch2D(rw, rh);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.putImageData(new ImageData(lp.getRegion(rx0, ry0, rw, rh), rw, rh), 0, 0);   // 预填已有
  fn(ctx, rx0, ry0);
  lp.putRegion(rx0, ry0, rw, rh, ctx.getImageData(0, 0, rw, rh).data);             // 切片回 tile
}

// 整体从一张 canvas 重建（变换/合并/导入/ora）：清空 + 切片。srcCanvas 内容在 doc (ox,oy) 起、w×h。
export function replaceFromCanvas(lp: LayerPixels, srcCanvas: CanvasImageSource, ox: number, oy: number, w: number, h: number): void {
  lp.clear();
  if (w <= 0 || h <= 0) return;
  const c = scratch2D(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(srcCanvas, 0, 0);
  lp.putRegion(ox, oy, w, h, ctx.getImageData(0, 0, w, h).data);
}
