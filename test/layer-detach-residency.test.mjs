// 叶子离开树 ⟂ 驱逐态（缺陷 A 回归）—— 删组导致被驱逐图层像素永久丢失。
//
// 故障链（真机报的 `LAYER_NOT_SYNCED:92` 就是它的末端症状）：
//   1. 切换活动层 → GLDocRenderer._backupAndEvict 把前活动层驱逐：CPU _tiles 清空，
//      像素只剩 GPU tiles + TileResidency 压缩备份。**这是常态不是边缘**。
//   2. 删除包含它的组 → 下一帧 syncAll 按树差对账：不在 live 集 → dropLayer(释放 GPU tiles)
//      + forgetExcept(删压缩备份)。两份副本同时销毁。
//   3. Ctrl+Z → treeStructure.undo → restoreTree 重挂**同一个活 Layer 对象**（零像素拷贝，
//      本是 iPad 内存优化）→ 对象回来了，像素没了。
//   4. syncLayer 见 !isRawResident() 早退 → 该叶不进 _layerTiles → _composite 每帧抛
//      LAYER_NOT_SYNCED；且 contentBounds() 返 null → **存盘/导出为全空**。
//
// 根因：syncAll 把「暂时不在树里」当成「已永久删除」，而 undo 的存在正好否定这个前提。
// 修法在模型层：叶子离开树只有两个出口（removeLayer / restoreTree），在那里强制物化。
// 只包 UI 调用点堵不住——treeStructure.redo 自己调 restoreTree 再次 detach，不经过 layers-panel。
import { describe, it, assert } from "./runner.mjs";

function makeCtx() {
  const ctx = {
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4), width: w || 1, height: h || 1 }),
    putImageData: () => {},
  };
  return new Proxy(ctx, { get(t, p) { return p in t ? t[p] : (() => {}); }, set(t, p, v) { t[p] = v; return true; } });
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this._ctx = makeCtx(); }
  getContext() { return this._ctx; }
}
const _prevOSC = globalThis.OffscreenCanvas;
function useStub() { globalThis.OffscreenCanvas = StubCanvas; }
useStub();
// **单 await 回合**（与 layer-tree / ora-tree 同约定）：顶层多一个 await 会扰动 run.mjs 一众 TLA
//   模块的微任务交错、毒到 selection-morph 的 OSC-stub。两个 import 必须并进同一个 await。实测。
const [{ PaintDoc, findNodeById }, { TileResidency, identityCodec }] = await Promise.all([
  import("../src/doc.ts"),
  import("../src/gl/tile-residency.ts"),
]);
globalThis.OffscreenCanvas = _prevOSC;

const T = (name, fn) => it(name, () => { useStub(); fn(); });
const TA = (name, fn) => it(name, async () => { useStub(); await fn(); });

function eqBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

function paint(L, ox, oy, w, h, rgba) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) { a[i] = rgba[0]; a[i + 1] = rgba[1]; a[i + 2] = rgba[2]; a[i + 3] = rgba[3]; }
  L.pixels.putRegion(ox, oy, w, h, a);
}

// 模拟 GLDocRenderer 的 GPU 侧：readback provider + 「syncAll 回收」（dropLayer + forgetExcept）。
function wireFakeGpu(L) {
  let gpu = null;
  L.pixels.setResidencyProvider((p) => { if (gpu) p.adoptResidentTiles(gpu); });
  return {
    capture() { gpu = []; L.pixels.forEachTile((tx, ty, px) => gpu.push({ tx, ty, px: new Uint8ClampedArray(px) })); },
    // syncAll 对账：该层已不在树里 → GPU tiles 释放（provider 从此拿不到东西）。
    reclaim() { gpu = null; },
  };
}

// 建一个「组里有一张画过、随后被切走(驱逐)的图层」的 doc。
async function setup() {
  const d = new PaintDoc();
  const leaf = d.addLayer();
  paint(leaf, 40, 40, 200, 200, [12, 34, 56, 255]);
  const reference = leaf.pixels.getRegion(0, 0, d.width, d.height);

  const g = d.addGroup();
  assert(d.moveIntoGroup(leaf.id, g.id), "叶移入组（前置条件）");

  const gpu = wireFakeGpu(leaf);
  gpu.capture();
  const res = new TileResidency(identityCodec);
  await res.backupLayer(leaf.id, leaf.pixels);
  assert(res.canEvictRaw(leaf.id, leaf.pixels), "可驱逐（备份覆盖当前内容）");
  assert(leaf.pixels.evictRaw(), "驱逐成功——模拟切换活动层后的常态");
  assert(!leaf.pixels.isRawResident(), "确已驱逐：CPU 侧此刻没有像素");

  return { d, leaf, g, reference, gpu, res };
}

