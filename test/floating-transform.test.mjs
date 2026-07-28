// FloatingTransform 约束数学验收（Slice 1 抽模块的行为锁）。
// 纯 mesh→mesh（无 canvas），驱动真实公开路径 beginDrag/extendDrag/setMode/hitTest/visibleHandles。
// 守的是「从 lasso.js 抽出 Float 深模块 + TransformMode adapter 后，free/uniform/distort/旋转/平移/投影
//   的几何与旧实现逐点一致」。warp 已删（不测）。
import { describe, it, assert } from "./runner.mjs";
import { FloatingTransform, sourceDestQuad } from "../src/floating-transform.ts";

const SQ = () => [[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 10 }, { x: 10, y: 10 }]];
function mkFloat(mode = "free", aspect = 1, mesh = SQ()) {
  const ft = new FloatingTransform();
  // v0.4.7（S6）：float 状态在 workpiece，_live 是引擎的本地网格视图——数学测试直接播种 _live
  //   （geometry 驱动路径 beginDrag/extendDrag/setMode/hitTest 不变；未 attach → setMode 不入栈，纯投影）。
  ft._live = {
    gizmoFrame: { origin: { x: mesh[0][0].x, y: mesh[0][0].y }, ux: { x: 10, y: 0 }, uy: { x: 0, y: 10 } },
    mode, meshN: 2, uniformAspect: aspect,
    mesh: mesh.map((r) => r.map((p) => ({ ...p }))),
  };
  return ft;
}
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;
const cNear = (p, x, y, msg) =>
  assert(near(p.x, x) && near(p.y, y), `${msg}: 期望 (${x},${y}) 实得 (${p.x.toFixed(4)},${p.y.toFixed(4)})`);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

describe("FloatingTransform · 平移 / 旋转（mode 无关）", () => {
  it("translate：4 角整体位移 (dx,dy)", () => {
    const ft = mkFloat("free");
    ft.beginDrag({ kind: "translate" }, 100, 100);
    ft.extendDrag(105, 103);
    const m = ft._live.mesh;
    cNear(m[0][0], 5, 3, "TL"); cNear(m[0][1], 15, 3, "TR");
    cNear(m[1][0], 5, 13, "BL"); cNear(m[1][1], 15, 13, "BR");
  });

  it("rotate：绕 centroid 转 90°", () => {
    const ft = mkFloat("free");
    // centroid=(5,5)。start 在角 0（(10,5)），end 在角 π/2（(5,10)）→ dθ=π/2。
    ft.beginDrag({ kind: "rotate" }, 10, 5);
    ft.extendDrag(5, 10);
    const m = ft._live.mesh;
    // TL(0,0) rel(-5,-5) 旋转 90°(cos0 sin1) → (cx - relY, cy + relX) = (10,0)
    cNear(m[0][0], 10, 0, "TL→");
    // 形状不变：边长仍 10
    assert(near(dist(m[0][0], m[0][1]), 10), "上边长保持 10");
    assert(near(dist(m[0][0], m[1][0]), 10), "左边长保持 10");
  });
});

describe("FloatingTransform · distort（4 角 / 边端点自由）", () => {
  it("corner：只动被拖的那一角", () => {
    const ft = mkFloat("distort");
    ft.beginDrag({ kind: "corner", row: 0, col: 1 }, 10, 0);   // 拖 TR
    ft.extendDrag(15, -2);
    const m = ft._live.mesh;
    cNear(m[0][1], 15, -2, "TR 动");
    cNear(m[0][0], 0, 0, "TL 不动"); cNear(m[1][0], 0, 10, "BL 不动"); cNear(m[1][1], 10, 10, "BR 不动");
  });

  it("edge：拖一边 = 平移该边两端点，另两角不动", () => {
    const ft = mkFloat("distort");
    ft.beginDrag({ kind: "edge", edge: "top" }, 5, 0);
    ft.extendDrag(5, -3);                                      // dy=-3
    const m = ft._live.mesh;
    cNear(m[0][0], 0, -3, "TL"); cNear(m[0][1], 10, -3, "TR");
    cNear(m[1][0], 0, 10, "BL 不动"); cNear(m[1][1], 10, 10, "BR 不动");
  });
});

describe("FloatingTransform · free（平行四边形约束）", () => {
  it("corner：对角锚定，保持平行四边形", () => {
    const ft = mkFloat("free");
    ft.beginDrag({ kind: "corner", row: 1, col: 1 }, 10, 10);  // 拖 BR
    ft.extendDrag(16, 16);
    const m = ft._live.mesh;
    cNear(m[0][0], 0, 0, "TL（对角锚）不动");
    const top = sub(m[0][1], m[0][0]);   // TR-TL
    const bot = sub(m[1][1], m[1][0]);   // BR-BL
    assert(near(top.x, bot.x) && near(top.y, bot.y), "上下边相等 = 平行四边形");
  });

  it("edge top：上边动、对边（底）锚定", () => {
    const ft = mkFloat("free");
    ft.beginDrag({ kind: "edge", edge: "top" }, 5, 0);
    ft.extendDrag(5, -4);                                      // 上拖 4 → 高变 14
    const m = ft._live.mesh;
    cNear(m[0][0], 0, -4, "TL 上移"); cNear(m[0][1], 10, -4, "TR 上移");
    cNear(m[1][0], 0, 10, "BL 锚定"); cNear(m[1][1], 10, 10, "BR 锚定");
  });
});

