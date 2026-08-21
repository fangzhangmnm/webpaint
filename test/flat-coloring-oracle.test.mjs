// 线稿 oracle 接缝（flat-coloring-oracle.ts）验收：tap→Selection 同构、按 contentRev 缓存/失效。
// fake layer 走 OracleSourceLayer 结构面（≈ floodSelectFrom 的 mock 风格），node 直测无 DOM。
import { describe, it, assert, eq } from "./runner.mjs";

const { FlatColoringOracle } = await import("../src/flat-coloring-oracle.ts");

/** 断口圆线稿 RGBA（黑线白透明底），断口朝 +x ~6px */
function gapRingRgba(w, h, cx, cy, r, thick, gapHalf) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy;
    if (Math.abs(Math.hypot(dx, dy) - r) > thick / 2) continue;
    let da = Math.atan2(dy, dx);
    if (Math.abs(da) <= gapHalf) continue;
    rgba[(y * w + x) * 4 + 3] = 255;   // 不透明黑
  }
  return rgba;
}
function fakeLayer(rgba, w, h) {
  return {
    id: 7, contentRev: 0, calls: 0,
    getImageData(x, y, gw, gh) {
      this.calls++;
      if (x !== 0 || y !== 0 || gw !== w || gh !== h) throw new Error("oracle 应读整 doc");
      return { data: rgba };
    },
  };
}
function count255(sel) {
  const g = sel.materializeMaskRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
  let n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === 255) n++;
  return n;
}

