// S6 · float 入 workpiece 的行为锁（真 PaintDoc + 真 FloatingTransform 引擎，node 全跑）。
// 守的契约（spec journal/20260721 Architecture.md :208-230 + handoff §4-S6）：
//   - lift = 一个整点：(清选区 + 建 float tiles + 挖洞)，undo 像素级复原 + 选区回来；
//   - 拖动 = metadata 微整点（每手势一个 checkpoint，undo 只回网格不动像素）；
//   - reject（cancel）= identity 写回 operator（非 undo）：binary mask 下像素**逐字节精确**回原、
//     中途 stamp 保留、reject 本身可再撤销；
//   - accept（commit）= 烤层 + DropFloat 一个整点，undo 浮层回来（状态对象 internals↔包移交）；
//   - 驱逐/截断释放 float tiles（disposeData；池 FR 兜底不该响）。
// GPU warp 烤定（bakeFn）路径 node 不可测（无 GL）——stamp/accept 的像素烤制归真机批；
// 这里 accept 用 bakeFn=null（烤制跳过，结构/所有权照测）。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { Selection } from "../src/selection.ts";
import { FloatingTransform } from "../src/floating-transform.ts";

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
const _ctxs = [], _orphans = [];   // _orphans：测试有意造成的「脱离 doc 的层」（所有权归测试）
function mk() {
  const doc = new PaintDoc({ width: 512, height: 512 });
  const w = new Workpiece(doc);
  let unrec = 0;
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => { unrec++; } });
  const ops = makeOperators({ applyDocTransformUi: () => {} });
  const ft = new FloatingTransform();
  ft.attach(w, h, ops);
  _ctxs.push({ doc, w, h });
  return { doc, w, h, ops, ft, unrec: () => unrec };
}
const px = (r, g, b, a) => new Uint8ClampedArray([r, g, b, a]);
// 不透明方块（x0,y0,w,h 全 [10,20,30,255]）
function paintRect(L, x0, y0, w, h) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 10; buf[i + 1] = 20; buf[i + 2] = 30; buf[i + 3] = 255; }
  L.pixels.putRegion(x0, y0, w, h, buf);
}
// binary 全选一个矩形
const rectSel = (x0, y0, w, h) => Selection.full(w, h, x0, y0);

describe("S6 · LiftFloatOp（lift 整点：清选区 + float tiles + 挖洞）", () => {
  it("lift(cut) → 洞开了、float 在 workpiece、选区清了；undo 逐字节复原 + 选区回来；redo 再来", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    const origBytes = L.pixels.getRegion(20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    const selRef = doc.selection;

    eq(ft.lift(L), true, "lift 成功");
    const fs = w.readFloatState();
    assert(fs && fs.floats.length === 1, "float 进 workpiece");
    eq(fs.floats[0].sourceLayerId, L.id);
    eq(fs.floats[0].rect.x, 30); eq(fs.floats[0].rect.w, 16);
    eq(L.sampleAt(35, 35)[3], 0, "源层挖了洞");
    eq(L.sampleAt(22, 22)[3], 255, "选区外没动");
    eq(doc.selection, null, "lift 清选区（spec:213）");
    eq(fs.floats[0].pixels.sampleAt(35, 35)[3], 255, "float tiles 有像素");
    // gizmo = float rect（v0.6.21 frame 化：origin/ux 轴对齐）
    eq(fs.transform.gizmoFrame.origin.x, 30); eq(fs.transform.gizmoFrame.ux.x, 16);
    eq(fs.transform.mode, "free");

    h.undo(w);
    eq(w.readFloatState(), null, "undo：浮层消失");
    eq(doc.selection, selRef, "undo：选区原对象回来（所有权链 doc→包→doc）");
    const after = L.pixels.getRegion(20, 20, 40, 40);
    assert(origBytes.every((v, i) => v === after[i]), "undo：像素逐字节复原");

    h.redo(w);
    assert(w.readFloatState(), "redo：浮层回来");
    eq(L.sampleAt(35, 35)[3], 0, "redo：洞回来");
    eq(doc.selection, null, "redo：选区再次清空");
  });

  it("lift(cut:false)（Ctrl+D 复制为浮层）：源层不动", () => {
    const { doc, w, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    eq(ft.lift(L, { cut: false }), true);
    eq(L.sampleAt(35, 35)[3], 255, "复制模式：源层没挖洞");
    assert(w.readFloatState(), "浮层照建");
  });

  it("无选区 + fallbackFullLayer：隐式整层全选；无选区无 fallback → ok:false 栈不动", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 100, 100, 20, 20);
    eq(ft.lift(L), false, "无选区无 fallback：拒绝");
    eq(h.canUndo(), false, "栈没动");
    eq(ft.lift(L, { fallbackFullLayer: true }), true);
    const fs = w.readFloatState();
    eq(fs.floats[0].rect.x, 100); eq(fs.floats[0].rect.w, 20, "float = 整层内容紧框");
    eq(L.pixels.isEmpty(), true, "整层被挖空");
  });

  it("组 lift：组内所有叶各一 float，共享 gizmo（多 float z 锚点 = 各自 sourceLayerId）", () => {
    const { doc, w, ft } = mk();
    const L1 = doc.activeLayer;
    paintRect(L1, 10, 10, 20, 20);
    const L2 = doc.addLayer("上层");
    paintRect(L2, 40, 40, 20, 20);
    const g = doc.groupSelection(L2.id);       // L2 进组
    doc.moveIntoGroup(L1.id, g.group.id);      // L1 也进组
    doc.addLayer("留守");                       // keep-one：组外再留一层
    eq(ft.lift(g.group, { fallbackFullLayer: true }), true);
    const fs = w.readFloatState();
    eq(fs.floats.length, 2, "两叶各一 float");
    const ids = fs.floats.map((f) => f.sourceLayerId).sort();
    eq(ids.join(","), [L1.id, L2.id].sort().join(","), "z 锚点 = 各自源叶");
    // gizmo = 可见叶 rect 并集（v0.6.21 frame 化）
    eq(fs.transform.gizmoFrame.origin.x, 10);
    eq(fs.transform.gizmoFrame.ux.x, 50, "10..60 并集");
  });

  it("选区与图层无交集 / 选区内全透明 → ok:false", () => {
    const { doc, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 10, 10);
    doc.selection = rectSel(400, 400, 20, 20);
    eq(ft.lift(L), false, "无交集拒绝");
  });
});