describe("FloatingTransform · uniform（锁纵横比）", () => {
  it("corner 沿对角线：保持正方（aspect=1）", () => {
    const ft = mkFloat("uniform", 1);
    ft.beginDrag({ kind: "corner", row: 1, col: 1 }, 10, 10);
    ft.extendDrag(16, 16);                                     // 沿对角放大
    const m = ft._live.mesh;
    cNear(m[0][0], 0, 0, "TL（对角锚）不动");
    assert(near(dist(m[0][0], m[0][1]), dist(m[0][0], m[1][0])), "宽 == 高（锁比）");
  });
});

describe("FloatingTransform · setMode 投影 + adapter 元数据", () => {
  it("distort → free：去 shear，投成 v⊥u 矩形", () => {
    // 剪切平行四边形（顶边右移 4 = shear）
    const sheared = [[{ x: 4, y: 0 }, { x: 14, y: 0 }], [{ x: 0, y: 10 }, { x: 10, y: 10 }]];
    const ft = mkFloat("distort", 1, sheared);
    ft.setMode("free");
    const m = ft._live.mesh;
    const u = sub(m[0][1], m[0][0]);
    const v = sub(m[1][0], m[0][0]);
    assert(near(dot(u, v), 0), `投影后 u⊥v（dot=${dot(u, v).toFixed(4)}）`);
  });

  it("rotate handle：全模式露（v0.6.21 distort 也要——双手柄语义）", () => {
    const has = (ft) => ft.visibleHandles(1).some((h) => h.kind === "rotate");
    assert(has(mkFloat("free")), "free 有 rotate handle");
    assert(has(mkFloat("uniform")), "uniform 有 rotate handle");
    assert(has(mkFloat("distort")), "distort 也有（圆=转像素恒可用）");
  });

  it("方手柄（basisRotate）：只 distort + 仿射 mesh 时露；拖过透视角自动收回", () => {
    const hasB = (ft) => ft.visibleHandles(1).some((h) => h.kind === "basisRotate");
    assert(!hasB(mkFloat("free")), "free 无方手柄");
    const ft = mkFloat("distort");
    assert(hasB(ft), "distort + 平行四边形 → 方手柄在");
    // 拖一个透视角（applyDistortCorner 只动一角 → 非平行四边形）
    ft.beginDrag({ kind: "corner", row: 1, col: 1, pos: { x: 10, y: 10 } }, 10, 10);
    ft.extendDrag(14, 17);
    ft.endDrag?.();
    assert(!hasB(ft), "透视角拖过（g,h≠0）→ 方手柄收回");
    assert(ft.visibleHandles(1).some((h) => h.kind === "rotate"), "圆手柄仍在");
  });

  it("basisRotate：转参考 frame 不动像素——source destQuad 逐点不变、mesh 旋转、frame 变斜", () => {
    const big = [[{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 100 }, { x: 100, y: 100 }]];
    const ft = mkFloat("distort", 1, big);
    ft._live.gizmoFrame = { origin: { x: 0, y: 0 }, ux: { x: 100, y: 0 }, uy: { x: 0, y: 100 } };
    const rect = { x: 10, y: 20, w: 30, h: 40 };
    const before = sourceDestQuad(rect, ft._live.gizmoFrame, ft._live.mesh);
    // 从方手柄位置起拖，绕质心转 ~37°
    const h = ft.visibleHandles(1).find((x) => x.kind === "basisRotate");
    assert(h, "方手柄在");
    ft.beginDrag(h, h.pos.x, h.pos.y);
    // 目标点 = 手柄绕质心 (50,50) 转一个角度
    const ang = 0.65;
    const px = h.pos.x - 50, py = h.pos.y - 50;
    ft.extendDrag(50 + px * Math.cos(ang) - py * Math.sin(ang), 50 + px * Math.sin(ang) + py * Math.cos(ang));
    const after = sourceDestQuad(rect, ft._live.gizmoFrame, ft._live.mesh);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      cNear(after[i][j], before[i][j].x, before[i][j].y, `destQuad[${i}][${j}] 像素不动`);
    }
    // mesh 真转了（TL 不再在原位）
    assert(dist(ft._live.mesh[0][0], big[0][0]) > 1, "mesh 旋转了");
    // frame 不再轴对齐
    assert(Math.abs(ft._live.gizmoFrame.ux.y) > 1, "frame 轴转了");
    // 转完仍是仿射（平行四边形）→ 方手柄仍在（圆手柄旋转不 disable 方手柄的同款判据）
    assert(ft.visibleHandles(1).some((x) => x.kind === "basisRotate"), "转轴后方手柄仍在");
    // v0.6.23 外接（user 真机："选区大小没自动变化"）：新 mesh 必须包住全部内容角点，
    //   且尺寸随角度呼吸（≠ 原 100 边长）
    const mm = ft._live.mesh;
    const be1 = { x: mm[0][1].x - mm[0][0].x, y: mm[0][1].y - mm[0][0].y };
    const be2 = { x: mm[1][0].x - mm[0][0].x, y: mm[1][0].y - mm[0][0].y };
    const bdet = be1.x * be2.y - be1.y * be2.x;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const p = after[i][j];
      const rx = p.x - mm[0][0].x, ry = p.y - mm[0][0].y;
      const a = (rx * be2.y - ry * be2.x) / bdet, b = (ry * be1.x - rx * be1.y) / bdet;
      assert(a > -1e-6 && a < 1 + 1e-6 && b > -1e-6 && b < 1 + 1e-6, `内容角 (${p.x},${p.y}) 在外接框外`);
    }
    assert(Math.abs(Math.hypot(be1.x, be1.y) - 100) > 1, "外接框尺寸随角度呼吸（≠原边长）");
  });

  it("hitTest：命中角 handle", () => {
    // 大方块（100px），handle 半径 18 不重叠，TR 唯一命中。
    const big = [[{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 100 }, { x: 100, y: 100 }]];
    const ft = mkFloat("free", 1, big);
    const hit = ft.hitTest(100, 0, 1);                         // TR 角
    assert(hit && hit.kind === "corner" && hit.row === 0 && hit.col === 1, "命中 TR corner");
  });
});

