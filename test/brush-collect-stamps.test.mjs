// Stage 3：brush.collectStamps GPU stamp-list 出栈验收。
// 问题陈述：
//   - 复用 _walkStamps(手感间距)+_stampParams(压感/taper) → 与 CPU _emitFrozen 同源（手感一致）。
//   - 列表非空、在画布内、size/alpha 合理；shape 字段（buildup/color/椭圆 aspect/rotation）正确透传。
//   - pixelMode → null（caller 回退 CPU 直绘路径）。
import { describe, it, assert, eq } from "./runner.mjs";
const { BrushEngine } = await import("../src/brush.ts");
const { resolveBrush } = await import("../src/resolved-brush.ts");
const { PaintDoc } = await import("../src/doc.ts");

function drive(settings) {
  const doc = new PaintDoc({ width: 512, height: 512 });
  const eng = new BrushEngine();
  eng.beginStroke(doc.layers[0], settings, 50, 50, 1.0, "brush");
  eng.extendStroke(150, 60, 0.9);
  eng.extendStroke(250, 120, 0.7);
  eng.extendStroke(300, 200, 0.5);
  return eng;
}

describe("brush.collectStamps · GPU stamp-list 出栈", () => {
  it("圆形 wash：列表非空 + 在画布内 + size/alpha 合理 + shape 字段", () => {
    const s = resolveBrush({ size: 30, color: "#3399ee", hardness: 0.3, compositeMode: "wash", spacing: 0.1 });
    const r = drive(s).collectStamps();
    assert(r && r.stamps.length > 3, `应有多颗 stamp，实得 ${r ? r.stamps.length : "null"}`);
    for (const st of r.stamps) {
      assert(st.x >= 0 && st.x <= 512 && st.y >= 0 && st.y <= 512, `stamp 在画布内 ${st.x},${st.y}`);
      assert(st.size > 0 && st.alpha > 0 && st.alpha <= 1, `size/alpha 合理 ${st.size},${st.alpha}`);
    }
    eq(r.shape.buildup, false, "wash → buildup=false");
    eq(r.shape.color.length, 3, "color 3 分量");
    assert(r.shape.color[2] > 0.8 && r.shape.color[0] < 0.3, "color ≈ #3399ee 归一化(B 高 R 低)");
    eq(r.shape.aspect, 1, "圆 → aspect 1");
    eq(r.shape.rotation, 0, "圆 → rotation 0");
  });

  it("buildup + 椭圆笔形 → shape 标志/几何正确透传", () => {
    // preset.shape.rotation 是**度**（resolveBrush ×π/180）；compositeMode/形状走 preset。
    const s = resolveBrush({ size: 40, color: "#ff0000", preset: { shape: { kind: "ellipse", aspect: 2, rotation: 30 }, compositeMode: "buildup", spacing: 0.1 } });
    const r = drive(s).collectStamps();
    assert(r && r.stamps.length > 0, "有 stamp");
    eq(r.shape.buildup, true, "buildup=true");
    eq(r.shape.aspect, 2, "椭圆 aspect 透传");
    assert(Math.abs(r.shape.rotation - 30 * Math.PI / 180) < 1e-9, `椭圆 rotation 度→弧度，实得 ${r.shape.rotation}`);
    assert(r.shape.color[0] > 0.9, "color ≈ 红");
  });

  it("pixelMode → null（caller 回退 CPU 直绘）", () => {
    const s = resolveBrush({ size: 10, color: "#000000", preset: { pixelMode: true } });
    eq(drive(s).collectStamps(), null, "pixelMode → null");
  });
});
