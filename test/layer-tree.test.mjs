// 图层树模型（batch 2）：嵌套树 op + activeId + 组 op + snapshotAll 树往返。
// 纯结构验收（不验像素）。
// 注：照 doc-rotate/doc-mergedown 的约定——**动态** import doc.js（静态 import 会给模块图加边、
//   扰动 globalThis.OffscreenCanvas 的 stub 泄漏顺序，毒到 selection-morph）；每个 it() 开头 useStub()。
import { describe, it, assert } from "./runner.mjs";

// 完整 canvas stub（all-noop ctx + 空 getImageData）——结构测试够用（含 clearRect/setTransform，
//   不像 selection/doc-mergedown 的极简 stub）。
function makeCtx() {
  const ctx = {
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4), width: w || 1, height: h || 1 }),
    putImageData: () => {},
  };
  return new Proxy(ctx, { get(t, p) { return p in t ? t[p] : (() => {}); }, set(t, p, v) { t[p] = v; return true; } });
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this._ctx = makeCtx(); }
  getContext() { return this._ctx; }
}
const _prevOSC = globalThis.OffscreenCanvas;
function useStub() { globalThis.OffscreenCanvas = StubCanvas; }
useStub();
const { PaintDoc, LayerGroup, findNodeById, findParentOf, countLeaves, flattenLeaves } =
  await import("../src/doc.js");
globalThis.OffscreenCanvas = _prevOSC;   // import 完还原，避免毒别的文件

// 每个 it() 开头 useStub()（PaintDoc 构造/快照走 OffscreenCanvas）。
const T = (name, fn) => it(name, () => { useStub(); fn(); });

const ids = (nodes) => nodes.map((n) => n.id);

describe("layer-tree · 基础树工具", () => {
  T("新建 doc：1 叶，active = 它", () => {
    const d = new PaintDoc();
    assert(d.layers.length === 1 && !d.layers[0].isGroup, "1 叶");
    assert(d.activeId === d.layers[0].id, "active = 叶");
    assert(countLeaves(d.layers) === 1, "countLeaves=1");
  });

  T("addLayer 插在 active 同级之上 + 设 active", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    assert(d.layers.length === 2 && d.layers[1] === L1, "L1 在 L0 之上");
    assert(d.activeId === L1.id, "active=L1");
    assert(d.activeIndex === 1, "兼容 activeIndex=1（扁平叶序）");
  });

  T("findNodeById / findParentOf 递归", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.groupSelection(L1.id);
    const g = d.layers.find((n) => n.isGroup);
    assert(findNodeById(d.layers, L1.id) === L1, "递归找到组内叶");
    const loc = findParentOf(d.layers, L1.id);
    assert(loc.parentNode === g && loc.parent === g.children, "parentNode=组");
  });
});

describe("layer-tree · 组 op", () => {
  T("groupSelection 把节点包进组、替换原位、active=组", () => {
    const d = new PaintDoc();
    const L0 = d.layers[0];
    const r = d.groupSelection(L0.id);
    assert(r.ok && r.group.isGroup, "建组");
    assert(d.layers.length === 1 && d.layers[0] === r.group, "组替换原位");
    assert(r.group.children[0] === L0, "L0 进组");
    assert(d.activeId === r.group.id, "active=组");
  });

  T("ungroup 把 children 提回原位、删组", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.groupSelection(L1.id);
    const g = d.layers[1];
    const r = d.ungroup(g.id);
    assert(r.ok, "ungroup ok");
    assert(ids(d.layers).join() === [d.layers[0].id, L1.id].join(), "L1 回到原位 [L0,L1]");
    assert(!d.layers.some((n) => n.isGroup), "组已删");
  });

  T("moveIntoGroup / moveOutOfGroup", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    const g = new LayerGroup({});
    d.layers.push(g);
    assert(d.moveIntoGroup(L1.id, g.id), "移入");
    assert(g.children[0] === L1 && d.layers.length === 2, "L1 进 G、根剩 2");
    assert(d.moveOutOfGroup(L1.id), "移出");
    assert(g.children.length === 0 && d.layers.includes(L1), "L1 回根、G 空");
  });

  T("moveIntoGroup 拒绝环（组移进自己的子孙）", () => {
    const d = new PaintDoc();
    const inner = new LayerGroup({});
    const outer = new LayerGroup({ children: [inner] });
    d.layers.push(outer);
    assert(d.moveIntoGroup(outer.id, inner.id) === false, "outer 不能进其子 inner");
  });

  T("countLeaves 不计组；嵌套照数", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.groupSelection(L1.id);
    assert(countLeaves(d.layers) === 2, "2 叶");
  });
});

describe("layer-tree · 删除 / active 稳定", () => {
  T("removeLayer 删组连带 children", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    const L2 = d.addLayer();
    d.setActiveById(L1.id);
    d.groupSelection(L1.id);
    const g = d.layers[1];
    assert(d.removeLayer(g.id), "删组 ok");
    assert(countLeaves(d.layers) === 2, "L1 随组删，剩 L0,L2");
    assert(!findNodeById(d.layers, L1.id), "L1 没了");
  });

  T("不可删到 0 叶（最后一叶守住）", () => {
    const d = new PaintDoc();
    assert(d.removeLayer(d.layers[0].id) === false, "最后一叶不可删");
  });

  T("moveLayer 不改 activeId", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.moveLayer(L1.id, -1);
    assert(d.activeId === L1.id, "active 仍 L1（按 id）");
    assert(d.layers[0] === L1, "L1 到底");
  });
});

