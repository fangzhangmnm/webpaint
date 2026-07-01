// TileResidency Slice A —— 备份基建纯逻辑测试（无损压缩往返 + dirty-never-evict 门 + contentVersion）。
// 不接 live 渲染 → node 全测（identityCodec 免环境依赖；deflateCodec 验真 CompressionStream 无损）。
import { describe, it, assert, eq } from "./runner.mjs";
import { LayerPixels } from "../src/gl/tile-pixels.ts";
import { TileResidency, identityCodec, deflateCodec } from "../src/gl/tile-residency.ts";

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
// 造一张稀疏 populated 图层：跨 3 个 tile 画不同色块（含半透明、含 alpha=0 下有 RGB 的坑）。
function makePopulated() {
  const lp = new LayerPixels(W, H);
  lp.putRegion(10, 20, 300, 300, region(10, 20, 300, 300, (x, y) => [x % 256, y % 256, (x * y) % 256, 200]));
  lp.putRegion(600, 600, 200, 150, region(600, 600, 200, 150, (x, y) => [255, (x + y) % 256, 0, 128]));
  // alpha=0 但 RGB 非零的像素（无损红线的痛点：有损 codec 会把这抹掉）
  lp.putRegion(700, 100, 4, 4, region(700, 100, 4, 4, () => [123, 45, 67, 0]));
  return lp;
}

describe("TileResidency · contentVersion（mutation +1，读不动）", () => {
  it("初值 0，各 mutator 递增，读不递增", () => {
    const lp = new LayerPixels(W, H);
    eq(lp.contentVersion, 0, "初值");
    lp.putRegion(0, 0, 4, 4, region(0, 0, 4, 4, () => [1, 2, 3, 255]));
    eq(lp.contentVersion, 1, "putRegion +1");
    lp.putTile(2, 2, new Uint8ClampedArray(256 * 256 * 4).fill(9));
    eq(lp.contentVersion, 2, "putTile +1");
    // 读操作不 bump
    lp.getRegion(0, 0, 4, 4); lp.sampleAt(1, 1); lp.contentBounds();
    eq(lp.contentVersion, 2, "读不 bump");
    const snap = lp.snapshot();
    lp.clear();
    eq(lp.contentVersion, 3, "clear +1");
    lp.restore(snap);
    eq(lp.contentVersion, 4, "restore +1");
    // no-op putRegion 不 bump
    lp.putRegion(0, 0, 0, 0, new Uint8ClampedArray(0));
    eq(lp.contentVersion, 4, "空 putRegion 不 bump");
  });
});

describe("TileResidency · 无损压缩往返（backup→restore 逐字节）", () => {
  for (const [name, codec] of [["identity", identityCodec], ["deflate", deflateCodec]]) {
    it(`${name} codec：restore 出的像素 == 原图（含 alpha=0 下 RGB）`, async () => {
      const src = makePopulated();
      const res = new TileResidency(codec);
      await res.backupLayer(7, src);
      const dst = new LayerPixels(W, H);   // 空目标（模拟被驱逐层）
      const ok = await res.restoreLayer(7, dst);
      assert(ok, "restore 成功");
      assert(eqBytes(dst.getRegion(0, 0, W, H), src.getRegion(0, 0, W, H)), `${name} 往返逐字节等价`);
      eq(dst.tileCount, src.tileCount, "tile 数一致");
    });
  }
});

describe("TileResidency · dirty-never-evict 门", () => {
  it("无备份→不可驱逐；备份后→可；编辑后→不可；重备份→可", async () => {
    const lp = makePopulated();
    const res = new TileResidency(identityCodec);
    assert(!res.canEvictRaw(7, lp), "无备份不可驱逐（红线）");
    await res.backupLayer(7, lp);
    assert(res.canEvictRaw(7, lp), "备份覆盖当前内容→可");
    lp.putRegion(50, 50, 8, 8, region(50, 50, 8, 8, () => [1, 1, 1, 255]));   // bump version
    assert(!res.canEvictRaw(7, lp), "编辑后备份陈旧→不可驱逐");
    await res.backupLayer(7, lp);
    assert(res.canEvictRaw(7, lp), "重备份后→可");
  });
  it("pinned 层永不可驱逐（即便备份最新）", async () => {
    const lp = makePopulated();
    const res = new TileResidency(identityCodec);
    await res.backupLayer(7, lp);
    res.pin(7);
    assert(!res.canEvictRaw(7, lp), "pinned→不可驱逐");
    res.unpin(7);
    assert(res.canEvictRaw(7, lp), "unpin 后→可");
  });
});

