// Crop 几何验收（A1）。纯数学，重点压 handle 的 anchor 钳制与扩张语义。
import { describe, it, assert, eq } from "./runner.mjs";
import { resizeCropRect, cropRectToInts } from "../src/crop-geometry.ts";

const R = { x: 100, y: 100, w: 200, h: 200 };   // 起手框
const rectEq = (r, x, y, w, h, msg) => assert(r.x === x && r.y === y && r.w === w && r.h === h,
  `${msg || ""}: 期望 {${x},${y},${w},${h}} 实得 {${r.x},${r.y},${r.w},${r.h}}`);

describe("crop-geometry · resizeCropRect", () => {
  it("move：只平移、尺寸不变", () => rectEq(resizeCropRect("move", R, 30, -10), 130, 90, 200, 200, "move"));

  it("单边 e/s：只动对应宽/高", () => {
    rectEq(resizeCropRect("e", R, 50, 999), 100, 100, 250, 200, "e 只动 w");
    rectEq(resizeCropRect("s", R, 999, 40), 100, 100, 200, 240, "s 只动 h");
  });
  it("单边 n/w：动 origin + 反向尺寸", () => {
    rectEq(resizeCropRect("n", R, 0, 30), 100, 130, 200, 170, "n: y+30 h-30");
    rectEq(resizeCropRect("w", R, 30, 0), 130, 100, 170, 200, "w: x+30 w-30");
  });
  it("角 nw：同时动 x/y/w/h", () => rectEq(resizeCropRect("nw", R, 20, 20), 120, 120, 180, 180, "nw"));

  it("缩到 min 下限：含 w 拖左边过头 → 右边钉住（x 锚到右）", () => {
    // 往右拖 w 边 300（远超 w=200）→ w 触底 min=4，x 应钉到 r0.x+r0.w-4 = 296
    rectEq(resizeCropRect("w", R, 300, 0, { min: 4 }), 296, 100, 4, 200, "w 触底锚右");
  });
  it("缩到 min：含 n 拖下边过头 → 下边钉住（y 锚到下）", () => {
    rectEq(resizeCropRect("n", R, 0, 300, { min: 4 }), 100, 296, 200, 4, "n 触底锚下");
  });
  it("e 触 min 不挪 x（右边拖法无锚移）", () => {
    rectEq(resizeCropRect("e", R, -300, 0, { min: 4 }), 100, 100, 4, 200, "e 触底 x 不动");
  });
  it("max 上限：含 w 超上限 → x 锚右", () => {
    rectEq(resizeCropRect("w", R, -1000, 0, { max: 500 }), -200, 100, 500, 200, "w 超 max 锚右");
  });
  it("扩张：x/y 可负、w/h 可超 doc（v127）", () => {
    rectEq(resizeCropRect("nw", R, -50, -50, { min: 4, max: 8192 }), 50, 50, 250, 250, "向外扩");
  });
});

describe("crop-geometry · cropRectToInts", () => {
  it("取整 + w/h 夹 [min,max]；x/y 负值保留（扩张）", () => {
    eq(JSON.stringify(cropRectToInts({ x: -3.9, y: 2.8, w: 10.9, h: 99999 }, { min: 1, max: 8192 })),
      JSON.stringify({ x: -3, y: 2, w: 10, h: 8192 }));
  });
  it("w/h < min → 抬到 min", () => {
    eq(cropRectToInts({ x: 0, y: 0, w: 0, h: 0 }, { min: 1, max: 8192 }).w, 1);
  });
});

// ---- v0.6.48 模板模式：锁比 resize + fit ----
import { resizeCropRectAspect, fitRectToBBox } from "../src/crop-geometry.ts";

describe("crop-geometry · 模板锁比", () => {
  const r0 = { x: 10, y: 20, w: 40, h: 60 };   // aspect 2/3
  const a = 2 / 3;
  it("角 se：主导轴定尺寸、对角(nw)锚定、比例恒定", () => {
    const r = resizeCropRectAspect("se", r0, 20, 5, a);
    assert(Math.abs(r.w / r.h - a) < 1e-9, "比例锁死");
    eq(r.x, 10); eq(r.y, 20, "nw 锚不动");
    eq(r.w, 60, "dx=20 主导 → w=60");
  });
  it("角 nw：锚在 se（右下角坐标不变）", () => {
    const r = resizeCropRectAspect("nw", r0, -20, 0, a);
    assert(Math.abs((r.x + r.w) - 50) < 1e-9 && Math.abs((r.y + r.h) - 80) < 1e-9, "se 角锚定");
    assert(Math.abs(r.w / r.h - a) < 1e-9);
  });
  it("边 e：垂直居中；边 s：水平居中", () => {
    const re = resizeCropRectAspect("e", r0, 10, 0, a);
    assert(Math.abs((re.y + re.h / 2) - 50) < 1e-9, "中线不动");
    const rs = resizeCropRectAspect("s", r0, 0, 30, a);
    assert(Math.abs((rs.x + rs.w / 2) - 30) < 1e-9, "中线不动");
    assert(Math.abs(rs.w / rs.h - a) < 1e-9);
  });
  it("fit：cover=内含最大比例框；contain=外接最小比例框（都居中）", () => {
    const bbox = { x: 0, y: 0, w: 100, h: 50 };
    const cov = fitRectToBBox(bbox, 1, "cover");     // 方框 inside 100×50 → 50×50 居中
    eq(cov.w, 50); eq(cov.h, 50); eq(cov.x, 25); eq(cov.y, 0);
    const con = fitRectToBBox(bbox, 1, "contain");   // 方框 contain → 100×100 居中
    eq(con.w, 100); eq(con.h, 100); eq(con.x, 0); eq(con.y, -25);
  });
});

describe("doc.cropResampleTo · 裁剪+重采样原子 op", () => {
  it("frame=目标 px 整数 → 纯裁剪逐字节；÷2 → 面积平均", async () => {
    const { PaintDoc, eachLeaf } = await import("../src/doc.ts");
    const doc = new PaintDoc({ width: 64, height: 64 });
    const L = doc.layers[0];
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < 256; i++) { buf[i * 4] = i % 256; buf[i * 4 + 1] = 77; buf[i * 4 + 2] = 200; buf[i * 4 + 3] = 255; }
    L.putImageData(8, 8, { width: 16, height: 16, data: buf });
    // 纯裁剪：frame (8,8,16,16) → 16×16
    doc.cropResampleTo({ x: 8, y: 8, w: 16, h: 16 }, 16, 16);
    eq(doc.width, 16); eq(doc.height, 16);
    const back = doc.layers[0].pixels.getRegion(0, 0, 16, 16);
    assert(buf.every((v, i) => v === back[i]), "恒等路径逐字节");
    // ÷2：16×16 → 8×8 面积平均（纯色区仍纯色）
    doc.cropResampleTo({ x: 0, y: 0, w: 16, h: 16 }, 8, 8);
    eq(doc.width, 8);
    const px = doc.layers[0].sampleAt(4, 4);
    eq(px[1], 77, "G 通道纯色不变"); eq(px[3], 255);
    eachLeaf(doc.layers, (l) => l.pixels?.dispose?.());
  });
});
