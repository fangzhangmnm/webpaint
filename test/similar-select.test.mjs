// v0.7.21 同色全图内核（similarSelectFrom）+ 颜色度量（color-dist）验收。
// 语义锚：与 flood 同判据不同连通性——相似像素全 doc 入选；OKLab 度量感知均匀、α 独立通道、
// 容差拉满全放行（ΔE clamp 1）；flood 的 oklab 分支 barrier 语义与 rgb 分支同构。
import { describe, it, assert, eq } from "./runner.mjs";

const { floodSelectFrom, similarSelectFrom } = await import("../src/lasso.ts");
const { makeSeedDist } = await import("../src/color-dist.ts");

function fakeLayer(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) fill(i % w, (i / w) | 0, data, i * 4);
  return { bboxX: 0, bboxY: 0, bboxW: w, bboxH: h, getImageData: () => ({ data }) };
}
function count255(sel) {
  const g = sel.materializeMaskRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
  let n = 0; for (let i = 0; i < g.length; i++) if (g[i] === 255) n++;
  return n;
}

describe("similarSelectFrom · 同色全图（第三算法模式）", () => {
  it("非连通同色都入选：左右两条红带 + 中间蓝 → tap 左红选到两条", () => {
    const L = fakeLayer(8, 8, (x, _y, d, o) => {
      if (x < 2 || x >= 6) { d[o] = 255; d[o + 3] = 255; }          // 红带 ×2（不连通）
      else { d[o + 2] = 255; d[o + 3] = 255; }                       // 中间蓝
    });
    const sel = similarSelectFrom({ width: 8, height: 8 }, { x: 0, y: 0 }, L, 10, "rgb");
    assert(sel, "应有选区");
    eq(count255(sel), 32, "两条红带 32 px（蓝不入选）");
    eq(sel.bboxW, 8, "bbox 横跨全图（非连通）");
    sel.dispose();
    // 对照：flood 同参数只拿到连通的左带
    const fl = floodSelectFrom({ width: 8, height: 8 }, { x: 0, y: 0 }, L, 10, "rgb");
    eq(count255(fl), 16, "flood 只选连通左带");
    fl.dispose();
  });

  it("layer 外=透明：tap 透明区 → 全部透明像素入选（含 bbox 外语义对齐 flood）", () => {
    const L = { bboxX: 2, bboxY: 2, bboxW: 2, bboxH: 2, getImageData: () => {
      const data = new Uint8ClampedArray(2 * 2 * 4);
      for (let i = 0; i < 4; i++) { data[i * 4] = 255; data[i * 4 + 3] = 255; }   // 2×2 全红
      return { data };
    } };
    const sel = similarSelectFrom({ width: 6, height: 6 }, { x: 0, y: 0 }, L, 10, "oklab");
    eq(count255(sel), 32, "36 - 4 红 = 32 透明像素全入选");
    sel.dispose();
    eq(similarSelectFrom({ width: 6, height: 6 }, { x: 99, y: 0 }, L, 10, "oklab"), null, "出界 null");
  });

  it("OKLab 淡色分级：容差取在 淡淡之间<t<淡黑之间 → 只吞相近淡色", () => {
    const seed = [250, 235, 225], near = [245, 230, 235], black = [20, 20, 20];
    const dist = makeSeedDist("oklab", seed[0], seed[1], seed[2], 255);
    const dNear = dist(near[0], near[1], near[2], 255);
    const dBlack = dist(black[0], black[1], black[2], 255);
    assert(dNear < dBlack, "感知距离排序：近淡色 < 黑");
    const tPct = Math.min(100, Math.ceil(dNear * 100) + 1);
    assert(tPct / 100 < dBlack, "容差窗口存在（淡色差远小于对黑差）");
    const L = fakeLayer(6, 1, (x, _y, d, o) => {
      const c = x < 2 ? seed : x < 4 ? near : black;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    });
    const sel = similarSelectFrom({ width: 6, height: 1 }, { x: 0, y: 0 }, L, tPct, "oklab");
    eq(count255(sel), 4, "seed+near 入选，黑排除");
    sel.dispose();
    // t=0 → 只有逐字节相同的 seed 像素
    const s0 = similarSelectFrom({ width: 6, height: 1 }, { x: 0, y: 0 }, L, 0, "oklab");
    eq(count255(s0), 2, "容差 0 = 精确匹配");
    s0.dispose();
  });

  it("OKLab α 独立通道：同 RGB 半透明 vs 不透明在低容差下不同色", () => {
    const L = fakeLayer(4, 1, (x, _y, d, o) => { d[o] = 200; d[o + 3] = x < 2 ? 255 : 128; });
    const sel = similarSelectFrom({ width: 4, height: 1 }, { x: 0, y: 0 }, L, 10, "oklab");
    eq(count255(sel), 2, "α 差 127/255 ≈ 0.5 > 0.1 → 半透明排除");
    sel.dispose();
  });
});