describe("layer-tree · snapshotAll 树往返", () => {
  T("嵌套组 + props + id 往返一致", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.groupSelection(L1.id);
    const g = d.layers[1];
    g.name = "组A"; g.opacity = 0.5; g.mode = "multiply"; g.clippingMask = true;
    const snap = d.snapshotAll();
    const d2 = new PaintDoc();
    d2.restoreSnapshotAll(snap);
    assert(d2.layers.length === 2 && d2.layers[1].isGroup, "结构：[叶,组]");
    const g2 = d2.layers[1];
    assert(g2.id === g.id && g2.name === "组A" && g2.opacity === 0.5, "组 props 还原");
    assert(g2.mode === "multiply" && g2.clippingMask === true, "组 mode/clip 还原");
    assert(g2.children[0].id === L1.id, "组内叶 id 还原");
    assert(d2.activeId === d.activeId, "activeId 还原");
  });
});

describe("layer-tree · 撤销树化原语（batch 2 step5）", () => {
  T("locateNode：根层级 + 组内", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();              // [L0, L1]
    const root = d.locateNode(L1.id);
    assert(root.parentId === null && root.index === 1, "L1 根层 index1");
    d.groupSelection(L1.id);             // [L0, G{L1}]
    const g = d.layers[1];
    const inner = d.locateNode(L1.id);
    assert(inner.parentId === g.id && inner.index === 0, "L1 组内 index0");
  });

  T("insertLayerAt(parentId)：插进组内同级", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.groupSelection(L1.id);             // [L0, G{L1}]
    const g = d.layers[1];
    const spec = { id: 999, name: "插入", visible: true, opacity: 1, mode: "source-over", bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
    assert(d.insertLayerAt(0, spec, g.id), "插入 ok");
    assert(g.children.length === 2 && g.children[0].id === 999, "新叶在组内 index0");
    assert(findParentOf(d.layers, 999).parentNode === g, "父是组");
  });

  T("canMoveLayer：同级边界", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();             // [L0, L1]
    assert(d.canMoveLayer(L1.id, 1) === false, "L1 已在顶，不能上");
    assert(d.canMoveLayer(L1.id, -1) === true, "L1 能下");
    assert(d.canMoveLayer(d.layers[0].id, -1) === false, "L0 在底，不能下");
  });

  T("snapshotTree/restoreTree：结构往返 + 叶活引用保持", () => {
    const d = new PaintDoc();
    const L0 = d.layers[0];
    const L1 = d.addLayer();
    d.groupSelection(L1.id);            // [L0, G{L1}]
    const g = d.layers[1];
    g.name = "组X"; g.opacity = 0.3;
    d.setActiveById(L1.id);
    const snap = d.snapshotTree();
    // 打乱：解组（结构变）
    d.ungroup(g.id);                   // [L0, L1] 扁平
    assert(!d.layers.some((n) => n.isGroup), "已解组");
    // 还原
    d.restoreTree(snap);
    assert(d.layers.length === 2 && d.layers[1].isGroup, "结构回到 [叶,组]");
    assert(d.layers[1].children[0] === L1, "叶是**同一个** Layer 对象（活引用）");
    assert(d.layers[0] === L0, "L0 同一对象");
    assert(d.layers[1].name === "组X" && d.layers[1].opacity === 0.3, "组 props 还原");
    assert(d.activeId === L1.id, "activeId 还原");
  });

  T("删组内叶 → insertLayerAt(parentId) 复位回组", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    d.setActiveById(L1.id);
    const L2 = d.addLayer();           // [L0, L1, L2]
    d.groupSelection(L2.id);          // active=G... 重新组 L1+L2 手动
    // 造 G{L1, L2}
    const d2 = new PaintDoc();
    const a = d2.addLayer();          // L0,a
    d2.groupSelection(a.id);          // [L0, G{a}]
    const G = d2.layers[1];
    d2.setActiveById(a.id);
    const b = d2.addLayer();          // G{a,b}
    assert(G.children.length === 2, "组内 2 叶");
    const loc = d2.locateNode(b.id);
    assert(d2.removeLayer(b.id), "删组内叶 b");
    assert(G.children.length === 1, "组内剩 1");
    const spec = { id: b.id, name: b.name, visible: true, opacity: 1, mode: "source-over", bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
    d2.insertLayerAt(loc.index, spec, loc.parentId);
    assert(G.children.length === 2 && findParentOf(d2.layers, b.id).parentNode === G, "b 复位回组");
  });

  T("mergeDownLayer 返回 activeLoc；duplicateLayer 返回 loc", () => {
    const d = new PaintDoc();
    const L1 = d.addLayer();
    L1.ensureBbox(0, 0, 4, 4);        // 给点像素让 mergeDown 不走 empty-active
    L1.bboxW = 4; L1.bboxH = 4;
    const r = d.mergeDownLayer(L1);
    assert(r.ok && r.activeLoc && r.activeLoc.parentId === null && r.activeLoc.index === 1, "activeLoc 同级位");
    const dup = d.duplicateLayer(d.layers[0].id);
    assert(dup.ok && dup.loc && typeof dup.loc.index === "number", "duplicate 返回 loc");
  });
});

describe("layer-tree · addGroup 空组（v278）", () => {
  T("建空组：默认 pass-through、插 active 之上、设 active、不计叶", () => {
    const d = new PaintDoc();
    const L0 = d.layers[0];
    const g = d.addGroup();
    assert(g.isGroup && g.children.length === 0, "空组无 children");
    assert(g.mode === "pass-through", "默认穿透");
    assert(d.layers.length === 2 && d.layers[1] === g, "插在 L0 之上");
    assert(d.activeId === g.id, "active=新组");
    assert(countLeaves(d.layers) === 1, "空组不计叶（仍 1 叶）");
  });
});
