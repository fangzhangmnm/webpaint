// S5 · Selection gray8 tile 底座验收（v0.4.6）。
// 覆盖（对照 ai-docs/20260722-v04-batch1-handoff.md §4-S5 + test-charter (c)）：
//   - fromGray8Region / full：稀疏建 tile、全零格不建、紧 bbox 聚合（跨 tile 边界）
//   - compose per-tile 布尔：union/subtract/intersect 的 AA 公式 + 稀疏共享（无对手格 acquire 原 tile）
//   - subtract 减光 → null（旧 canvas 版留“隐形空选区”，v0.4.6 语义改进）
//   - invert / croppedTo / flippedHorizontal（rotate/offset 已在 doc-rotate/doc-offset 测）
//   - 窄读口 sampleAt / materializeMaskRegion / bboxMask 缓存
//   - clone/dispose 所有权：双 dispose throw、use-after-dispose throw、clone 后互不影响
//   - SelectionComponent（T4a 起）：do/undo/redo 往返 + disposeRecord 释放句柄 + 配额按压缩字节
//   - marching-ants：正方形 golden 走线 + 缓存身份
//   - H7（液化选区 doc-space）：**RED 挂线**（S8 液化重写转绿），todo() 占位
import { describe, it, assert, eq, todo } from "./runner.mjs";

const { Selection } = await import("../src/selection.ts");
const { antsOutline } = await import("../src/marching-ants.ts");
const { appTilePool } = await import("../src/tiles/app-tile-pool.ts");
const { TILE_SIZE } = await import("../src/tiles/tile-geometry.ts");

// gray8 矩形工厂：在 (x,y) 放 w×h 的实心 v 值块
function solid(x, y, w, h, v = 255) {
  const g = new Uint8Array(w * h).fill(v);
  return Selection.fromGray8Region(x, y, w, h, g);
}

describe("Selection · fromGray8Region / 稀疏 tile / 紧 bbox", () => {
  it("跨 tile 边界的块：tile 数与 bbox 都对", () => {
    // 以 TILE_SIZE 边界为中心放 4×4 块 → 覆盖 4 个 tile
    const c = TILE_SIZE;
    const s = solid(c - 2, c - 2, 4, 4);
    eq(s.tileCount, 4, "跨界 4 tile");
    eq(s.bboxX, c - 2, "bboxX"); eq(s.bboxY, c - 2, "bboxY");
    eq(s.bboxW, 4, "bboxW"); eq(s.bboxH, 4, "bboxH");
    eq(s.sampleAt(c, c), 255, "中心点在");
    eq(s.sampleAt(c - 3, c - 3), 0, "块外为 0");
    s.dispose();
  });
  it("全零输入 → null；负坐标部分被裁", () => {
    eq(Selection.fromGray8Region(0, 0, 8, 8, new Uint8Array(64)), null, "全零 → null");
    const g = new Uint8Array(4 * 4).fill(255);
    const s = Selection.fromGray8Region(-2, -2, 4, 4, g);   // 左上 2×2 落负坐标 → 裁掉
    eq(s.bboxX, 0, "负坐标裁掉后 bbox 从 0 起");
    eq(s.bboxW, 2, "剩 2×2");
    eq(s.sampleAt(0, 0), 255, "(0,0) 在");
    s.dispose();
  });
  it("远离的两个小块：稀疏（只 2 tile），bbox 聚合跨两块", () => {
    const g = new Uint8Array(TILE_SIZE * 2 * 4);
    g[0] = 255;                                        // (0,0)
    g[3 * TILE_SIZE * 2 + TILE_SIZE * 2 - 1] = 255;    // (2*TILE-1, 3)
    const s = Selection.fromGray8Region(0, 0, TILE_SIZE * 2, 4, g);
    eq(s.tileCount, 2, "只建 2 个 tile（中间空 tile 不建）");
    eq(s.bboxW, TILE_SIZE * 2, "bbox 跨两块");
    s.dispose();
  });
});

