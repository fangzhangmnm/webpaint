// LayerPixels 纯核心测试（图层像素新 SoT，bbox-free 稀疏 tile）。Canvas2D facade 在 smoke 验。
import { describe, it, assert } from "./runner.mjs";
import { LayerPixels } from "../src/gl/tile-pixels.ts";

const W = 1024, H = 1024;   // 4×4 tile

// 造 flat RGBA 区域：fn(x,y) 在 doc 坐标（区域左上 = ox,oy）。
function region(ox, oy, w, h, fn) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, al] = fn(ox + x, oy + y); const i = (y * w + x) * 4;
    a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
  }
  return a;
}
function eqRegion(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

describe("LayerPixels · put/get round-trip", () => {
  it("单 tile 内写读一致", () => {
    const lp = new LayerPixels(W, H);
    const src = region(10, 20, 30, 40, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
    lp.putRegion(10, 20, 30, 40, src);
    assert(eqRegion(lp.getRegion(10, 20, 30, 40), src), "往返一致");
  });

  it("跨多 tile 的大区域写读一致", () => {
    const lp = new LayerPixels(W, H);
    const src = region(200, 200, 400, 400, (x, y) => [x & 255, y & 255, 128, 200]);   // 跨 (0,0)-(2,2) tile
    lp.putRegion(200, 200, 400, 400, src);
    assert(eqRegion(lp.getRegion(200, 200, 400, 400), src), "跨 tile 往返");
    assert(lp.tileCount >= 4, `应分配多 tile，实 ${lp.tileCount}`);
  });

  it("读未写区域 = 全透明", () => {
    const lp = new LayerPixels(W, H);
    const out = lp.getRegion(500, 500, 50, 50);
    assert(out.every((v) => v === 0), "空 = 透明");
  });

  it("部分覆盖 tile：只改交集，其余不变", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(0, 0, 256, 256, region(0, 0, 256, 256, () => [9, 9, 9, 255]));    // 填满 tile(0,0)
    lp.putRegion(0, 0, 10, 10, region(0, 0, 10, 10, () => [50, 60, 70, 255]));      // 改左上角 10×10
    const out = lp.getRegion(0, 0, 256, 256);
    assert(out[0] === 50 && out[1] === 60, "角已改");
    const farI = (200 * 256 + 200) * 4;
    assert(out[farI] === 9, "远处不变");
  });
});

describe("LayerPixels · 稀疏 / 回收", () => {
  it("全透明 putRegion 不分配 tile", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(300, 300, 100, 100, region(300, 300, 100, 100, () => [0, 0, 0, 0]));
    assert(lp.tileCount === 0, "透明不占 tile");
  });

  it("把 tile 全擦透明 → 回收", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(0, 0, 256, 256, region(0, 0, 256, 256, () => [9, 9, 9, 255]));
    assert(lp.tileCount === 1, "占 1");
    lp.putRegion(0, 0, 256, 256, region(0, 0, 256, 256, () => [0, 0, 0, 0]));    // 全擦
    assert(lp.tileCount === 0, "回收");
  });

  it("稀疏：远隔两点只占 2 tile", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(0, 0, 4, 4, region(0, 0, 4, 4, () => [1, 1, 1, 255]));
    lp.putRegion(900, 900, 4, 4, region(900, 900, 4, 4, () => [2, 2, 2, 255]));
    assert(lp.tileCount === 2, "只 2 tile（16 格里）");
  });
});

describe("LayerPixels · contentBounds（bbox 替代）", () => {
  it("空层 → null", () => { assert(new LayerPixels(W, H).contentBounds() === null, "空 null"); });

  it("tile 粒度并集", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(300, 300, 10, 10, region(300, 300, 10, 10, () => [5, 5, 5, 255]));   // tile (1,1)
    const b = lp.contentBounds(false);
    assert(b.x === 256 && b.y === 256 && b.w === 256 && b.h === 256, "tile (1,1) 框");
  });

  it("tight 扫 alpha 收紧到像素", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(300, 310, 10, 20, region(300, 310, 10, 20, () => [5, 5, 5, 255]));
    const b = lp.contentBounds(true);
    assert(b.x === 300 && b.y === 310 && b.w === 10 && b.h === 20, `紧框 = 内容，实 ${JSON.stringify(b)}`);
  });

  it("tight 全透明（有空 tile 残留也）→ null", () => {
    const lp = new LayerPixels(W, H);
    lp.putTile(0, 0, new Uint8ClampedArray(256 * 256 * 4));   // 全透明 tile 经 putTile 不会留（回收）
    assert(lp.contentBounds(true) === null, "全透明 null");
  });
});

describe("LayerPixels · sampleAt / putTile / getTile", () => {
  it("sampleAt 取点", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(100, 100, 1, 1, new Uint8ClampedArray([11, 22, 33, 44]));
    assert(JSON.stringify(lp.sampleAt(100, 100)) === "[11,22,33,44]", "取到");
    assert(JSON.stringify(lp.sampleAt(500, 500)) === "[0,0,0,0]", "空透明");
    assert(JSON.stringify(lp.sampleAt(-1, 0)) === "[0,0,0,0]", "越界透明");
  });

  it("putTile/getTile 整 tile + 全透明回收", () => {
    const lp = new LayerPixels(W, H);
    const t = new Uint8ClampedArray(256 * 256 * 4); t[0] = 7; t[3] = 255;
    lp.putTile(2, 3, t);
    assert(lp.getTile(2, 3)[0] === 7, "存取");
    lp.putTile(2, 3, new Uint8ClampedArray(256 * 256 * 4));    // 全透明
    assert(lp.getTile(2, 3) === null && lp.tileCount === 0, "透明回收");
  });
});

describe("LayerPixels · snapshot/restore + dirty", () => {
  it("snapshot/restore 像素一致且独立", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(50, 50, 20, 20, region(50, 50, 20, 20, () => [9, 8, 7, 255]));
    const snap = lp.snapshot();
    lp.putRegion(50, 50, 20, 20, region(50, 50, 20, 20, () => [1, 1, 1, 255]));   // 改
    lp.restore(snap);
    assert(lp.sampleAt(55, 55)[0] === 9, "还原");
    // 独立：改 lp 不影响 snap
    lp.clear();
    const lp2 = new LayerPixels(W, H); lp2.restore(snap);
    assert(lp2.sampleAt(55, 55)[0] === 9, "snap 未被污染");
  });

  it("dirty 跟踪：写标脏、markAllClean 清", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(0, 0, 4, 4, region(0, 0, 4, 4, () => [1, 1, 1, 255]));
    assert(lp.dirtyTileKeys().length === 1, "1 脏");
    lp.markAllClean();
    assert(lp.dirtyTileKeys().length === 0, "清");
    lp.putRegion(900, 0, 4, 4, region(900, 0, 4, 4, () => [2, 2, 2, 255]));
    assert(lp.dirtyTileKeys().length === 1, "新脏");
  });

  it("clear 标全部脏 + 清空", () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(0, 0, 300, 300, region(0, 0, 300, 300, () => [1, 1, 1, 255]));   // 4 tile
    lp.markAllClean();
    lp.clear();
    assert(lp.isEmpty() && lp.dirtyTileKeys().length === 4, "清空+4脏");
  });
});
