// C5 · StrokeSession（stroke 档口，提案 §6.1「累积真改」）行为锚。
// 问题陈述：
//   - 一次手势 = 一个 session = 一个令牌 = 一步 undo；cancel 无痕；no-op 不占步。
//   - 单令牌墙接口化身：上一个 session 未收口时第二个 begin 必须响亮拒绝（throw）。
//   - finalize：pixel 笔带选区 → 抬笔选区外回滚到笔前（applyMaskPostStroke 兜底）。
//   - PressureLPF（backend 手感数学）：事件钟决定论——dt 来自事件 t 差，无 t 走 FALLBACK 16ms，
//     同一 (p,t) 序列恒同输出（壁钟已拔除，ADR-0009）。
import { describe, it, assert, eq } from "./runner.mjs";
import { UndoStack } from "../src/backend/workpiece/undo-stack.ts";
import { PaintingWorkpiece } from "../src/backend/workpiece/painting-workpiece.ts";
import { PaintingView } from "../src/backend/workpiece/painting-view.ts";
import { StrokeSession } from "../src/stroke-session.ts";
import { PressureLPF } from "../src/backend/stroke-smoother.ts";
const { BrushEngine } = await import("../src/brush.ts");
const { resolveBrush } = await import("../src/resolved-brush.ts");
const { Selection } = await import("../src/backend/selection.ts");

// 测试卫生：工件收集起来文件末尾统一释放（防 tile-pool FR 泄漏 assert 刷屏；非产品泄漏）。
const _rigs = [];
function rig() {
  const undo = new UndoStack({ maxQuotaBytes: 1 << 30 });
  const wp2 = new PaintingWorkpiece({ undo, tree: { width: 64, height: 64 }, onTokenLeak: () => {} });
  const doc = new PaintingView(wp2);
  const r = { undo, wp2, doc, layer: doc.layers[0], committed: [], gpuCommit: false, selection: null, shadow: null };
  // 注入面 = input._strokeDeps 同形（commitStamps/invalidate/setShadow 换 fake——GPU/board 不在 node）
  r.deps = {
    begin: (label) => wp2.begin(label),
    tokenChanged: (id) => wp2.layerTiles.tokenChanged(id),
    tokenBeforeImage: (id) => wp2.layerTiles.tokenBeforeImage(id),
    getSelection: () => r.selection,
    commitStamps: (cs) => { r.committed.push(cs); return r.gpuCommit; },
    invalidate: () => {},
    setShadow: (layerId, pixels) => { r.shadow = (layerId != null && pixels) ? { layerId, pixels } : null; },
  };
  _rigs.push(r);
  return r;
}
const SPEC = { historyType: "stroke", finalize: true };
// 像素笔：描边中 in-place 写真层（editRegionBytes）→ collector 写时扣押，node 全程真像素
const pixelBrush = () => resolveBrush({ size: 4, color: "#ff0000", spacing: 0.5, preset: { pixelMode: true } });

