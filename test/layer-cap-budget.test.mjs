// v339 动态字节预算图层上限验收。
// 问题陈述：
//   - 旧 cap = 悲观 per-layer×分辨率（2K 卡 11 层，即使层只画一角）。
//   - 新 cap = 动态总驻留字节预算：预算内 → 放硬顶(64)；驻留达预算 → 冻结当前层数(≥2)。
//   - 模式档：countMat=false（GL，单份 tile 计费）/ true（2D，tile+物化 canvas 双份，保守）。
import { describe, it, assert, eq } from "./runner.mjs";
const { PaintDoc } = await import("../src/doc.ts");

const TILE = 256 * 256 * 4;   // 一 tile 字节
function fillFull(L, w, h) {
  L.putImageData(0, 0, { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
}

describe("doc.maxLayers · 动态字节预算", () => {
  it("预算内（空层稀疏）→ 放到硬顶 64", () => {
    const d = new PaintDoc({ width: 512, height: 512 });
    d.configureMemory(10 * 1e6, false);   // 10MB 预算，空层 resident≈0
    eq(d.maxLayers, 64, "预算内 → HARD_CEIL=64");
  });

  it("驻留达预算 → 冻结在当前层数（防 OOM；floor 2）", () => {
    const d = new PaintDoc({ width: 512, height: 512 });
    d.addLayer(); d.addLayer();            // 共 3 层（空 → 默认大预算下可加）
    d.configureMemory(3 * TILE, false);   // 预算 = 3 tile
    fillFull(d.layers[0], 512, 512);      // 512² = 2×2 = 4 tile ≥ 3 → 达预算
    eq(d.maxLayers, 3, "达预算 → 冻结在当前(3)，非硬顶 64");
  });

  it("稀疏层（只画一角）远不达预算 → 仍放硬顶（破 11 的真赢）", () => {
    const d = new PaintDoc({ width: 4096, height: 4096 });   // 16×16=256 tile/满层（旧公式 cap 极小）
    d.configureMemory(20 * TILE, false);                     // 20 tile 预算
    // 画一角 1 tile
    d.layers[0].putImageData(0, 0, { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(255) });
    eq(d.maxLayers, 64, "稀疏内容 << 预算 → 硬顶（旧悲观公式会卡到个位数）");
  });

  it("countMat=true 把物化 canvas 计入（2D 模式更保守）", () => {
    const d = new PaintDoc({ width: 512, height: 512 });
    fillFull(d.layers[0], 512, 512);      // tile = 4 tile = 1MB
    void d.layers[0].canvas;              // 触发物化 _mat（紧框 512² ≈ 1MB）
    const tileBytes = 4 * TILE;
    // 预算介于 tile(1MB) 与 tile+mat(2MB) 之间：countMat=false 放行、true 冻结
    d.configureMemory(tileBytes + 0.5 * TILE, false);
    eq(d.maxLayers, 64, "不计 mat：tile<预算 → 硬顶");
    d.configureMemory(tileBytes + 0.5 * TILE, true);
    eq(d.maxLayers, 2, "计 mat：tile+mat≥预算 → 冻结(floor 2)");
  });
});
