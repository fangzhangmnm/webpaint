// 魔棒 drag 连续选（v0.7 UX）：沿路径把扫过的区域逐个并进（跳过已盖点），一笔=一条 undo；
// cancel 无痕还原。LassoEngine 直测（polygon-lasso.test 同款 mkEng 风格），node 无 DOM。
import { describe, it, assert, eq } from "./runner.mjs";

const { LassoEngine } = await import("../src/lasso.ts");
const { Selection } = await import("../src/selection.ts");

// 三色竖条 fake layer：x<16 红 / 16..31 蓝 / 32..47 红 / 48+ 透明（threshold 20 下互为 barrier）
function stripeLayer(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  let reads = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (x < 16) { data[o] = 255; data[o + 3] = 255; }
    else if (x < 32) { data[o + 2] = 255; data[o + 3] = 255; }
    else if (x < 48) { data[o] = 255; data[o + 3] = 255; }
  }
  return {
    bboxX: 0, bboxY: 0, bboxW: w, bboxH: h,
    get reads() { return reads; },
    getImageData: () => { reads++; return { data }; },
  };
}
function count255(sel) {
  const g = sel.materializeMaskRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
  let n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === 255) n++;
  return n;
}
const mkEng = () => {
  const eng = new LassoEngine();
  eng.setDoc({ width: 64, height: 64, selection: null });
  eng.setSubTool("magic");
  return eng;
};

describe("magic-drag · 沿路径连续选", () => {
  it("拖过三个色区 → 三次查询三区并联，一条 entry（before=null）", () => {
    const eng = mkEng();
    const L = stripeLayer(64, 64);
    eng.beginMagicDrag();
    eq(eng.state(), "magic-drag", "会话开");
    assert(eng.magicDragStep(5, 5, L), "首点选中左红");
    eq(count255(eng.doc.selection), 16 * 64, "左红块");
    assert(!eng.magicDragStep(9, 5, L), "同区内点 → 跳过（accum 盖住）");
    const readsAfterFirst = L.reads;
    eng.magicDragStep(10, 6, L);
    eq(L.reads, readsAfterFirst, "跳过时不读像素");
    assert(eng.magicDragStep(20, 5, L), "进蓝区 → 并进");
    assert(eng.magicDragStep(40, 5, L), "进右红 → 并进");
    eq(count255(eng.doc.selection), 48 * 64, "三区 union");
    const entry = eng.magicDragEnd();
    assert(entry && entry.type === "selectionChange", "一条 entry");
    eq(entry.before, null, "before = 起笔时无选区");
    eq(entry.after, eng.doc.selection, "after = 最终选区");
    eq(eng.state(), "idle", "会话收摊");
  });

  it("subtract 模式拖：从全选里挖掉扫过的区", () => {
    const eng = mkEng();
    const L = stripeLayer(64, 64);
    eng.doc.selection = Selection.full(64, 64);
    eng.setSetOpMode("subtract");
    eng.beginMagicDrag();
    eng.magicDragStep(5, 5, L);     // 挖左红
    eng.magicDragStep(20, 5, L);    // 挖蓝
    const entry = eng.magicDragEnd();
    assert(entry, "有 entry");
    eq(count255(eng.doc.selection), (64 - 32) * 64, "剩右红+透明区");
    entry.before.dispose();   // 测试收尾：undo 栈不存在，手动放掉 before
    eng.doc.selection.dispose();
  });

  it("cancel（双指/出错路径）：无痕还原起笔选区", () => {
    const eng = mkEng();
    const L = stripeLayer(64, 64);
    const orig = Selection.full(4, 4, 2, 2);
    eng.doc.selection = orig;
    eng.beginMagicDrag();
    eng.magicDragStep(5, 5, L);
    assert(eng.doc.selection !== orig, "预览已变");
    eng.cancelDrawing();   // input._abortLasso 的路（cancelDrawing 分流到 magicDragCancel）
    eq(eng.doc.selection, orig, "还原原选区");
    eq(eng.state(), "idle", "会话收摊");
    eq(count255(orig), 16, "原选区完好可读（没被误 dispose）");
    orig.dispose();
  });

  it("空拖（全程没选到）→ 无 entry、选区不变", () => {
    const eng = mkEng();
    const L = stripeLayer(64, 64);
    eng.beginMagicDrag();
    // 拖在透明区（x≥48）：flood 全 doc？不——透明区与三色条互为 barrier，会选到透明连通区。
    // 换成真正选不到的：出界点。
    eq(eng.magicDragStep(-5, -5, L), false, "出界不选");
    eq(eng.magicDragEnd(), null, "无变化无 entry");
    eq(eng.doc.selection, null, "选区仍空");
  });
});