describe("Selection.compose · per-tile 布尔 + AA 公式", () => {
  it("union：不相交两块 = 两者并存；无对手格共享原 tile（id 相同）", () => {
    const a = solid(0, 0, 4, 4);
    const b = solid(TILE_SIZE, 0, 4, 4);   // 另一个 tile
    const u = Selection.compose(a, b, "union");
    assert(u && u !== a && u !== b, "产新对象");
    eq(u.sampleAt(1, 1), 255, "a 区在");
    eq(u.sampleAt(TILE_SIZE + 1, 1), 255, "b 区在");
    eq(u.tileCount, 2, "2 tile");
    // 稀疏共享：union 的 tile 与源 tile 同 id（acquire 非拷贝）
    const aIds = new Set([...a.tileHandles()].map((h) => h.id));
    const shared = [...u.tileHandles()].filter((h) => aIds.has(h.id));
    eq(shared.length, 1, "a 的 tile 被零拷贝共享");
    a.dispose(); b.dispose(); u.dispose();
  });
  it("union AA：128 ∪ 128 = src-over 公式（≈192）", () => {
    const a = solid(0, 0, 2, 2, 128);
    const b = solid(0, 0, 2, 2, 128);
    const u = Selection.compose(a, b, "union");
    const v = u.sampleAt(0, 0);
    // 128 + round(128*127/255) = 128+64 = 192
    eq(v, 192, `src-over(128,128) 应 192，实得 ${v}`);
    a.dispose(); b.dispose(); u.dispose();
  });
  it("subtract：部分减 → 剩余对；减光 → null（v0.4.6 语义改进）", () => {
    const a = solid(0, 0, 4, 2);
    const b = solid(2, 0, 2, 2);
    const s = Selection.compose(a, b, "subtract");
    eq(s.sampleAt(1, 0), 255, "左半留");
    eq(s.sampleAt(2, 0), 0, "右半没");
    eq(s.bboxW, 2, "紧 bbox 收到左半");
    const gone = Selection.compose(a, a, "subtract");
    eq(gone, null, "自减 → null（不留隐形空选区）");
    a.dispose(); b.dispose(); s.dispose();
  });
  it("intersect：只留交集；不相交 → null", () => {
    const a = solid(0, 0, 4, 4);
    const b = solid(2, 2, 4, 4);
    const i = Selection.compose(a, b, "intersect");
    eq(i.sampleAt(3, 3), 255, "交集在");
    eq(i.sampleAt(1, 1), 0, "非交集不在");
    eq(i.bboxX, 2, "bbox=交集");
    eq(i.bboxW, 2, "bbox=交集宽");
    const c = solid(TILE_SIZE * 2, 0, 2, 2);
    eq(Selection.compose(a, c, "intersect"), null, "不相交 → null");
    a.dispose(); b.dispose(); i.dispose(); c.dispose();
  });
  it("mode=new / 单边 null：原样返回入参（所有权判据 = 引用相等）", () => {
    const a = solid(0, 0, 2, 2);
    const b = solid(4, 4, 2, 2);
    assert(Selection.compose(a, b, "new") === b, "new → 返 b 本体");
    assert(Selection.compose(null, b, "union") === b, "无 old → 返 b 本体");
    assert(Selection.compose(a, null, "union") === a, "无 new → 返 a 本体");
    a.dispose(); b.dispose();
  });
});

describe("Selection · invert / croppedTo / flippedHorizontal", () => {
  it("invert：块外变全选、块内空；再 invert 回原", () => {
    const s = solid(2, 2, 2, 2);
    const inv = s.invert(8, 8);
    eq(inv.sampleAt(0, 0), 255, "外 → 选");
    eq(inv.sampleAt(2, 2), 0, "内 → 不选");
    eq(inv.bboxW, 8, "反选 bbox=整幅");
    const back = inv.invert(8, 8);
    eq(back.sampleAt(2, 2), 255, "二次反选回原");
    eq(back.bboxX, 2, "紧 bbox 回原");
    eq(back.bboxW, 2, "紧 bbox 回原宽");
    s.dispose(); inv.dispose(); back.dispose();
  });
  it("croppedTo：平移 + 裁剪；全裁掉 → null", () => {
    const s = solid(4, 4, 4, 4);
    const c = s.croppedTo(2, 2, 10, 10);   // 原点移 (2,2)
    eq(c.bboxX, 2, "bbox 平移");
    eq(c.sampleAt(2, 2), 255, "内容跟着平移");
    eq(s.croppedTo(100, 100, 4, 4), null, "全裁掉 → null");
    s.dispose(); c.dispose();
  });
  it("flippedHorizontal：非对称块镜像", () => {
    // (1,0) 处 1×1 块，docW=4 → 镜像到 (2,0)
    const g = new Uint8Array([255]);
    const s = Selection.fromGray8Region(1, 0, 1, 1, g);
    const f = s.flippedHorizontal(4);
    eq(f.sampleAt(2, 0), 255, "镜像位置");
    eq(f.sampleAt(1, 0), 0, "原位空");
    s.dispose(); f.dispose();
  });
});

