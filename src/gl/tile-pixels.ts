// LayerPixels —— 图层像素的新真源（SoT）：**稀疏 256² CPU tile**，doc 坐标接口，**bbox-free**。
// 取代 doc.ts 旧的「单张 Canvas2D bbox 画布 + bboxX/Y/W/H + ensureBbox」。
//
// 设计（greenfield，深模块窄接口）：
//   - 像素按 256² tile 稀疏存（空 tile 不分配 = 内存杠杆）。每 tile = RGBA Uint8ClampedArray。
//   - **bbox 不是身份**：内容框由 contentBounds() 从已分配 tile **派生**（要紧可扫 alpha）。
//   - 写：putRegion(doc 矩形, 源 RGBA) —— 把该矩形像素**整块替换**进相关 tile；变全透明的 tile 回收。
//   - 读：getRegion(doc 矩形) → 拼 tile 出 flat RGBA（缺 tile=透明）。
//   - Canvas2D facade（materialize/editRegion，browser-only，本文件末）给旧的 layer.canvas/ctx 写者读者过渡。
//   - dirty tile 跟踪给 GL 增量上传 / flush 用。snapshot/restore 给 undo（先全 tile，后续 per-tile delta）。
//
// 纯核心（putRegion/getRegion/sampleAt/contentBounds/snapshot…）零 DOM 依赖 → node 全测。
// Canvas2D facade 需浏览器 → Chromium golden 验。

import { TILE_SIZE, tilesAcross, tilesDown, tileKey, tileCoord, forEachTileInRect } from "./tile-geometry.ts";

const TILE_RGBA = TILE_SIZE * TILE_SIZE * 4;

export class LayerPixels {
  readonly docW: number;
  readonly docH: number;
  private _across: number;
  private _tiles = new Map<number, Uint8ClampedArray>();   // tileKey → RGBA 256²
  private _dirty = new Set<number>();                       // 自上次 markAllClean 后变更的 tileKey
  private _contentVersion = 0;                              // 单调递增，每次内容 mutation +1（TileResidency 驱逐门用）
  private _evicted = false;                                 // raw 被 TileResidency 驱逐（只剩 GPU tiles + 压缩备份）
  private _provider: ((lp: LayerPixels) => void) | null = null;   // 重物化回调（sync GPU readback，TileResidency 装）

  constructor(docW: number, docH: number) {
    this.docW = docW;
    this.docH = docH;
    this._across = tilesAcross(docW);
  }

  // ---- 冷层驻留（TileResidency 接线）----
  // 中心护栏：被驱逐层被任何 read 命中时，先 sync 重物化 raw（provider = GPU readback 回填）。所有 read 方法
  //   首行调 _ensureResident() → 覆盖全部 LayerPixels 读者（导出/合成/变换/undo/吸管），零 per-caller 扇出。
  //   重物化不改内容 → 不 bump contentVersion（驱逐门 epoch 不变，重物化对读者透明）。
  setResidencyProvider(fn: (lp: LayerPixels) => void): void { this._provider = fn; }
  isRawResident(): boolean { return !this._evicted; }
  // 驱逐 raw：丢 CPU _tiles（省 ~16MB/满层），只留 GPU tiles + 压缩备份。需已设 provider（否则无退路 → 拒绝）。
  //   caller(TileResidency) 须先 canEvictRaw（备份完整且非 pinned）。不 bump contentVersion（内容没变，只驻留变）。
  evictRaw(): boolean {
    if (this._evicted) return true;
    if (!this._provider) return false;                      // 无重物化路径 → 拒绝（红线：不可无退路地丢 raw）
    this._tiles.clear();
    this._evicted = true;
    return true;
  }
  // provider 回填：装入重物化 tile（不 bump contentVersion、不进 _dirty——GPU 已有这些像素，非 GL 上传源）。
  adoptResidentTiles(entries: Array<{ tx: number; ty: number; px: Uint8ClampedArray }>): void {
    for (const { tx, ty, px } of entries) {
      if (isAllTransparent(px)) continue;
      const t = new Uint8ClampedArray(TILE_RGBA);
      t.set(px.subarray(0, TILE_RGBA));
      this._tiles.set(tileKey(tx, ty, this._across), t);
    }
    this._evicted = false;
  }
  private _ensureResident(): void {
    if (!this._evicted) return;
    this._evicted = false;                                  // 先落标志防重入/失败自旋
    this._provider?.(this);                                 // provider 回填 _tiles（sync GPU readback）
  }