describe("叶子离开树 ⟂ 驱逐态（缺陷 A：删组丢像素）", () => {
  TA("removeLayer 删组：离树前必须强制物化，回收后像素仍在", async () => {
    const { d, leaf, g, reference, gpu, res } = await setup();

    assert(d.removeLayer(g.id, true), "删组成功");
    assert(leaf.pixels.isRawResident(),
      "离树的叶必须已被强制物化（此刻 GPU tiles 还活着，readback 必成功）");

    // 下一帧 syncAll 的对账：GPU tiles + 压缩备份双双销毁。
    gpu.reclaim();
    res.forgetExcept(new Set());

    assert(eqBytes(leaf.pixels.getRegion(0, 0, d.width, d.height), reference),
      "回收之后像素仍与原图逐字节相等（当前会全空 → 数据丢失）");
  });

  TA("restoreTree 撤销/重做：被 detach 的叶同样要物化（redo 路径不经过 UI）", async () => {
    const { d, leaf, g, reference, gpu, res } = await setup();

    // treeStructure entry 的 before/after
    const before = d.snapshotTree();
    d.removeLayer(g.id, true);
    const after = d.snapshotTree();

    // undo：叶回到树里
    d.restoreTree(before);
    assert(findNodeById(d.layers, leaf.id), "undo 后叶在树中");

    // redo：叶再次 detach —— 这条路径由 treeStructure.redo 直接调 restoreTree，不经过 layers-panel
    d.restoreTree(after);
    assert(!findNodeById(d.layers, leaf.id), "redo 后叶已离树");
    assert(leaf.pixels.isRawResident(), "redo detach 也必须强制物化");

    gpu.reclaim();
    res.forgetExcept(new Set());

    d.restoreTree(before);   // 再 undo 回来
    assert(eqBytes(leaf.pixels.getRegion(0, 0, d.width, d.height), reference),
      "redo→回收→undo 之后像素完好");
  });

  TA("物化失败（GL context 已丢，provider 不 adopt）→ 报告失败的层 id，不静默吞掉", async () => {
    const d = new PaintDoc();
    const leaf = d.addLayer();
    paint(leaf, 10, 10, 64, 64, [9, 9, 9, 255]);
    const g = d.addGroup();
    d.moveIntoGroup(leaf.id, g.id);

    leaf.pixels.setResidencyProvider(() => { /* context 已丢：拿不到 GPU tiles，不 adopt */ });
    assert(leaf.pixels.evictRaw(), "驱逐");

    const reported = [];
    d.onMaterializeFailure = (ids) => reported.push(...ids);
    assert(d.removeLayer(g.id, true), "删组");
    assert(reported.includes(leaf.id),
      "物化失败的层 id 必须经钩子报出（app 侧红条告知人类，绝不静默丢层）");
  });

  TA("未离树的叶不受影响：解组/移入移出不触发物化（原节点重挂）", async () => {
    const { d, leaf, g } = await setup();
    assert(!leaf.pixels.isRawResident(), "前置：仍驱逐");

    assert(d.ungroup(g.id).ok, "解组");
    assert(findNodeById(d.layers, leaf.id), "叶仍在树中");
    assert(!leaf.pixels.isRawResident(),
      "叶没离开过树 → 不该被强制物化（保住 TileResidency 省的那份内存）");
  });
});

describe("restoreTree 按 id 解析（缺陷 I：别的 undo 路径会换掉 Layer 对象）", () => {
  T("对象被整批替换后，restoreTree 必须挂回**当前**对象，而不是快照里的旧指针", () => {
    const d = new PaintDoc();
    const leaf = d.layers[0];
    const g = d.addGroup();
    d.moveIntoGroup(leaf.id, g.id);
    const before = d.snapshotTree();          // 存的是 leaf 这个**活对象**

    // 模拟 docTransform.undo：restoreSnapshotAll 用同样的 id 重建全新 Layer 对象
    const all = d.snapshotAll();
    d.restoreSnapshotAll(all);
    const rebuilt = d.findLayer(leaf.id);
    assert(rebuilt && rebuilt !== leaf, "前置：同 id、但已是另一个对象");

    d.restoreTree(before);                     // 撤销那次树操作
    assert(d.findLayer(leaf.id) === rebuilt,
      "必须挂回当前对象（挂回旧指针 = 把已变换的孤儿塞回树里，画面静默出错）");
  });

  T("确实离树的叶仍回退到快照存的引用（删组撤销照常工作）", () => {
    const d = new PaintDoc();
    const keep = d.layers[0];
    const leaf = d.addLayer();
    const g = d.addGroup();
    d.moveIntoGroup(leaf.id, g.id);
    const before = d.snapshotTree();

    assert(d.removeLayer(g.id, true), "删组");
    assert(!d.findLayer(leaf.id), "叶已离树");
    d.restoreTree(before);
    assert(d.findLayer(leaf.id) === leaf, "离树的叶回退到快照引用 → 原对象回来");
    assert(d.findLayer(keep.id) === keep, "没动过的叶不受影响");
  });
});

describe("removeLayer 的物化 opt-out（v440 / R8）", () => {
  TA("默认仍强制物化（缺陷 A 的护栏不得被 opt-out 削弱）", async () => {
    const { d, leaf, g } = await setup();
    assert(!leaf.pixels.isRawResident(), "前置：被驱逐");
    assert(d.removeLayer(g.id, true), "删组（默认 materialize）");
    assert(leaf.pixels.isRawResident(), "默认路径必须物化");
  });

  TA("materialize:false → 跳过物化（调用方自带像素时省掉逐 tile 阻塞 readback）", async () => {
    const { d, leaf, g } = await setup();
    assert(!leaf.pixels.isRawResident(), "前置：被驱逐");
    assert(d.removeLayer(g.id, true, { materialize: false }), "删组（opt-out）");
    assert(!leaf.pixels.isRawResident(),
      "显式 opt-out 时不该物化——这条路径的调用方（undo/redo handler）entry 里本就带着像素");
  });
});