describe("Selection · 窄读口 + 所有权", () => {
  it("materializeMaskRegion：越 bbox 区域补 0；bboxMask 缓存同一 buffer", () => {
    const s = solid(2, 2, 2, 2);
    const g = s.materializeMaskRegion(0, 0, 6, 6);
    eq(g[0], 0, "外 0");
    eq(g[2 * 6 + 2], 255, "内 255");
    assert(s.bboxMask().data === s.bboxMask().data, "bboxMask 懒缓存（同 buffer 身份）");
    s.dispose();
  });
  it("clone 共享 tile（refCount+1）；dispose 一边另一边照读", () => {
    const s = solid(0, 0, 2, 2);
    const h0 = [...s.tileHandles()][0];
    eq(h0.refCount(), 1, "初始 rc=1");
    const c = s.clone();
    eq(h0.refCount(), 2, "clone 后 rc=2");
    s.dispose();
    eq(c.sampleAt(0, 0), 255, "clone 侧照读");
    c.dispose();
  });
  it("双 dispose / use-after-dispose 立刻 throw", () => {
    const s = solid(0, 0, 2, 2);
    s.dispose();
    let threw = 0;
    try { s.dispose(); } catch { threw++; }
    try { s.sampleAt(0, 0); } catch { threw++; }
    eq(threw, 2, "双 dispose 与 UAF 都应 throw");
  });
});

describe("SelectionComponent · 往返 + 句柄释放（T4a：SwapSelectionOp 锚迁移）", () => {
  async function setup() {
    const { PaintingWorkpiece } = await import("../src/workpiece/painting-workpiece.ts");
    const { UndoStack } = await import("../src/workpiece/undo-stack.ts");
    const stack = new UndoStack({ maxQuotaBytes: 1 << 20 });
    const wp2 = new PaintingWorkpiece({ undo: stack, tree: { width: 64, height: 64 } });
    return { wp2, stack, sel: wp2.selection };
  }
  it("do→undo→redo 往返：选区引用正确换手（零拷贝）", async () => {
    const { wp2, stack, sel } = await setup();
    const s1 = solid(0, 0, 4, 4);
    sel._rawWrite(s1);                                     // pre-applied：引擎先改
    const t = wp2.begin("sel");
    sel.commitPreApplied(null);
    t.commit();
    stack.undo();
    eq(sel.view(), null, "undo 回无选区");
    assert(!s1.disposed, "undo 后 s1 在 redo 包里，未释放");
    stack.redo();
    assert(sel.view() === s1, "redo 回 s1 本体（引用交换，零拷贝）");
    stack.clear();
    assert(!s1.disposed, "s1 在 substrate 手里，clear 不动它");
    sel.clearOnLoad();
  });
  it("clear 历史释放包内 Selection 句柄（disposeRecord）", async () => {
    const { wp2, stack, sel } = await setup();
    const s1 = solid(0, 0, 4, 4);
    const s2 = solid(8, 8, 4, 4);
    sel._rawWrite(s1);
    let t = wp2.begin("sel");
    sel.commitPreApplied(null);
    t.commit();
    sel._rawWrite(s2);                                     // 换选区：s1 交给包
    t = wp2.begin("sel");
    sel.commitPreApplied(s1);
    t.commit();
    stack.clear();
    assert(s1.disposed, "包持有的 s1 被 disposeRecord 释放");
    assert(!s2.disposed, "substrate 持有的 s2 不动");
    sel.clearOnLoad();
  });
  it("配额估计：raw 期 ≈ 基础值（tile 计 0，走共享池配额）", async () => {
    const { sel } = await setup();
    const s = solid(0, 0, 16, 16);
    const base = sel.recordBytes({ v: s });
    assert(base >= 256 && base < 2048, `raw 期只有基础值（tile 计 0），实得 ${base}`);
    s.dispose();
  });
});