  get tileCount(): number { this._ensureResident(); return this._tiles.size; }
  // 内容版本：单调递增，任何像素 mutation（putRegion/putTile/clear/restore）+1。**不是** _dirty（那是 GL 上传脏）。
  //   TileResidency 记 backupEpoch=contentVersion；驱逐冷层 raw 当且仅当 backupEpoch===contentVersion（备份仍覆盖当前内容）。
  get contentVersion(): number { return this._contentVersion; }
  // 实占 CPU tile 字节（稀疏：只数已分配 tile）。给 computeMaxLayers 动态字节预算 / 内存 HUD。
  get byteUsage(): number { return this._tiles.size * TILE_RGBA; }   // 实占 CPU 字节：驱逐后为 0（正是省的那份），不重物化
  isEmpty(): boolean { if (this._evicted) return false; return this._tiles.size === 0; }   // 只驱逐非空层 → 驱逐即非空

  // ---- 低层 tile 访问 ----
  // 取 tile 像素（不存在返 null）。返回的是内部引用，调用方别越界写。
  getTile(tx: number, ty: number): Uint8ClampedArray | null {
    this._ensureResident();
    return this._tiles.get(tileKey(tx, ty, this._across)) ?? null;
  }
  // 整 tile 写入（拷贝进来；全透明则回收）。给 GL readback / wholesale 重建用。
  putTile(tx: number, ty: number, pixels: Uint8ClampedArray): void {
    this._contentVersion++;
    const key = tileKey(tx, ty, this._across);
    if (isAllTransparent(pixels)) { this._tiles.delete(key); this._dirty.add(key); return; }
    const t = new Uint8ClampedArray(TILE_RGBA);
    t.set(pixels.subarray(0, TILE_RGBA));
    this._tiles.set(key, t);
    this._dirty.add(key);
  }
  forEachTile(cb: (tx: number, ty: number, pixels: Uint8ClampedArray) => void): void {
    this._ensureResident();
    this._tiles.forEach((px, key) => { const { tx, ty } = tileCoord(key, this._across); cb(tx, ty, px); });
  }

  // ---- 写：把 doc 矩形 [sx0,sy0,sw,sh] 的像素**整块替换**为 src（flat RGBA，行优先，sw 宽）----
  // src 的透明像素也会写入（= 该处变透明）。覆盖后全透明的 tile 回收。
  putRegion(sx0: number, sy0: number, sw: number, sh: number, src: Uint8ClampedArray): void {
    if (sw <= 0 || sh <= 0) return;
    this._contentVersion++;
    forEachTileInRect(sx0, sy0, sw, sh, this.docW, this.docH, (tx, ty) => {
      const key = tileKey(tx, ty, this._across);
      let tile = this._tiles.get(key);
      const created = !tile;
      if (!tile) tile = new Uint8ClampedArray(TILE_RGBA);
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
      if (isAllTransparent(tile)) { if (!created) this._tiles.delete(key); /* created 空 tile 不存 */ }
      else this._tiles.set(key, tile);
      this._dirty.add(key);
    });
  }

