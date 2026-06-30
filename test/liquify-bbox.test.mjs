// 液化写区/dispField 不再被「现有内容 bbox」截断 —— tile-era degeneration 修。
// 问题陈述（真机报：液化拉到 bbox 边缘后被截断）：
//   canvas 时代 layer.ensureBbox(footprint) 会把图层画布扩大 → 写区/dispField 跟 footprint 走，推出旧内容
//   边的像素能落地。tiling 迁移（513f01f）把 ensureBbox 改成 no-op、layer.bbox 变「现有内容」包围盒、扩不动，
//   但液化仍按 layer.bbox 夹写区 → footprint 超出旧内容的部分被截。
// 修：footprint 夹到 **doc 边界**（非 layer.bbox），dispField 用 _growDispField 跟 footprint 长（tile
//   putImageData 按需分配 tile，写哪都行）。
// node dom-shim 的 canvas 是 no-op（无真像素）→ 不能做像素断言；改测「工作区是否长到 footprint」这一根因。
import { describe, it, assert, eq } from "./runner.mjs";
const { PaintDoc } = await import("../src/doc.ts");
const { LiquifyEngine } = await import("../src/plugins/liquify-engine.ts");

describe("liquify · 写区不再被 content bbox 截断 (tile-era 修)", () => {
  it("空层 push：dispField 长到 footprint（旧码 content bbox=0 会早退、什么都不长）", () => {
    const doc = new PaintDoc({ width: 64, height: 64 });
    const eng = new LiquifyEngine();
    // size=R(液化 R=size)。footprint = cx±30。空层 content bbox=0 → 旧码在此早退。
    eng.beginStroke(doc.layers[0], { size: 30, strength: 1, mode: "push", bleed: "edge" }, 10, 10, null);
    eng.extendStroke(45, 10);
    const f = eng._stroke.dispField;
    // cx=45,R=30 → 右边界 75 夹到 doc 64；dispField 应长到 ~64（远超旧码的 content=0 → 1×1）
    assert(f.bboxX + f.bboxW >= 40, `dispField 右边界应达 footprint，实得 ${f.bboxX + f.bboxW}`);
    assert(f.bboxX + f.bboxW <= 64 && f.bboxX >= 0, `dispField 夹在 doc 内，实得 [${f.bboxX},${f.bboxX + f.bboxW}]`);
    assert(f.bboxY >= 0 && f.bboxY + f.bboxH <= 64, `dispField y 夹在 doc 内，实得 [${f.bboxY},${f.bboxY + f.bboxH}]`);
  });

  it("_growDispField：只扩不缩 + 已累积位移随原坐标平移保留", () => {
    const eng = new LiquifyEngine();
    eng._stroke = { dispField: { bboxX: 10, bboxY: 10, bboxW: 4, bboxH: 4, data: new Float32Array(2 * 4 * 4) } };
    eng._stroke.dispField.data[0] = 7;          // 原 (10,10) 的 dx=7
    eng._stroke.dispField.data[1] = -3;         // 原 (10,10) 的 dy=-3
    eng._growDispField(5, 5, 30, 30);           // 向四周扩
    const f = eng._stroke.dispField;
    eq(f.bboxX, 5, "左扩到 5");
    eq(f.bboxY, 5, "上扩到 5");
    eq(f.bboxX + f.bboxW, 30, "右扩到 30");
    eq(f.bboxY + f.bboxH, 30, "下扩到 30");
    const nw = f.bboxW;
    const idx = ((10 - 5) * nw + (10 - 5)) * 2;  // 原 (10,10) → 新场 (5,5)
    eq(f.data[idx], 7, "dx 平移后保留");
    eq(f.data[idx + 1], -3, "dy 平移后保留");
  });

  it("_growDispField：被包含的矩形 → 不变（不缩）", () => {
    const eng = new LiquifyEngine();
    eng._stroke = { dispField: { bboxX: 0, bboxY: 0, bboxW: 20, bboxH: 20, data: new Float32Array(2 * 20 * 20) } };
    const before = eng._stroke.dispField;
    eng._growDispField(5, 5, 10, 10);            // 完全在内 → no-op
    assert(eng._stroke.dispField === before, "包含矩形不应重建 dispField");
  });
});
