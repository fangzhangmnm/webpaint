// LayerPixels 写路径 ⟂ 驱逐态（缺陷 C 回归）。
//
// 背景：`_ensureResident()` 守住了**每一个读方法**（getRegion/sampleAt/forEachTile/contentBounds/
// snapshot/getTile/tileCount），但**没有守住任何写方法**。putTile/putRegion/clear/restore 都只 bump
// contentVersion、不碰 `_evicted`。
//
// 后果（真实触发路径 = 切层后 undo 描边）：往被驱逐层恢复 undo 快照 → 像素进了 _tiles 但 _evicted 仍
// 为 true → GLDocRenderer.syncLayer 早退不上传（屏幕不变）→ 下一次读触发 _ensureResident →
// adoptResidentTiles **merge**（且跳过全透明项）→ 恢复的内容与陈旧 GPU tile 撕裂混合。
// 比"干净地回滚"更糟：CPU 侧的真相也被污染了。
//
// 这里的每条断言都是「写进去什么，就该读出什么」——与驱逐是实现细节、对写者应完全透明。
import { describe, it, assert, eq } from "./runner.mjs";
import { LayerPixels } from "../src/gl/tile-pixels.ts";

const W = 1024, H = 1024;   // 4×4 tile

function region(ox, oy, w, h, fn) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, al] = fn(ox + x, oy + y); const i = (y * w + x) * 4;
    a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
  }
  return a;
}
function eqBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

// 与 tile-residency.test.mjs 同款假 GPU：驱逐前抓一份当「GPU 副本」，重物化时回填（= readSlice 行为）。
function wireFakeGpu(lp) {
  let gpu = null;
  lp.setResidencyProvider((p) => { if (gpu) p.adoptResidentTiles(gpu); });
  return { capture() { gpu = []; lp.forEachTile((tx, ty, px) => gpu.push({ tx, ty, px: new Uint8ClampedArray(px) })); } };
}

// 「旧内容」= 被驱逐进 GPU 的那份；随后写入的「新内容」必须完胜它。
function makeEvicted() {
  const lp = new LayerPixels(W, H);
  lp.putRegion(0, 0, 600, 600, region(0, 0, 600, 600, () => [11, 22, 33, 255]));       // tile (0,0),(0,1),(1,0),(1,1)
  lp.putRegion(600, 600, 300, 300, region(600, 600, 300, 300, () => [77, 88, 99, 255])); // 远处另一片 tile
  const gpu = wireFakeGpu(lp);
  gpu.capture();
  assert(lp.evictRaw(), "驱逐成功（前置条件）");
  assert(!lp.isRawResident(), "确已驱逐");
  return lp;
}

describe("LayerPixels 写路径 ⟂ 驱逐态（缺陷 C）", () => {
  it("restore：整体替换后读回的是快照内容，不是陈旧 GPU 内容", () => {
    const ref = new LayerPixels(W, H);
    ref.putRegion(100, 100, 200, 200, region(100, 100, 200, 200, () => [1, 2, 3, 255]));
    const snap = ref.snapshot();

    const lp = makeEvicted();
    lp.restore(snap);
    assert(eqBytes(lp.getRegion(0, 0, W, H), ref.getRegion(0, 0, W, H)),
      "restore 到被驱逐层 → 读回快照内容（当前会被 GPU 陈旧 tile 撕裂覆盖）");
  });

  it("clear：清空后读回全透明，不是陈旧 GPU 内容复活", () => {
    const lp = makeEvicted();
    lp.clear();
    eq(lp.tileCount, 0, "clear 后无 tile（当前会被 provider 回填复活）");
    const px = lp.getRegion(0, 0, W, H);
    let nonZero = 0; for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) nonZero++;
    eq(nonZero, 0, "clear 后全透明");
  });

  it("putRegion：局部写入后，写入区=新内容，未触及区=原内容（不搁浅成空）", () => {
    const lp = makeEvicted();
    const patch = region(50, 50, 100, 100, () => [200, 100, 50, 255]);
    lp.putRegion(50, 50, 100, 100, patch);

    assert(eqBytes(lp.getRegion(50, 50, 100, 100), patch), "写入区 = 刚写的新内容");
    // 同 tile 内未触及处（(0,0) tile 里 50..150 之外）必须仍是旧内容 —— 局部写不能把其余 tile 搁浅成空
    const untouched = lp.getRegion(300, 300, 4, 4);
    eq(untouched[0], 11, "同层未触及区 R 仍是原内容");
    eq(untouched[3], 255, "同层未触及区 alpha 仍是原内容");
    // 远处另一片 tile 也必须完好
    const far = lp.getRegion(700, 700, 4, 4);
    eq(far[0], 77, "远处 tile 未受影响");
  });

  it("putTile：整 tile 写入后读回新 tile，且不被 GPU 陈旧 tile 覆盖", () => {
    const lp = makeEvicted();
    const fresh = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < fresh.length; i += 4) { fresh[i] = 5; fresh[i + 1] = 6; fresh[i + 2] = 7; fresh[i + 3] = 255; }
    lp.putTile(0, 0, fresh);

    const got = lp.getRegion(0, 0, 4, 4);
    eq(got[0], 5, "tile(0,0) R = 刚写的（当前会被 GPU 陈旧 tile 覆盖回 11）");
    eq(got[1], 6, "G");
    eq(got[2], 7, "B");
  });

  it("写入后 isRawResident() 为真（写路径必须解除驱逐态，否则 syncLayer 跳过上传→屏幕不更新）", () => {
    for (const [name, write] of [
      ["putRegion", (lp) => lp.putRegion(0, 0, 8, 8, region(0, 0, 8, 8, () => [1, 1, 1, 255]))],
      ["putTile", (lp) => lp.putTile(1, 1, new Uint8ClampedArray(256 * 256 * 4).fill(9))],
      ["clear", (lp) => lp.clear()],
      ["restore", (lp) => lp.restore(new LayerPixels(W, H).snapshot())],
    ]) {
      const lp = makeEvicted();
      write(lp);
      assert(lp.isRawResident(), `${name} 后应已驻留（GL 侧才会重传这层）`);
    }
  });
});