describe("S6 · FloatTransformOp（metadata 微整点）", () => {
  it("拖动一次 = 一个整点：mesh 入 workpiece；undo 回旧网格（像素不动）；redo 回新网格", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    const holeBytes = L.pixels.getRegion(20, 20, 40, 40);

    ft.beginDrag({ kind: "translate" }, 0, 0);
    ft.extendDrag(5, 3);
    ft.endDrag();
    let fs = w.readFloatState();
    eq(fs.transform.mesh[0][0].x, 35, "TL 平移 +5 已入栈（30+5）");
    eq(fs.transform.mesh[0][0].y, 33);

    h.undo(w);
    fs = w.readFloatState();
    assert(fs, "undo 只回网格，浮层还在");
    eq(fs.transform.mesh[0][0].x, 30, "网格回原位");
    const after = L.pixels.getRegion(20, 20, 40, 40);
    assert(holeBytes.every((v, i) => v === after[i]), "像素一个字节没动");
    ft.syncFromWorkpiece();
    eq(ft._live.mesh[0][0].x, 30, "引擎 live 网格重采纳");

    h.redo(w);
    eq(w.readFloatState().transform.mesh[0][0].x, 35, "redo 回新网格");
  });

  it("点一下就松（网格没动）→ 不产生整点；setMode 投影 = 一个整点", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    const d0 = h.depth;
    ft.beginDrag({ kind: "translate" }, 0, 0);
    ft.endDrag();
    eq(h.depth, d0, "空拖不入栈");
    ft.setMode("distort");
    eq(h.depth, d0 + 1, "切模式 = metadata 整点");
    eq(w.readFloatState().transform.mode, "distort");
    h.undo(w);
    eq(w.readFloatState().transform.mode, "free", "undo 回 free");
  });
});

describe("S6 · reject（cancel = identity 写回 operator，非 undo）", () => {
  it("binary mask：lift(cut) → reject → 像素逐字节回原；reject 是可撤销整点", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    const origBytes = L.pixels.getRegion(0, 0, 100, 100);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    eq(ft.cancel(), true, "reject 成功");
    eq(w.readFloatState(), null, "浮层收摊");
    const after = L.pixels.getRegion(0, 0, 100, 100);
    assert(origBytes.every((v, i) => v === after[i]), "identity 写回：binary mask 逐字节精确");
    eq(doc.selection, null, "选区保持 lift 后的空态（reject ≠ undo）");

    h.undo(w);                                   // 撤销 reject
    assert(w.readFloatState(), "undo reject：浮层回来");
    eq(L.sampleAt(35, 35)[3], 0, "洞也回来");
    h.undo(w);                                   // 再撤销 lift
    eq(w.readFloatState(), null);
    const after2 = L.pixels.getRegion(0, 0, 100, 100);
    assert(origBytes.every((v, i) => v === after2[i]), "undo 链一路回原");
  });

  it("中途改过层（模拟 stamp）：reject 保留改动、float 落其上（spec:225）", () => {
    const { doc, w, h, ops, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    // 模拟 stamp：洞外新画一点（walk ops.pixels 事务型，跟真 stamp 同路径）
    const before = L.snapshot();
    L.pixels.putRegion(70, 70, 1, 1, px(200, 0, 0, 255));
    h.run(w, ops.pixels, { layerId: L.id, _initialBefore: before });
    ft.cancel();
    eq(L.sampleAt(70, 70)[0], 200, "stamp 保留");
    eq(L.sampleAt(35, 35)[3], 255, "float 像素落回原位");
  });
});

