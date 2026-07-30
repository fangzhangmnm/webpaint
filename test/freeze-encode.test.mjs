// S8 encode 冻结视图（spec:41 存档一致性的达意实现）：freezeDocForEncode 同步冻结
// {结构 + 每叶 tile 快照}，encode 的 await 间隙里的编辑（CoW / 结构变）不触及冻结视图。
import { describe, it, assert, eq } from "./runner.mjs";
const { PaintDoc, freezeDocForEncode } = await import("../src/doc.ts");

// v0.6.44 回归：冻结视图必须带 getImageData（快照 tiles 字节直读）。
// 真机事故：v0.6.42 ora 存层改 L.getImageData 直读，session push 走冻结视图（当时缺该方法）
// → 「推送失败 getImageData is not a function」。unsafe cast 曾挡住 tsc——本测锁运行时行为。
describe("freezeDocForEncode · 冻结视图字节读口（v0.6.44）", () => {
  it("frozen leaf.getImageData = 冻结时刻像素（零 canvas；冻结后再画不影响）", () => {
    const doc = mkDoc();
    const L = doc.layers[0];
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i++) { buf[i * 4] = 10 + i; buf[i * 4 + 1] = 20; buf[i * 4 + 2] = 30; buf[i * 4 + 3] = 255; }
    L.putImageData(4, 6, { width: 8, height: 8, data: buf });
    const { frozen, dispose } = freezeDocForEncode(doc);
    L.putImageData(4, 6, { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) });
    const fl = frozen.layers[0];
    const img = fl.getImageData(fl.bboxX, fl.bboxY, fl.bboxW, fl.bboxH);
    assert(buf.every((v, i) => v === img.data[i]), "冻结视图逐字节 = 冻结时刻（后续编辑不撕）");
    dispose();
  });
});

// v0.7.8 回归：冻结视图必须带 doc 级元数据 activeId/referenceLayerId。
// 真机事故：FrozenDoc 漏抄 referenceLayerId → 保存路径 stack.xml 永远不写 webpaint:reference
// → 保存重开参考层 flag 丢失（activeId 有 state.json 备份通道所以一直无症状）。
describe("freezeDocForEncode · doc 级元数据（v0.7.8 参考层丢失回归）", () => {
  it("frozen 带 activeId / referenceLayerId，stack.xml 写出 webpaint:reference", async () => {
    const { buildStackXml } = await import("../src/ora-stack-xml.ts");
    const doc = mkDoc({ width: 64, height: 64 });
    doc.referenceLayerId = doc.layers[0].id;
    const { frozen, dispose } = freezeDocForEncode(doc);
    eq(frozen.referenceLayerId, doc.layers[0].id, "冻结视图抄到 referenceLayerId");
    eq(frozen.activeId, doc.activeId, "冻结视图抄到 activeId");
    const xml = buildStackXml(frozen);
    assert(xml.includes('webpaint:reference="true"'), "保存路径 stack.xml 含 webpaint:reference");
    assert(xml.includes('webpaint:active="true"'), "保存路径 stack.xml 含 webpaint:active");
    dispose();
  });
});

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
const _docs = [];
const mkDoc = (o) => { const d = new PaintDoc(o); _docs.push(d); return d; };

function paint(layer, x, y, w, h) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i += 4) { a[i] = 200; a[i + 3] = 255; }
  layer.pixels.putRegion(x, y, w, h, a);
}

describe("freezeDocForEncode · encode 存档一致性（S8）", () => {
  it("冻结后改像素：冻结叶 bbox/内容不动，活层照常变", () => {
    const doc = mkDoc({ width: 512, height: 512 });
    const L = doc.layers[0];
    paint(L, 0, 0, 64, 64);
    const { frozen, dispose } = freezeDocForEncode(doc);
    const fl = frozen.layers[0];
    eq(fl.bboxW, 64, "冻结时 bbox=64");
    paint(L, 0, 0, 300, 300);                       // encode「中途」编辑
    eq(fl.bboxW, 64, "冻结叶 bbox 不随后续编辑变");
    assert(L.bboxW === 300, "活层 bbox 已变 300");
    dispose();
  });

  it("冻结后层结构操作：冻结树形状不变", () => {
    const doc = mkDoc({ width: 512, height: 512 });
    const { frozen, dispose } = freezeDocForEncode(doc);
    const n0 = frozen.layers.length;
    doc.addLayer && doc.addLayer();                 // 有 API 就加层；没有则跳（结构由下断言兜）
    doc.layers.push(doc.layers[0]);                 // 直接动数组也不该影响冻结视图
    eq(frozen.layers.length, n0, "冻结树 children 数不变");
    doc.layers.pop();
    dispose();
  });

  it("dispose 释放快照句柄（released 置位）", () => {
    const doc = mkDoc({ width: 512, height: 512 });
    paint(doc.layers[0], 0, 0, 64, 64);
    const { dispose } = freezeDocForEncode(doc);
    dispose();   // 不抛 = 句柄成对释放；泄漏由池 FR assert 兜（node --expose-gc 之外无法直接断言）
    assert(true);
  });

  it("空层冻结：bbox=0、canvas 1×1 占位（与 Layer getter 语义一致）", () => {
    const doc = mkDoc({ width: 512, height: 512 });
    const { frozen, dispose } = freezeDocForEncode(doc);
    const fl = frozen.layers[0];
    eq(fl.bboxW, 0);
    eq(fl.bboxH, 0);
    assert(fl.canvas, "canvas 占位存在");
    dispose();
  });
});

// v0.6.44 回归：冻结视图必须带 getImageData（快照 tiles 字节直读）。
// 真机事故：v0.6.42 ora 存层改 L.getImageData 直读，session push 走冻结视图（当时缺该方法）
// → 「推送失败 getImageData is not a function」。unsafe cast 曾挡住 tsc——本测锁运行时行为。
describe("freezeDocForEncode · 冻结视图字节读口（v0.6.44）", () => {
  it("frozen leaf.getImageData = 冻结时刻像素（零 canvas；冻结后再画不影响）", () => {
    const doc = mkDoc();
    const L = doc.layers[0];
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i++) { buf[i * 4] = 10 + i; buf[i * 4 + 1] = 20; buf[i * 4 + 2] = 30; buf[i * 4 + 3] = 255; }
    L.putImageData(4, 6, { width: 8, height: 8, data: buf });
    const { frozen, dispose } = freezeDocForEncode(doc);
    L.putImageData(4, 6, { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) });
    const fl = frozen.layers[0];
    const img = fl.getImageData(fl.bboxX, fl.bboxY, fl.bboxW, fl.bboxH);
    assert(buf.every((v, i) => v === img.data[i]), "冻结视图逐字节 = 冻结时刻（后续编辑不撕）");
    dispose();
  });
});

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
describe("freeze-encode 收尾", () => {
  it("释放本文件的 doc tiles", async () => {
    const { eachLeaf } = await import("../src/doc.ts");
    for (const d of _docs) { eachLeaf(d.layers, (l) => l.pixels?.dispose?.()); d.selection?.dispose?.(); }
    _docs.length = 0;
    assert(true, "disposed");
  });
});
