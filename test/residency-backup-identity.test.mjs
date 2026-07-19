// TileResidency 备份的归属校验（缺陷 F 回归）—— 备份必须绑到它所描述的那个 LayerPixels 对象。
//
// 驱逐门是 `backup.epoch === pixels.contentVersion` 的**数值**比较。这在「同一个 LayerPixels 一直
// 被编辑」的前提下成立，但 doc 变换（crop/flip/rotate90/offsetWrapped）走的是 Layer.setPixels()：
// 它把整个 LayerPixels **换成新对象**（纯变换返回新实例），新对象的 contentVersion 从 0 重新数。
// 而 TileResidency 里那份**变换前**的备份还挂在同一个 layerId 上、epoch 是老对象的版本号。
// 两个不同对象的版本号撞上是很平常的事（画过一笔的层 epoch=1；cropped() 内部也就 putRegion 一次）。
//
// 撞上的后果：canEvictRaw 误判可驱逐 → 该层 CPU raw 被丢，而它唯一的备份描述的是变换**前**的像素，
// 且 tile 几何按**旧 docW** 编码（tile key 含 across=tilesAcross(docW)）。GPU context 一丢，
// recoverAll 就用这份备份重物化 → 错像素 + 错几何，静默。
//
// 修法：备份记住它属于哪个 LayerPixels 实例，换对象即失效——比数值 epoch 强，且覆盖整类
// 「pixels 对象被换掉」的情形，不需要 doc 层知道 residency 的存在。
import { describe, it, assert } from "./runner.mjs";
import { LayerPixels } from "../src/gl/tile-pixels.ts";
import { TileResidency, identityCodec } from "../src/gl/tile-residency.ts";

const W = 1024, H = 1024;

function filled(lp, ox, oy, w, h, v) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) { a[i] = v; a[i + 1] = v; a[i + 2] = v; a[i + 3] = 255; }
  lp.putRegion(ox, oy, w, h, a);
}

describe("TileResidency · 备份归属（缺陷 F：doc 变换换掉 LayerPixels 对象）", () => {
  it("换了 pixels 对象 → 旧备份不得再作为驱逐依据（哪怕 contentVersion 数值撞上）", async () => {
    const oldPixels = new LayerPixels(W, H);
    filled(oldPixels, 0, 0, 200, 200, 60);          // contentVersion = 1

    const res = new TileResidency(identityCodec);
    await res.backupLayer(7, oldPixels);
    assert(res.canEvictRaw(7, oldPixels), "前置：老对象自己是可驱逐的（备份覆盖其当前内容）");

    // doc 变换：Layer.setPixels 换上一个**新** LayerPixels（纯变换返回新实例），版本号从头数。
    const newPixels = new LayerPixels(W, H);
    filled(newPixels, 0, 0, 200, 200, 200);         // contentVersion 同样 = 1 → 与旧 epoch 撞号
    assert(newPixels.contentVersion === oldPixels.contentVersion,
      "前置：两个不同对象的 contentVersion 撞上了（这正是数值比较靠不住的地方）");

    assert(!res.canEvictRaw(7, newPixels),
      "换了对象 → 必须拒绝驱逐（那份备份描述的是变换前的像素、且按旧 docW 的 tile 几何编码）");
  });

  it("重新备份之后恢复可驱逐（不是把这层永久钉死在内存里）", async () => {
    const res = new TileResidency(identityCodec);
    const a = new LayerPixels(W, H); filled(a, 0, 0, 100, 100, 10);
    await res.backupLayer(7, a);

    const b = new LayerPixels(W, H); filled(b, 0, 0, 100, 100, 20);
    assert(!res.canEvictRaw(7, b), "换对象后先拒绝");
    await res.backupLayer(7, b);
    assert(res.canEvictRaw(7, b), "为新对象重新备份后 → 可驱逐");
  });

  it("同一对象继续编辑仍走原来的 epoch 语义（不破坏既有行为）", async () => {
    const res = new TileResidency(identityCodec);
    const lp = new LayerPixels(W, H); filled(lp, 0, 0, 100, 100, 10);
    await res.backupLayer(9, lp);
    assert(res.canEvictRaw(9, lp), "备份覆盖当前内容 → 可");
    filled(lp, 300, 300, 50, 50, 99);                     // 编辑 → bump
    assert(!res.canEvictRaw(9, lp), "编辑后备份陈旧 → 不可");
    await res.backupLayer(9, lp);
    assert(res.canEvictRaw(9, lp), "重备份 → 可");
  });

  it("doc 尺寸变（crop/rotate）后的新 pixels：备份归属不同 → 拒绝", async () => {
    const res = new TileResidency(identityCodec);
    const before = new LayerPixels(W, H); filled(before, 0, 0, 300, 300, 33);
    await res.backupLayer(3, before);
    // rotate90CCW 返回新实例且 doc 尺寸互换 → tile 几何（across）随之变
    const after = before.rotated90CCW();
    assert(!res.canEvictRaw(3, after),
      "旧备份的 tile key 按旧 across 编码，绝不能用来判定新几何对象可驱逐");
  });
});
