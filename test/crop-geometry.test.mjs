// Crop 几何验收（A1）。纯数学，重点压 handle 的 anchor 钳制与扩张语义。
import { describe, it, assert, eq } from "./runner.mjs";
import { resizeCropRect, cropRectToInts } from "../src/crop-geometry.js";

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