describe("flat-coloring-oracle · tap→Selection + contentRev 缓存", () => {
  const w = 64, h = 64;
  const doc = { width: w, height: h };

  it("断口圆内 tap → 有界选区（闭合生效），且吃进线下", () => {
    const L = fakeLayer(gapRingRgba(w, h, 32, 32, 20, 3, 3 / 20), w, h);
    const o = new FlatColoringOracle();
    const sel = o.selectAt(doc, L, 32, 32);
    assert(sel, "应有选区");
    const n = count255(sel);
    assert(n > 800 && n < 1800, `圆内区 ≈ π·20²·部分线下（实得 ${n}）`);
    assert(sel.bboxW < w, "有界，不是整图");
    sel.dispose();
  });

  it("缓存：同层再 tap 不重建；contentRev bump 后重建", () => {
    const L = fakeLayer(gapRingRgba(w, h, 32, 32, 20, 3, 3 / 20), w, h);
    const o = new FlatColoringOracle();
    eq(o.isReady(doc, L), false, "建前未就绪");
    o.selectAt(doc, L, 32, 32).dispose();
    eq(L.calls, 1, "首 tap 读一次像素");
    eq(o.isReady(doc, L), true, "建后就绪");
    const outside = o.selectAt(doc, L, 2, 2);
    eq(L.calls, 1, "第二 tap 走缓存");
    assert(outside && count255(outside) > w * h * 0.4, "外部区大片");
    outside.dispose();
    L.contentRev++;
    eq(o.isReady(doc, L), false, "rev 变 → 失效");
    o.selectAt(doc, L, 32, 32).dispose();
    eq(L.calls, 2, "rev 变 → 重建");
    o.invalidate();
    o.selectAt(doc, L, 32, 32).dispose();
    eq(L.calls, 3, "显式 invalidate → 重建");
  });

  it("空源层：整图一区（对齐 flood 点透明全选的语义）", () => {
    const o = new FlatColoringOracle();
    const sel = o.selectAt(doc, null, 5, 5);
    assert(sel, "应有选区");
    eq(count255(sel), w * h, "全图");
    sel.dispose();
  });

  it("出界 tap → null", () => {
    const o = new FlatColoringOracle();
    eq(o.selectAt(doc, null, -1, 5), null, "出界 null");
  });

  it("knob（v0.7.2 扳手）：变值丢缓存重建，同值 no-op", () => {
    const L = fakeLayer(gapRingRgba(w, h, 32, 32, 20, 3, 3 / 20), w, h);
    const o = new FlatColoringOracle();
    o.selectAt(doc, L, 32, 32).dispose();
    eq(L.calls, 1, "建一次");
    o.setCloseDist(64);   // = 默认值
    eq(o.isReady(doc, L), true, "同值不失效");
    o.setCloseDist(128);
    eq(o.isReady(doc, L), false, "闭合距离变 → 失效");
    o.selectAt(doc, L, 32, 32).dispose();
    eq(L.calls, 2, "重建");
    eq(o.getCloseDist(), 128, "读回新值");
    o.setInkThreshold(-1);   // = 默认（v0.10.11 起动态档）
    eq(o.isReady(doc, L), true, "同值不失效");
    o.setInkThreshold(80);
    eq(o.isReady(doc, L), false, "墨线判定变 → 失效");
    eq(o.getInkThreshold(), 80, "读回新值");
    o.setCloseDist(999);
    eq(o.getCloseDist(), 256, "clamp 上限 256");
  });

  it("knob（v0.7.4）：碎区下限/端点灵敏度失效逻辑 + 调试数据只在缓存就绪时给", () => {
    const L = fakeLayer(gapRingRgba(w, h, 32, 32, 20, 3, 3 / 20), w, h);
    const o = new FlatColoringOracle();
    eq(o.debugInfo(doc, L), null, "未建缓存 → 无调试数据（渲染路径不触发重建）");
    o.selectAt(doc, L, 32, 32).dispose();
    const dbg = o.debugInfo(doc, L);
    assert(dbg && dbg.keypoints.length >= 2 && dbg.bridges.some((b) => b.ok), "就绪后给端点+桥");
    o.setMinRegion(32);   // = 默认
    eq(o.isReady(doc, L), true, "同值不失效");
    o.setMinRegion(0);
    eq(o.isReady(doc, L), false, "碎区下限变 → 失效");
    eq(o.getMinRegion(), 0, "0 = 关守卫");
    o.selectAt(doc, L, 32, 32).dispose();
    o.setTipSensitivity(25);   // = 默认
    eq(o.isReady(doc, L), true, "同值不失效");
    o.setTipSensitivity(80);
    eq(o.isReady(doc, L), false, "灵敏度变 → 失效");
    eq(o.getTipSensitivity(), 80, "读回新值");
  });

  it("蔓延距离（v0.7.17）：query-time 参数不作废缓存，选区随之收缩", () => {
    const L = fakeLayer(gapRingRgba(w, h, 32, 32, 20, 3, 3 / 20), w, h);
    const o = new FlatColoringOracle();
    const selAuto = o.selectAt(doc, L, 32, 32);
    const nAuto = count255(selAuto);
    selAuto.dispose();
    o.setBleed(0);
    eq(o.isReady(doc, L), true, "拨蔓延不丢缓存");
    const sel0 = o.selectAt(doc, L, 32, 32);
    eq(L.calls, 2, "分区未重建，但懒补墨深多读一次像素（v0.7.19）");
    eq(o.isReady(doc, L), true, "仍是同一份缓存分区");
    const n0 = count255(sel0);
    sel0.dispose();
    assert(n0 < nAuto, `bleed=0 选区应更小（${n0} < ${nAuto}）`);
    o.selectAt(doc, L, 2, 2).dispose();
    eq(L.calls, 2, "墨深已挂缓存，后续 bleed 查询零读");
    eq(o.getBleed(), 0, "读回");
    o.setBleed(-5);
    eq(o.getBleed(), -1, "clamp 下限 -1（自动）");
  });
});