describe("S6 · accept（commit = 烤层 + DropFloat 整点）+ 所有权/驱逐", () => {
  it("accept(bakeFn=null)：浮层收摊；undo 浮层回来（FloatState internals↔包移交）；redo 再收", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    const fsRef = w.readFloatState();
    eq(ft.commit(null), true, "accept ok（GL 缺席：烤制跳过，结构照走）");
    eq(w.readFloatState(), null, "浮层收摊");
    h.undo(w);
    eq(w.readFloatState(), fsRef, "undo accept：同一个 FloatState 对象回 internals（移交非复制）");
    assert(fsRef.floats[0].pixels.tileCount > 0, "float tiles 活着");
    h.redo(w);
    eq(w.readFloatState(), null, "redo：再收摊");
    h.undo(w);
    eq(w.readFloatState(), fsRef, "二次往复无衰减");
  });

  it("lift→拖→accept 整链 undo×3 回起点、redo×3 回终点", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    const origBytes = L.pixels.getRegion(0, 0, 100, 100);
    doc.selection = rectSel(30, 30, 16, 16);
    const selRef = doc.selection;
    ft.lift(L);
    ft.beginDrag({ kind: "translate" }, 0, 0); ft.extendDrag(8, 0); ft.endDrag();
    ft.commit(null);
    eq(w.readFloatState(), null);
    h.undo(w); h.undo(w); h.undo(w);
    eq(w.readFloatState(), null, "回起点：无浮层");
    eq(doc.selection, selRef, "选区回来");
    const after = L.pixels.getRegion(0, 0, 100, 100);
    assert(origBytes.every((v, i) => v === after[i]), "像素回起点");
    h.redo(w); h.redo(w); h.redo(w);
    eq(w.readFloatState(), null, "回终点：已 accept");
    eq(L.sampleAt(35, 35)[3], 0, "洞在（bakeFn=null 未烤回）");
    eq(h.canRedo(), false);
  });

  it("redo 段截断释放 float tiles（disposeData）：undo lift 后另起一笔 → 包内浮层句柄清空", () => {
    const { doc, w, h, ops, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    const fsRef = w.readFloatState();
    assert(fsRef.floats[0].pixels.tileCount > 0);
    h.undo(w);                                  // 浮层 → lift 步的 redo 包
    eq(w.readFloatState(), null);
    assert(fsRef.floats[0].pixels.tileCount > 0, "还在包里，句柄活着");
    const before = L.snapshot();                // 另起一笔 → 截断 redo 段
    L.pixels.putRegion(5, 5, 1, 1, px(1, 1, 1, 255));
    h.run(w, ops.pixels, { layerId: L.id, _initialBefore: before });
    eq(fsRef.floats[0].pixels.tileCount, 0, "截断 → float tiles 已 dispose（无泄漏）");
  });

  it("clearHistory 语义（换文档）：workpiece.dropFloats 直接清 + 释放", () => {
    const { doc, w, h, ft } = mk();
    const L = doc.activeLayer;
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    ft.lift(L);
    const fsRef = w.readFloatState();
    h.clear();
    w.dropFloats();
    eq(w.readFloatState(), null);
    eq(fsRef.floats[0].pixels.tileCount, 0, "像素句柄已释放");
  });

  it("源层 lift 后被外力删掉：undo lift 走不可恢复协议（诚实弃栈，不炸）", () => {
    const { doc, w, h, ft, unrec } = mk();
    const L = doc.addLayer("受害者");
    paintRect(L, 20, 20, 40, 40);
    doc.selection = rectSel(30, 30, 16, 16);
    doc.setActiveById(L.id);
    ft.lift(L);
    doc.removeLayer(L.id); _orphans.push(L);    // 绕栈直接删（模拟腐坏；像素释放归 caller=本测试）
    eq(h.undo(w), false);
    eq(unrec(), 1, "layer gone → 不可恢复弃栈");
    assert(!flattenLeaves(doc.layers).some((x) => x.id === L.id), "不错删别的层");
  });
});

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
describe("float-ops 收尾", () => {
  it("清栈、收浮层并释放本文件的 doc tiles", () => {
    for (const { doc, w, h } of _ctxs) {
      h.clear();
      w.dropFloats();
      for (const leaf of flattenLeaves(doc.layers)) leaf.pixels?.dispose?.();
      doc.selection?.dispose?.();
    }
    for (const L of _orphans) L.pixels?.dispose?.();
    _ctxs.length = 0; _orphans.length = 0;
    assert(true, "disposed");
  });
});