// Slice 3：多 source（组变换）= 一个 gizmo 驱动多 source。核心数学 = source.rect 经
//   (gizmoFrame→mesh) homography 映出 dest quad。canvas 路径（bake/commit）真机验；这里压纯映射。
describe("FloatingTransform · 多 source 映射 sourceDestQuad", () => {
  const quad = (b) => [[{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }],
                       [{ x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }]];
  // v0.6.21：gizmo 由 AABB 升级成有向 frame——轴对齐 frame ≡ 旧 bbox 归一（本组断言意图不变）
  const fr = (b) => ({ origin: { x: b.x, y: b.y }, ux: { x: b.w, y: 0 }, uy: { x: 0, y: b.h } });
  const qNear = (q, tl, tr, bl, br, msg) => {
    cNear(q[0][0], tl[0], tl[1], `${msg} TL`); cNear(q[0][1], tr[0], tr[1], `${msg} TR`);
    cNear(q[1][0], bl[0], bl[1], `${msg} BL`); cNear(q[1][1], br[0], br[1], `${msg} BR`);
  };

  it("rect === gizmoBbox → destQuad === mesh（单 source 行为不变的保证）", () => {
    const gb = { x: 10, y: 20, w: 40, h: 30 };
    const mesh = [[{ x: 3, y: 5 }, { x: 60, y: 9 }], [{ x: 1, y: 70 }, { x: 55, y: 88 }]]; // 任意旋转/透视 quad
    const q = sourceDestQuad({ x: gb.x, y: gb.y, w: gb.w, h: gb.h }, fr(gb), mesh);
    qNear(q, [3, 5], [60, 9], [1, 70], [55, 88], "destQuad==mesh");
  });

  it("平移 gizmo：子 rect 跟着平移", () => {
    const gb = { x: 0, y: 0, w: 100, h: 100 };
    const mesh = quad({ x: 50, y: 30, w: 100, h: 100 });        // 整体 +50,+30
    const q = sourceDestQuad({ x: 0, y: 0, w: 50, h: 50 }, fr(gb), mesh);   // TL 四分之一
    qNear(q, [50, 30], [100, 30], [50, 80], [100, 80], "TL 子块平移");
  });

  it("放大 2× gizmo：子 rect 按比例放大", () => {
    const gb = { x: 0, y: 0, w: 100, h: 100 };
    const mesh = quad({ x: 0, y: 0, w: 200, h: 200 });          // 2×
    const q = sourceDestQuad({ x: 0, y: 0, w: 50, h: 50 }, fr(gb), mesh);
    qNear(q, [0, 0], [100, 0], [0, 100], [100, 100], "子块放大 2×");
  });

  it("source 在 gizmoBbox 之外（隐藏叶随组动）：外推一致", () => {
    const gb = { x: 0, y: 0, w: 100, h: 100 };
    const mesh = quad({ x: 10, y: 10, w: 100, h: 100 });        // +10,+10 平移
    const q = sourceDestQuad({ x: 100, y: 100, w: 50, h: 50 }, fr(gb), mesh);   // 框外
    qNear(q, [110, 110], [160, 110], [110, 160], [160, 160], "框外 source 同样 +10,+10");
  });
});