// 模拟 GPU-readback provider：驱逐前抓一份 tile 拷贝当「GPU 副本」，重物化时回填（= readSlice 行为）。
function wireFakeGpu(lp) {
  let gpu = null;
  lp.setResidencyProvider((p) => { if (gpu) p.adoptResidentTiles(gpu); });
  return { capture() { gpu = []; lp.forEachTile((tx, ty, px) => gpu.push({ tx, ty, px: new Uint8ClampedArray(px) })); } };
}

describe("LayerPixels · 驱逐 raw + 中心惰性重物化", () => {
  it("无 provider → evictRaw 拒绝（红线：不可无退路地丢）", () => {
    const lp = makePopulated();
    assert(!lp.evictRaw(), "无 provider 拒绝驱逐");
    assert(lp.isRawResident(), "仍驻留");
  });
  it("驱逐后 byteUsage=0 / isEmpty=false / contentVersion 不变", () => {
    const lp = makePopulated();
    const gpu = wireFakeGpu(lp); gpu.capture();
    const before = lp.contentVersion, tc = lp.tileCount;
    assert(lp.byteUsage > 0, "驱逐前有字节");
    // 直接操 _tiles 前先驱逐（tileCount 会触发重物化，故先读快照）
    assert(lp.evictRaw(), "驱逐成功");
    eq(lp.byteUsage, 0, "驱逐后 CPU 字节=0（省的那份，byteUsage 不重物化）");
    assert(!lp.isEmpty(), "非空层驱逐后 isEmpty=false（不谎报空）");
    eq(lp.contentVersion, before, "驱逐不 bump contentVersion");
    // 触发重物化的读
    eq(lp.tileCount, tc, "重物化后 tile 数恢复");
    eq(lp.contentVersion, before, "重物化也不 bump contentVersion");
  });
  it("所有读者驱逐后透明重物化，像素逐字节一致", () => {
    for (const read of [
      (lp, ref) => assert(eqBytes(lp.getRegion(0, 0, W, H), ref), "getRegion"),
      (lp) => assert(lp.sampleAt(100, 120)[3] === 200, "sampleAt"),
      (lp) => { let n = 0; lp.forEachTile(() => n++); assert(n > 0, "forEachTile"); },
      (lp) => assert(lp.contentBounds() !== null, "contentBounds"),
      (lp) => assert(lp.snapshot().tiles.length > 0, "snapshot"),
      (lp) => assert(lp.getTile(0, 0) !== null || lp.getTile(2, 2) !== null, "getTile"),
    ]) {
      const lp = makePopulated();
      const ref = lp.getRegion(0, 0, W, H);
      const gpu = wireFakeGpu(lp); gpu.capture();
      assert(lp.evictRaw() && !lp.isRawResident(), "已驱逐");
      read(lp, ref);
      assert(lp.isRawResident(), "读后已重物化");
    }
  });
  it("重物化后可继续编辑（putRegion bump version → 备份陈旧）", async () => {
    const lp = makePopulated();
    const res = new TileResidency(identityCodec);
    await res.backupLayer(9, lp);
    const gpu = wireFakeGpu(lp); gpu.capture();
    assert(res.canEvictRaw(9, lp), "可驱逐");
    assert(lp.evictRaw(), "驱逐");
    lp.getRegion(0, 0, 4, 4);                    // 读 → 重物化
    assert(res.canEvictRaw(9, lp), "重物化后备份仍有效（version 未变）");
    lp.putRegion(0, 0, 8, 8, region(0, 0, 8, 8, () => [5, 5, 5, 255]));   // 编辑 bump
    assert(!res.canEvictRaw(9, lp), "编辑后备份陈旧→不可驱逐");
  });
});

describe("TileResidency · 簿记", () => {
  it("hasBackup / backupEpoch / dropLayer / byteUsage", async () => {
    const lp = makePopulated();
    const res = new TileResidency(identityCodec);
    assert(!res.hasBackup(7), "初始无备份");
    eq(res.backupEpoch(7), null, "无 epoch");
    await res.backupLayer(7, lp);
    assert(res.hasBackup(7), "有备份");
    eq(res.backupEpoch(7), lp.contentVersion, "epoch=当前 version");
    assert(res.backupByteUsage() > 0, "字节占用 > 0");
    res.dropLayer(7);
    assert(!res.hasBackup(7), "dropLayer 后无备份");
    eq(res.backupByteUsage(), 0, "占用归零");
  });
  it("deflate 压缩确实变小（大面积同色）", async () => {
    const lp = new LayerPixels(W, H);
    lp.putRegion(0, 0, 512, 512, region(0, 0, 512, 512, () => [40, 40, 40, 255]));   // 4 满 tile 同色
    const res = new TileResidency(deflateCodec);
    await res.backupLayer(7, lp);
    const raw = lp.tileCount * 256 * 256 * 4;
    assert(res.backupByteUsage() < raw / 10, "同色区 deflate 应远小于 raw");
  });
});