describe("flat-coloring-oracle · 动态墨线判定（v0.10.11）", () => {
  const w = 64, h = 64;
  const doc = { width: w, height: h };
  /** 淡粉线（白底亮度 ≈190）3px 厚闭合方框，透明底——旧默认手动 50% 下全图漏成一区 */
  function lightBoxRgba() {
    const rgba = new Uint8ClampedArray(w * h * 4);
    const put = (x, y) => {
      const o = (y * w + x) * 4;
      rgba[o] = 230; rgba[o + 1] = 180; rgba[o + 2] = 180; rgba[o + 3] = 255;
    };
    for (let x = 8; x <= 55; x++) for (let t = 0; t < 3; t++) { put(x, 8 + t); put(x, 53 + t); }
    for (let y = 8; y <= 55; y++) for (let t = 0; t < 3; t++) { put(8 + t, y); put(53 + t, y); }
    return rgba;
  }
  it("默认动态档：淡线稿 tap 内 → 有界选区（不再全图）；稀疏源无稠密提示", () => {
    const L = fakeLayer(lightBoxRgba(), w, h);
    const o = new FlatColoringOracle();
    eq(o.getInkThreshold(), -1, "默认 -1 = 动态");
    const sel = o.selectAt(doc, L, 32, 32);
    assert(sel, "应有选区");
    assert(sel.bboxW < w && sel.bboxH < h, `有界不是整图（实得 ${sel.bboxW}×${sel.bboxH}）`);
    sel.dispose();
    eq(o.takeDenseSourceHint(), false, "稀疏源（alpha 档）不提示");
  });
  it("手动档设回 50：同一淡线稿全图漏（对照）；-1 恢复动态", () => {
    const L = fakeLayer(lightBoxRgba(), w, h);
    const o = new FlatColoringOracle();
    o.setInkThreshold(50);
    eq(o.getInkThreshold(), 50, "手动读回");
    const sel = o.selectAt(doc, L, 32, 32);
    assert(sel && sel.bboxW === w && sel.bboxH === h, "手动 50% 看不见淡线 → 整图一区（事故重演）");
    sel.dispose();
    o.setInkThreshold(-1);
    eq(o.getInkThreshold(), -1, "拨回动态");
    eq(o.isReady(doc, L), false, "换档丢缓存");
  });
  it("稠密源（不透明白底）→ 提示一次、读走即清、缓存命中不再置位", () => {
    const rgba = lightBoxRgba();
    // 压成不透明白底 + 深灰线（覆盖率 100% → Otsu 档）
    for (let i = 0; i < w * h; i++) {
      const o4 = i * 4;
      if (rgba[o4 + 3] === 0) { rgba[o4] = 255; rgba[o4 + 1] = 255; rgba[o4 + 2] = 255; }
      else { rgba[o4] = 40; rgba[o4 + 1] = 40; rgba[o4 + 2] = 40; }
      rgba[o4 + 3] = 255;
    }
    const L = fakeLayer(rgba, w, h);
    const o = new FlatColoringOracle();
    const sel = o.selectAt(doc, L, 32, 32);
    assert(sel && sel.bboxW < w, "Otsu 档抓住深线 → 有界选区");
    sel.dispose();
    eq(o.takeDenseSourceHint(), true, "稠密源置位");
    eq(o.takeDenseSourceHint(), false, "读走即清");
    o.selectAt(doc, L, 2, 2).dispose();
    eq(o.takeDenseSourceHint(), false, "缓存命中不重建 → 不再置位");
  });
  it("bleed=0 像素画模式与动态档同源二值化：alpha 档下淡线一个不碰", () => {
    const L = fakeLayer(lightBoxRgba(), w, h);
    const o = new FlatColoringOracle();
    o.setBleed(0);
    const sel = o.selectAt(doc, L, 32, 32);
    assert(sel, "应有选区");
    // 方框线体 8..10 / 53..55；mask 不吃线 → tight bbox 落在纯内部 11..52
    assert(sel.bboxX >= 11 && sel.bboxY >= 11 &&
      sel.bboxX + sel.bboxW - 1 <= 52 && sel.bboxY + sel.bboxH - 1 <= 52,
      `墨深按 alpha 同源二值化，淡线不被蔓延吃到（实得 bbox ${sel.bboxX},${sel.bboxY} ${sel.bboxW}×${sel.bboxH}）`);
    sel.dispose();
  });
});