describe("stroke-session · 事务生命周期（一笔=一令牌=一步）", () => {
  it("pixel 笔一笔 = 一步 undo；undo 还原像素", () => {
    const r = rig();
    const eng = new BrushEngine();
    const s = new StrokeSession(r.deps, eng, r.layer, SPEC, "livesync");
    eng.beginStroke(r.layer, pixelBrush(), 8, 8, 1.0, "brush");
    s.extend(30, 8, 1.0, null);
    assert(r.layer.sampleAt(8, 8)[3] > 0, "描边中像素已就地落层");
    const d0 = r.undo.depth();
    s.end();
    eq(r.undo.depth(), d0 + 1, "抬笔一步入栈");
    eq(s.open, false, "session 已收口");
    r.undo.undo();
    eq(r.layer.sampleAt(8, 8)[3], 0, "undo 还原到笔前（空白）");
    r.undo.redo();
    assert(r.layer.sampleAt(8, 8)[3] > 0, "redo 重演");
  });

  it("cancel 无痕：像素回滚 + 不占步（interrupt=cancel 家规）", () => {
    const r = rig();
    const eng = new BrushEngine();
    const s = new StrokeSession(r.deps, eng, r.layer, SPEC, "livesync");
    eng.beginStroke(r.layer, pixelBrush(), 8, 8, 1.0, "brush");
    s.extend(30, 8, 1.0, null);
    assert(r.layer.sampleAt(8, 8)[3] > 0, "描边中像素已落");
    const d0 = r.undo.depth();
    s.cancel();
    eq(r.layer.sampleAt(8, 8)[3], 0, "cancel 回滚无痕");
    eq(r.undo.depth(), d0, "不占 undo 步");
  });

  it("单令牌墙：上一 session 未收口 → 第二个 begin 响亮拒绝（throw），收口后放行", () => {
    const r = rig();
    const engA = new BrushEngine();
    const sA = new StrokeSession(r.deps, engA, r.layer, SPEC, "livesync");
    engA.beginStroke(r.layer, pixelBrush(), 8, 8, 1.0, "brush");
    let threw = false;
    try { new StrokeSession(r.deps, new BrushEngine(), r.layer, SPEC, "livesync"); } catch { threw = true; }
    assert(threw, "开着期间第二个 begin 必须 throw（不排队不静默）");
    sA.cancel();
    const sB = new StrokeSession(r.deps, new BrushEngine(), r.layer, SPEC, "livesync");   // 收口后可再开
    sB.cancel();
    assert(true, "cancel 后新 begin 放行");
  });

  it("buffered 笔：stamps 交 GPU commit（shader 已裁选区 → 不走 finalize）；无 substrate 写不占步", () => {
    const r = rig();
    r.gpuCommit = true;   // 假 GPU：报告「已 commit + 选区已裁」
    r.selection = Selection.fromGray8Region(0, 0, 32, 64, new Uint8Array(32 * 64).fill(255));
    const eng = new BrushEngine();
    const s = new StrokeSession(r.deps, eng, r.layer, SPEC, "overlay");
    eng.beginStroke(r.layer, resolveBrush({ size: 8, color: "#3399ee", spacing: 0.5 }), 8, 8, 1.0, "brush");
    s.extend(30, 8, 1.0, null);
    s.extend(50, 8, 1.0, null);
    const d0 = r.undo.depth();
    s.end();
    eq(r.committed.length, 1, "StampCollect 交给了 commitStamps");
    assert(r.committed[0].stamps.length > 0, "stamps 非空");
    eq(r.undo.depth(), d0, "fake GPU 未写 substrate → collector 空 → no-op 不占步");
  });

  it("finalize：pixel 笔带选区 → 抬笔选区外回滚到笔前（CPU 兜底）", () => {
    const r = rig();
    r.selection = Selection.fromGray8Region(0, 0, 32, 64, new Uint8Array(32 * 64).fill(255));   // 左半
    const eng = new BrushEngine();
    const s = new StrokeSession(r.deps, eng, r.layer, SPEC, "livesync");
    eng.beginStroke(r.layer, pixelBrush(), 8, 8, 1.0, "brush");
    s.extend(56, 8, 1.0, null);   // 横穿选区边界（x=32）
    assert(r.layer.sampleAt(50, 8)[3] > 0, "描边中选区外也落了（pixel 无 live 裁剪）");
    s.end();
    assert(r.layer.sampleAt(8, 8)[3] > 0, "选区内保留");
    eq(r.layer.sampleAt(50, 8)[3], 0, "选区外被 finalize 回滚");
    r.undo.undo();
    eq(r.layer.sampleAt(8, 8)[3], 0, "undo 整笔还原（finalize 回写在同一令牌内）");
  });

  it("收尾：释放本文件的工件资源", () => {
    for (const { undo, wp2 } of _rigs) {
      undo.clear();
      wp2.load({ width: 4, height: 4, nodes: [{ name: "空", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixels: null }] });
    }
    _rigs.length = 0;
    assert(true, "disposed");
  });
});

describe("stroke-session · PressureLPF（事件钟，backend 手感数学）", () => {
  it("τ=0 直传 raw", () => {
    const lpf = new PressureLPF(0, 0.3, 0);
    eq(lpf.step(0.9, 10), 0.9);
    eq(lpf.step(0.1, 20), 0.1);
  });

  it("一阶 IIR：α = dt/(dt+τ)，dt 来自事件 t 差", () => {
    const lpf = new PressureLPF(100, 0, 0);
    eq(lpf.step(1, 100), 0.5, "dt=100,τ=100 → α=0.5");
    eq(lpf.step(1, 200), 0.75, "再走 100ms → 0.75");
  });

  it("无 t（形状笔合成/直喂）→ FALLBACK_DT=16 兜底；混喂后首个带 t 也走兜底（无锚不猜 dt）", () => {
    const a = 16 / (16 + 100);
    const lpf = new PressureLPF(100, 0, null);
    assert(Math.abs(lpf.step(1, null) - a) < 1e-12, "t=null → dt=16");
    const lpf2 = new PressureLPF(100, 0, null);
    assert(Math.abs(lpf2.step(1, 500) - a) < 1e-12, "lastT 无锚 → 同兜底，不吃绝对时间");
  });

  it("决定论：同一 (p,t) 序列恒同输出（壁钟已拔除）", () => {
    const seq = [[0.8, 8], [0.6, 24], [0.9, 31], [0.4, 47]];
    const run = () => { const l = new PressureLPF(50, 1, 0); return seq.map(([p, t]) => l.step(p, t)); };
    const A = run(); const B = run();
    for (let i = 0; i < A.length; i++) eq(A[i], B[i], `第 ${i} 步逐位一致`);
    assert(A[3] > 0.4 && A[3] < 1, "收敛方向合理");
  });
});
