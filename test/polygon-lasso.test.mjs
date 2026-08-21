// 多边形套索（v0.6.19）：整数扫描线栅格器 + LassoEngine 会话两级 abort。
// 问题陈述：
//   - 栅格器：像素中心 even-odd、半开区间平局、0/255 硬边；共线/不足三点 → null。
//   - 会话：顶点=会话级（cancelDrawing 不清——双指/掌触只 abort 笔级）；
//     polygonCancelSession/setSubTool/闭合 才清；闭合走 setOp 合并出 history entry。
import { describe, it, assert, eq } from "./runner.mjs";
const { rasterizePolygonGray8, Selection } = await import("../src/backend/selection.ts");
const { LassoEngine } = await import("../src/lasso.ts");

describe("polygon · rasterizePolygonGray8", () => {
  it("轴对齐正方形 (2,2)-(6,6)：恰好 4×4=16 像素，锁格点硬边", () => {
    const r = rasterizePolygonGray8([{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }]);
    assert(r);
    eq(r.x0, 2); eq(r.y0, 2); eq(r.w, 4); eq(r.h, 4);
    let n = 0;
    for (const v of r.g) { assert(v === 0 || v === 255, "硬边 0/255"); if (v === 255) n++; }
    eq(n, 16, "边缘像素不多不少（半开区间：右/下边界不含）");
  });
  it("凹 L 形：凹口像素不入选", () => {
    // L: (0,0)-(6,0)-(6,3)-(3,3)-(3,6)-(0,6) —— 右下 3×3 是凹口
    const r = rasterizePolygonGray8([
      { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 6 }, { x: 0, y: 6 }]);
    assert(r);
    const at = (x, y) => r.g[(y - r.y0) * r.w + (x - r.x0)];
    eq(at(1, 1), 255, "主体在");
    eq(at(4, 1), 255, "上横臂在");
    eq(at(1, 4), 255, "左竖臂在");
    eq(at(4, 4), 0, "凹口空");
    eq(at(5, 5), 0, "凹口空");
  });
  it("不足三点 / 共线零面积 → null", () => {
    eq(rasterizePolygonGray8([{ x: 0, y: 0 }, { x: 5, y: 5 }]), null);
    eq(rasterizePolygonGray8([{ x: 0, y: 3 }, { x: 4, y: 3 }, { x: 8, y: 3 }]), null);
  });
  it("三角形：像素全在 bbox 内且非空", () => {
    const r = rasterizePolygonGray8([{ x: 0, y: 0 }, { x: 9, y: 1 }, { x: 2, y: 8 }]);
    assert(r);
    let n = 0; for (const v of r.g) if (v === 255) n++;
    assert(n > 5 && n < r.w * r.h, `内点数合理: ${n}`);
  });
});

describe("polygon · LassoEngine 会话（abortStroke ≠ abortSession）", () => {
  const mkEng = () => {
    const eng = new LassoEngine();
    eng.setDoc({ width: 64, height: 64, selection: null });
    eng.setSubTool("polygon");
    return eng;
  };
  // 收尾释放（Selection 所有权纪律 selection.ts:12-15）：entry.before 随 entry 走、after 归
  // doc.selection 槽——本测试的假 doc/entry 没有下游持有者，测试自己就是终点，必须 dispose
  // （曾漏：run.mjs 泄漏门=exit 噪音年久失聪，v0.10.9 升级成红灯后此处补账）。
  const flushSel = (eng, ...entries) => {
    for (const e of entries) if (e?.before && !e.before.disposed) e.before.dispose();
    const s = eng.doc?.selection;
    if (s && !s.disposed) { s.dispose(); eng.doc.selection = null; }
  };
  it("逐点落顶点 → 闭合 → 选区 mask 正确 + history entry", () => {
    const eng = mkEng();
    eng.polygonAddVertex(10.4, 10.2);   // round 锁格点 → (10,10)
    eng.polygonAddVertex(20, 10);
    eng.polygonAddVertex(20, 20);
    eng.polygonAddVertex(10, 20);
    eq(eng.polygonVertexCount(), 4);
    const entry = eng.polygonClose();
    assert(entry && entry.type === "selectionChange", "闭合产出 entry");
    const sel = eng.doc.selection;
    assert(sel, "doc.selection 已设");
    eq(sel.bboxW, 10); eq(sel.bboxH, 10);
    eq(eng.polygonSessionActive(), false, "会话已收摊");
    eq(eng.getDrawingPath(), null, "预览线已消");
    flushSel(eng, entry);
  });
  it("cancelDrawing（双指/掌触路径）只丢段预览，顶点保留", () => {
    const eng = mkEng();
    eng.polygonAddVertex(5, 5);
    eng.polygonAddVertex(30, 5);
    eng.beginPath(40, 30);          // 第三笔进行中（段预览）
    eng.extendPath(42, 32);
    eng.cancelDrawing();            // 双指手势 abort 这一笔
    eq(eng.polygonVertexCount(), 2, "会话顶点没被杀");
    assert(eng.polygonSessionActive(), "会话仍活");
    eng.polygonAddVertex(40, 30);
    eq(eng.polygonVertexCount(), 3, "继续落点无碍");
  });
  it("polygonCancelSession（Esc/切工具/换文档）清干净", () => {
    const eng = mkEng();
    eng.polygonAddVertex(5, 5);
    eng.polygonAddVertex(30, 5);
    eng.polygonCancelSession();
    eq(eng.polygonVertexCount(), 0);
    eq(eng.polygonSessionActive(), false);
    eq(eng.state(), "idle");
  });
  it("切子工具 = 会话级 abort；连续重复顶点去重；<3 顶点闭合 → null", () => {
    const eng = mkEng();
    eng.polygonAddVertex(5, 5);
    eng.polygonAddVertex(5.2, 4.9);   // round 后与上一个重复 → 去重
    eq(eng.polygonVertexCount(), 1);
    eng.setSubTool("freehand");
    eng.setSubTool("polygon");
    eq(eng.polygonVertexCount(), 0, "切子工具清会话");
    eng.polygonAddVertex(1, 1);
    eng.polygonAddVertex(9, 1);
    eq(eng.polygonClose(), null, "两点闭合无效");
    eq(eng.doc.selection, null);
  });
  it("setOp=subtract：闭合从现有选区挖洞", () => {
    const eng = mkEng();
    const entry0 = eng.setSelection(Selection.full(30, 30, 0, 0));
    assert(entry0);
    eng.setSetOpMode("subtract");
    eng.polygonAddVertex(10, 10);
    eng.polygonAddVertex(20, 10);
    eng.polygonAddVertex(20, 20);
    eng.polygonAddVertex(10, 20);
    const entry = eng.polygonClose();
    assert(entry, "subtract 出 entry");
    const sel = eng.doc.selection;
    assert(sel, "还有剩余选区");
    eq(sel.sampleAt(15, 15), 0, "洞挖掉了");
    assert(sel.sampleAt(5, 5) > 0, "外围还在");
    flushSel(eng, entry0, entry);
  });
});
