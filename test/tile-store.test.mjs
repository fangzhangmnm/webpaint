// TileStore + tile 几何 纯逻辑测试（Stage 1）。GPU 像素操作走 fake backend → round-trip 验稀疏/回收。
// 真 WebGL2 像素正确性留真机；这里只压簿记契约（slice 自由表、容量、内存核算、稀疏、回收、map 往返）。
import { describe, it, assert } from "./runner.mjs";
import {
  TILE_SIZE, tilesAcross, tilesDown, tileCount,
  tileKey, tileCoord, tileDocOrigin, tileRangeForRect, forEachTileInRect,
} from "../src/gl/tile-geometry.ts";
import { TilePool, LayerTileMap, TILE_BYTES } from "../src/gl/tile-store.ts";

// ---- fake backend：内存存每 slice 的像素，验上传/读回 round-trip ----
function fakeBackend(capacity = 1000) {
  const slices = new Map();          // slice → Uint8Array
  const cleared = [];                // 记 clearSlice 调用序（验新借必清）
  return {
    capacity,
    clearSlice(s) { slices.set(s, new Uint8Array(TILE_BYTES)); cleared.push(s); },
    uploadSlice(s, px) { slices.set(s, px.slice()); },
    readSlice(s) { return slices.get(s) ?? new Uint8Array(TILE_BYTES); },
    _slices: slices,
    _cleared: cleared,
  };
}

describe("TilePool · reset（context-loss 后端重建后复位）", () => {
  it("reset 后自由表清零、从头分配、_used 归零", () => {
    const pool = new TilePool(fakeBackend(100));
    const s0 = pool.acquireSlice(), s1 = pool.acquireSlice();
    pool.releaseSlice(s0);
    assert(pool.allocatedCount === 1, "分配 2 释放 1 → used=1");
    pool.reset();
    assert(pool.allocatedCount === 0, "reset 后 used=0");
    assert(pool.acquireSlice() === 0, "reset 后从 slice 0 重新分配");
    assert(pool.acquireSlice() === 1, "下一个 slice 1（自由表已清，非复用旧 s0）");
    void s1;
  });
});

describe("tile-geometry · 网格换算", () => {
  it("tilesAcross/Down 向上取整，最小 1", () => {
    assert(tilesAcross(2048) === 8, "2048/256=8");
    assert(tilesAcross(2732) === 11, "2732/256=10.67→11");
    assert(tilesAcross(1) === 1 && tilesDown(0) === 1, "下限 1");
    assert(tileCount(2048, 2048) === 64, "满幅 2K = 64 tile");
  });

  it("tileKey ↔ tileCoord 互逆", () => {
    const across = 8;
    for (const [tx, ty] of [[0, 0], [7, 0], [0, 7], [3, 5], [7, 7]]) {
      const k = tileKey(tx, ty, across);
      const c = tileCoord(k, across);
      assert(c.tx === tx && c.ty === ty, `(${tx},${ty}) 往返`);
    }
    assert(tileKey(3, 5, 8) === 43, "5*8+3=43");
  });

  it("tileDocOrigin = (tx·256, ty·256)", () => {
    const o = tileDocOrigin(3, 5);
    assert(o.x === 768 && o.y === 1280, "原点");
  });
});

describe("tile-geometry · tileRangeForRect", () => {
  const W = 2048, H = 2048;   // 8×8

  it("空矩形 / doc 外 → null", () => {
    assert(tileRangeForRect(0, 0, 0, 10, W, H) === null, "w=0");
    assert(tileRangeForRect(0, 0, 10, -5, W, H) === null, "h<0");
    assert(tileRangeForRect(-100, -100, 50, 50, W, H) === null, "整体在左上外");
    assert(tileRangeForRect(2048, 0, 100, 100, W, H) === null, "整体在右外");
  });

  it("单像素点落在它所在的单一 tile", () => {
    const r = tileRangeForRect(300, 300, 1, 1, W, H);   // tile (1,1)
    assert(r.tx0 === 1 && r.tx1 === 1 && r.ty0 === 1 && r.ty1 === 1, "单 tile (1,1)");
  });

  it("跨 tile 边界的矩形覆盖多 tile", () => {
    // x[250,260) 跨 255/256 边界 → tx 0..1
    const r = tileRangeForRect(250, 10, 10, 5, W, H);
    assert(r.tx0 === 0 && r.tx1 === 1, "跨列边界 → 两列");
    assert(r.ty0 === 0 && r.ty1 === 0, "同行");
  });

  it("超出 doc 的部分被 clamp 进网格", () => {
    // 矩形右下越界，闭区间右端 clamp 到 7
    const r = tileRangeForRect(2000, 2000, 500, 500, W, H);
    assert(r.tx1 === 7 && r.ty1 === 7, "clamp 到末 tile");
    assert(r.tx0 === 7 && r.ty0 === 7, "起点也在末 tile");
  });

  it("末覆盖像素用 ix1-1（排他右边）不多算一格", () => {
    // x[0,256) 恰好只覆盖 tile 0（256 是排他右边，不应碰 tile 1）
    const r = tileRangeForRect(0, 0, 256, 256, W, H);
    assert(r.tx1 === 0 && r.ty1 === 0, "[0,256) 只 tile 0");
  });

  it("forEachTileInRect 遍历全部覆盖 tile", () => {
    const seen = [];
    forEachTileInRect(0, 0, 512, 256, W, H, (tx, ty) => seen.push(`${tx},${ty}`));
    assert(seen.length === 2 && seen.includes("0,0") && seen.includes("1,0"), "两 tile");
  });
});