describe("floodSelectFrom · oklab 度量分支", () => {
  it("红↔白是 barrier（t=20）；容差拉满全放行（ΔE clamp 1 不变量）", () => {
    const L = fakeLayer(8, 8, (x, _y, d, o) => {
      if (x < 4) { d[o] = 255; d[o + 3] = 255; }                       // 左红
      else { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255; }   // 右白
    });
    const sel = floodSelectFrom({ width: 8, height: 8 }, { x: 1, y: 1 }, L, 20, "oklab");
    eq(count255(sel), 32, "只选左半红");
    sel.dispose();
    const all = floodSelectFrom({ width: 8, height: 8 }, { x: 1, y: 1 }, L, 100, "oklab");
    eq(count255(all), 64, "容差 100 全放行（含极端色对）");
    all.dispose();
  });

  it("度量缺省 rgb：老签名（4 参）行为=v242 逐字语义", () => {
    const L = fakeLayer(4, 4, (x, _y, d, o) => { d[o + 3] = x * 40; });
    const sel = floodSelectFrom({ width: 4, height: 4 }, { x: 0, y: 0 }, L, 100);
    eq(count255(sel), 16, "阈值拉满全放行（回归锚）");
    sel.dispose();
  });
});

describe("floodSelectFrom · 选区当墙（v0.7.23，union 模式止漏）", () => {
  // 8×8 全同色层：不设墙 tap 任意点=全选；竖条墙（x=3..4）应把 flood 拦在左侧
  const uniform = () => fakeLayer(8, 8, (_x, _y, d, o) => { d[o] = 200; d[o + 3] = 255; });
  const wall = () => {
    const data = new Uint8Array(2 * 8).fill(255);   // x∈[3,4] 全高
    return { x: 3, y: 0, w: 2, h: 8, data };
  };

  it("墙拦截：同色一片但 flood 停在已选区（临时线语义）", () => {
    const sel = floodSelectFrom({ width: 8, height: 8 }, { x: 0, y: 0 }, uniform(), 10, "rgb", wall());
    eq(count255(sel), 24, "只选墙左 x0..2 三列");
    eq(sel.bboxW, 3, "bbox 止步于墙");
    sel.dispose();
    const noStop = floodSelectFrom({ width: 8, height: 8 }, { x: 0, y: 0 }, uniform(), 10, "rgb", null);
    eq(count255(noStop), 64, "不设墙 = 全选（对照）");
    noStop.dispose();
  });

  it("种子豁免：tap 点已在墙里 → 整面墙忽略（fill union 调容差后原地重 tap 不许哑）", () => {
    const sel = floodSelectFrom({ width: 8, height: 8 }, { x: 3, y: 4 }, uniform(), 10, "rgb", wall());
    eq(count255(sel), 64, "种子在墙内 → 按无墙 flood 全选");
    sel.dispose();
  });
});

describe("floodSelectFrom · 容隙（v0.7.24 EDT 受限 flood+回贴）", () => {
  // 12×8：x=5 竖墨线，y∈{3,4} 开 2px 缺口；其余全红
  const gapped = () => fakeLayer(12, 8, (x, y, d, o) => {
    if (x === 5 && y !== 3 && y !== 4) { d[o + 3] = 255; }            // 黑线（含 α 顶满）
    else { d[o] = 255; d[o + 3] = 255; }                              // 红底
  });

  it("容隙关：2px 缺口照漏（对照）", () => {
    const sel = floodSelectFrom({ width: 12, height: 8 }, { x: 1, y: 1 }, gapped(), 10, "rgb");
    eq(count255(sel), 90, "全部非墨线 96-6 漏光");
    sel.dispose();
  });

  it("容隙 4：缺口封住——线左全选+口部回贴，右侧零像素", () => {
    const sel = floodSelectFrom({ width: 12, height: 8 }, { x: 1, y: 1 }, gapped(), 10, "rgb", null, 4);
    const g = sel.materializeMaskRegion(0, 0, 12, 8);
    for (let y = 0; y < 8; y++) for (let x = 6; x < 12; x++) eq(g[y * 12 + x], 0, `右侧 (${x},${y}) 不入选`);
    eq(count255(sel), 42, "左 5 列 40 + 缺口内 (5,3)(5,4) 回贴 2");
    sel.dispose();
  });

  it("贴线 tap 不哑（v71 教训）：种子在窄边 → 口袋接种，结果同开阔 tap", () => {
    const sel = floodSelectFrom({ width: 12, height: 8 }, { x: 4, y: 1 }, gapped(), 10, "rgb", null, 4);
    eq(count255(sel), 42, "贴线 tap 与开阔 tap 同结果");
    sel.dispose();
  });

  it("窄走廊 tap：r 步内摸不到开阔区 → 诚实降级普通 flood（不吞 tap、不越墙）", () => {
    // 两条竖线 x=4/x=7 夹出 2 宽走廊，tap 走廊内，gap=6（r=3 > 走廊半宽）
    const corridor = fakeLayer(12, 8, (x, _y, d, o) => {
      if (x === 4 || x === 7) { d[o + 3] = 255; }
      else { d[o] = 255; d[o + 3] = 255; }
    });
    const sel = floodSelectFrom({ width: 12, height: 8 }, { x: 5, y: 4 }, corridor, 10, "rgb", null, 6);
    eq(count255(sel), 16, "降级 flood 困在走廊 2×8");
    sel.dispose();
  });
});