describe("marching-ants · outline golden + 缓存", () => {
  it("正方形块：闭合单链，整数格阶梯轮廓 = 真像素边界（v0.6.43 boundary tracing）", () => {
    const s = solid(4, 4, 2, 2);
    const chains = antsOutline(s);
    eq(chains.length, 1, "单闭合链");
    const ch = chains[0];
    // 2×2 块 @(4,4) 的像素边界 = 正方形 [4,6]×[4,6]，全整数格、无 .5 中点、无 45° 切角。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hasHalf = false;
    for (let i = 0; i < ch.length; i += 2) {
      minX = Math.min(minX, ch[i]); maxX = Math.max(maxX, ch[i]);
      minY = Math.min(minY, ch[i + 1]); maxY = Math.max(maxY, ch[i + 1]);
      if (ch[i] % 1 !== 0 || ch[i + 1] % 1 !== 0) hasHalf = true;
    }
    eq(minX, 4, "左缘 = 像素边界 4");
    eq(minY, 4, "上缘 = 像素边界 4");
    eq(maxX, 6, "右缘 = 像素边界 6");
    eq(maxY, 6, "下缘 = 像素边界 6");
    assert(!hasHalf, "全整数格（阶梯轮廓，无 marching squares 半格中点）");
    // 闭合：首尾相接
    eq(ch[0], ch[ch.length - 2], "闭合 x");
    eq(ch[1], ch[ch.length - 1], "闭合 y");
    assert(antsOutline(s) === chains, "WeakMap 缓存：同对象同结果身份");
    s.dispose();
  });
  it("单像素选区：1×1 也有完整方框轮廓（旧 marching squares w<=1 直接放弃）", () => {
    const s = solid(7, 9, 1, 1);
    const chains = antsOutline(s);
    eq(chains.length, 1, "单链");
    eq(chains[0].length, 10, "4 边闭合 = 5 个点");
    s.dispose();
  });
  it("AA 阈值 >128：129 算内、128 算外（与 morph 二值化一致）", () => {
    const a = solid(0, 0, 2, 2, 129);
    eq(antsOutline(a).length, 1, "129 → 有轮廓");
    const b = solid(4, 4, 2, 2, 128);
    eq(antsOutline(b).length, 0, "128 → 无轮廓（阈值排除）");
    a.dispose(); b.dispose();
  });
});

// charter H7（液化选区 doc-space）：S8 液化重写后已转绿 → 真测试在 test/liquify-docspace-mask.test.mjs。

// v0.7.38 · fromLayerAlpha（「从当前图层建选区」工厂）：α≥128 二值化 + bbox 直读 + 空层 null
describe("Selection · fromLayerAlpha（v0.7.38 从图层 alpha 建选区）", () => {
  it("半透明边缘二值化（α≥128 入选）、位置随 layer bbox、恒二值不变量", async () => {
    const { PaintDoc, flattenLeaves } = await import("../src/doc.ts");
    const doc = new PaintDoc({ width: 512, height: 512 });
    const L = doc.activeLayer;
    // (100,100) 起 3 像素排：α=255 / α=200 / α=100（后者应被阈出）
    const buf = new Uint8ClampedArray(3 * 1 * 4);
    buf.set([9, 9, 9, 255,  9, 9, 9, 200,  9, 9, 9, 100]);
    L.pixels.putRegion(100, 100, 3, 1, buf);
    const sel = Selection.fromLayerAlpha(L);
    assert(sel, "非空层出选区");
    eq(sel.sampleAt(100, 100), 255, "α255 → 入选（值恒 255，二值不变量）");
    eq(sel.sampleAt(101, 100), 255, "α200 ≥128 → 入选");
    eq(sel.sampleAt(102, 100), 0, "α100 <128 → 阈出");
    eq(sel.sampleAt(99, 100), 0, "bbox 外为空");
    sel.dispose();
    // 空层 → null（= 没选区语义）
    const doc2 = new PaintDoc({ width: 64, height: 64 });
    eq(Selection.fromLayerAlpha(doc2.activeLayer), null, "空层 → null");
    for (const d of [doc, doc2]) { for (const leaf of flattenLeaves(d.layers)) leaf.pixels?.dispose?.(); }
  });
});