  // ---- 读：doc 矩形 → flat RGBA（缺 tile = 透明 0）----
  getRegion(x0: number, y0: number, w: number, h: number): Uint8ClampedArray {
    this._ensureResident();
    const out = new Uint8ClampedArray(w * h * 4);
    forEachTileInRect(x0, y0, w, h, this.docW, this.docH, (tx, ty) => {
      const tile = this._tiles.get(tileKey(tx, ty, this._across));
      if (!tile) return;   // 透明
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
    this._ensureResident();
    const tx = Math.floor(x / TILE_SIZE), ty = Math.floor(y / TILE_SIZE);
    const tile = this._tiles.get(tileKey(tx, ty, this._across));
    if (!tile) return [0, 0, 0, 0];
    const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
    return [tile[i], tile[i + 1], tile[i + 2], tile[i + 3]];
  }

  // ---- 派生内容框（bbox 替代）----
  // tile 粒度并集；tight=true 时扫边缘 tile 的 alpha 收紧到像素。空 → null。
  contentBounds(tight = false): { x: number; y: number; w: number; h: number } | null {
    this._ensureResident();
    if (this._tiles.size === 0) return null;
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
    this._tiles.forEach((_px, key) => {
      const { tx, ty } = tileCoord(key, this._across);
      if (tx < tx0) tx0 = tx; if (tx > tx1) tx1 = tx; if (ty < ty0) ty0 = ty; if (ty > ty1) ty1 = ty;
    });
    let x0 = tx0 * TILE_SIZE, y0 = ty0 * TILE_SIZE;
    let x1 = Math.min(this.docW, (tx1 + 1) * TILE_SIZE), y1 = Math.min(this.docH, (ty1 + 1) * TILE_SIZE);
    if (tight) {
      // 扫所有 tile 的非透明像素收紧（O(已分配像素)，只在导出/crop 等低频调）。
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      this._tiles.forEach((px, key) => {
        const { tx, ty } = tileCoord(key, this._across);
        const tox = tx * TILE_SIZE, toy = ty * TILE_SIZE;
        for (let ly = 0; ly < TILE_SIZE; ly++) for (let lx = 0; lx < TILE_SIZE; lx++) {
          if (px[(ly * TILE_SIZE + lx) * 4 + 3] !== 0) {
            const dx = tox + lx, dy = toy + ly;
            if (dx < minX) minX = dx; if (dx > maxX) maxX = dx; if (dy < minY) minY = dy; if (dy > maxY) maxY = dy;
          }
        }
      });
      if (minX === Infinity) return null;   // 全透明
      x0 = minX; y0 = minY; x1 = maxX + 1; y1 = maxY + 1;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  clear(): void { this._contentVersion++; this._tiles.forEach((_p, k) => this._dirty.add(k)); this._tiles.clear(); }

  // ---- 纯变换（raw 数组操作，返回新 LayerPixels；doc 变换用，node 全可测、无 Canvas2D 往返、更快）----
  // 水平镜像（doc 尺寸不变）。
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
      // 新 local：ndx = y，ndy = b.w-1-x（新 bbox 在 (b.y, W-(b.x+b.w))）
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

  // ---- undo 快照（先全 tile 深拷贝；per-tile delta = 后续切片③）----
  snapshot(): { across: number; tiles: [number, Uint8ClampedArray][] } {
    this._ensureResident();
    const tiles: [number, Uint8ClampedArray][] = [];
    this._tiles.forEach((px, key) => tiles.push([key, new Uint8ClampedArray(px)]));
    return { across: this._across, tiles };
  }
  restore(snap: { across: number; tiles: [number, Uint8ClampedArray][] }): void {
    this._contentVersion++;
    this._tiles.forEach((_p, k) => this._dirty.add(k));
    this._tiles.clear();
    for (const [key, px] of snap.tiles) { this._tiles.set(key, new Uint8ClampedArray(px)); this._dirty.add(key); }
  }
}

function isAllTransparent(px: Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return false;
  return true;
}

// ---- Canvas2D facade（browser-only；给旧 layer.canvas/ctx 写者读者过渡）----
type Bitmap2D = HTMLCanvasElement | OffscreenCanvas;
function scratch2D(w: number, h: number): Bitmap2D {
  if (typeof OffscreenCanvas !== "undefined") { try { return new OffscreenCanvas(w, h); } catch { /* fall */ } }
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}

// 物化整个内容为一张 bbox 画布（+ doc 原点）。给 2D 读者（旧 layer.canvas）。空 → null。
//   tight=true 扫 alpha 收紧（导出/crop）；默认 tile 粒度（够 2D 合成用）。
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