describe("tile-store · TilePool 自由表/容量/核算", () => {
  it("acquire 递增、release 复用（LIFO）", () => {
    const pool = new TilePool(fakeBackend());
    const a = pool.acquireSlice();
    const b = pool.acquireSlice();
    assert(a === 0 && b === 1, "新借递增 0,1");
    assert(pool.allocatedCount === 2, "在用 2");
    pool.releaseSlice(a);
    assert(pool.allocatedCount === 1, "还后 1");
    const c = pool.acquireSlice();
    assert(c === 0, "复用刚还的 slice 0");
  });

  it("新借的 slice 必被 clear（透明初值）", () => {
    const be = fakeBackend();
    const pool = new TilePool(be);
    const s = pool.acquireSlice();
    assert(be._cleared.includes(s), "acquire 触发 clearSlice");
  });

  it("内存核算 = 在用数 × TILE_BYTES", () => {
    const pool = new TilePool(fakeBackend());
    pool.acquireSlice(); pool.acquireSlice(); pool.acquireSlice();
    assert(pool.byteUsage === 3 * TILE_BYTES, "3 tile 字节");
    assert(TILE_BYTES === 256 * 256 * 4, "tile = 256KB");
  });

  it("满池 acquire → -1（软上限压力点）", () => {
    const pool = new TilePool(fakeBackend(2));
    assert(pool.acquireSlice() === 0 && pool.acquireSlice() === 1, "借满");
    assert(pool.isFull, "已满");
    assert(pool.acquireSlice() === -1, "再借 -1");
  });
});

describe("tile-store · LayerTileMap 稀疏/回收/往返", () => {
  const ACROSS = 8;

  it("无 create 取不存在 tile → null，不占 slice", () => {
    const pool = new TilePool(fakeBackend());
    const lm = new LayerTileMap(pool, ACROSS);
    assert(lm.tileAt(2, 3) === null, "无 create → null");
    assert(pool.allocatedCount === 0, "未占 slice（稀疏：空 tile=0 内存）");
  });

  it("create 借 slice 建 tile；同坐标幂等返回同一个", () => {
    const pool = new TilePool(fakeBackend());
    const lm = new LayerTileMap(pool, ACROSS);
    const t1 = lm.tileAt(2, 3, { create: true });
    assert(t1 && t1.tx === 2 && t1.ty === 3, "建好坐标对");
    assert(pool.allocatedCount === 1 && lm.tileCount === 1, "占 1 slice");
    const t2 = lm.tileAt(2, 3, { create: true });
    assert(t2 === t1, "同坐标返回同一 tile，不重复借");
    assert(pool.allocatedCount === 1, "仍 1 slice");
  });

  it("稀疏：只 create 的 tile 占内存", () => {
    const pool = new TilePool(fakeBackend());
    const lm = new LayerTileMap(pool, ACROSS);
    lm.tileAt(0, 0, { create: true });
    lm.tileAt(7, 7, { create: true });
    assert(lm.tileCount === 2 && pool.allocatedCount === 2, "64 格里只 2 占用");
  });

  it("freeTile 还 slice 给池可复用", () => {
    const pool = new TilePool(fakeBackend());
    const lm = new LayerTileMap(pool, ACROSS);
    const t = lm.tileAt(1, 1, { create: true });
    const slice = t.slice;
    assert(lm.freeTile(1, 1) === true, "删成功");
    assert(lm.tileCount === 0 && pool.allocatedCount === 0, "已释放");
    assert(lm.freeTile(1, 1) === false, "重复删 false");
    const t2 = lm.tileAt(5, 5, { create: true });
    assert(t2.slice === slice, "新 tile 复用刚还的 slice");
  });

  it("clear 释放全层 tile", () => {
    const pool = new TilePool(fakeBackend());
    const lm = new LayerTileMap(pool, ACROSS);
    lm.tileAt(0, 0, { create: true });
    lm.tileAt(1, 0, { create: true });
    lm.tileAt(2, 0, { create: true });
    lm.clear();
    assert(lm.tileCount === 0 && pool.allocatedCount === 0, "全清");
  });

  it("像素 upload→read round-trip（经 slice）", () => {
    const be = fakeBackend();
    const pool = new TilePool(be);
    const lm = new LayerTileMap(pool, ACROSS);
    const t = lm.tileAt(3, 4, { create: true });
    const px = new Uint8Array(TILE_BYTES);
    px[0] = 11; px[1] = 22; px[2] = 33; px[3] = 44;
    px[TILE_BYTES - 1] = 255;
    be.uploadSlice(t.slice, px);
    const out = be.readSlice(t.slice);
    assert(out[0] === 11 && out[1] === 22 && out[2] === 33 && out[3] === 44, "首像素往返");
    assert(out[TILE_BYTES - 1] === 255, "尾像素往返");
  });

  it("多层共享一个池，slice 全局唯一不串", () => {
    const pool = new TilePool(fakeBackend());
    const a = new LayerTileMap(pool, ACROSS);
    const b = new LayerTileMap(pool, ACROSS);
    const ta = a.tileAt(0, 0, { create: true });
    const tb = b.tileAt(0, 0, { create: true });
    assert(ta.slice !== tb.slice, "同坐标不同层 → 不同 slice");
    assert(pool.allocatedCount === 2, "两层各占一");
  });
});
