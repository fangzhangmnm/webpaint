// LayerTree（T3a，ADR-0008）：纯 json substrate / 换根收集 / tileset 引用计数所有权算术
//（TreeStructureOp bounded 泄漏的 v2 解——回归锚：删组→驱逐→无泄漏）/ verbs 契约 / setActive 不记账。
import { describe, it, assert, eq } from "./runner.mjs";
import { UndoStack } from "../src/backend/workpiece/undo-stack.ts";
import { PaintingWorkpiece } from "../src/backend/workpiece/painting-workpiece.ts";
import { LayerTree } from "../src/backend/workpiece/layer-tree.ts";
import { LayerPixels } from "../src/backend/tiles/tile-layer.ts";

class Wp extends PaintingWorkpiece {
  attachTree(t) { this.register(t, { undo: "recorded" }); }
}

// 组合根形态（未来 app 接线同构）：host 经 tree 的 pixelsRef 解析进 tiles 注册表。
function mk(opts = {}) {
  const undo = new UndoStack({ maxQuotaBytes: opts.maxQuotaBytes ?? (1 << 30) });
  let tree = null;
  const host = {
    getPixels: (layerId) => {
      const leaf = tree?.leafById(layerId);
      return leaf ? wp.layerTiles.tilesetPixels(leaf.pixelsRef) : null;
    },
    findLayerIdByPixels: (lp) => {
      let f = null;
      const walk = (ns) => ns.forEach((n) => {
        if ("children" in n) walk(n.children);
        else if (wp.layerTiles.tilesetPixels(n.pixelsRef) === lp) f = n.id;
      });
      if (tree) walk(tree.view().nodes);
      return f;
    },
    eachLayer: (cb) => {
      const walk = (ns) => ns.forEach((n) => {
        if ("children" in n) walk(n.children);
        else cb(n.id, wp.layerTiles.tilesetPixels(n.pixelsRef));
      });
      if (tree) walk(tree.view().nodes);
    },
    replacePixels: (layerId, np) => {
      const leaf = tree?.leafById(layerId);
      if (leaf) wp.layerTiles.swapTilesetPixels(leaf.pixelsRef, np);
    },
  };
  const wp = new Wp({ undo, host, onTokenLeak: () => {} });
  // 初始 doc：一张 64×64 一叶
  const lp0 = new LayerPixels(64, 64);
  const ref0 = wp.layerTiles.createTileset(lp0);
  tree = new LayerTree({
    wp, tiles: wp.layerTiles,
    initial: {
      nodes: [{ id: 1, name: "bg", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixelsRef: ref0 }],
      activeId: 1, referenceLayerId: null, backgroundColor: "#ffffff", width: 64, height: 64,
    },
  });
  wp.layerTiles.releaseTileset(ref0);   // json 已收养
  wp.attachTree(tree);
  return { undo, wp, tree, tiles: wp.layerTiles };
}

const solid = (w, h, v) => new Uint8ClampedArray(w * h * 4).fill(v);

describe("LayerTree · 换根收集与所有权", () => {
  it("addLayer：插 active 上方 + active 换新；一步入栈；undo/redo 树往返", () => {
    const { undo, wp, tree } = mk();
    const v0 = tree.view();
    const t = wp.begin("addLayer");
    const leaf = tree.addLayer("paint");
    t.commit();
    assert(leaf && tree.view().activeId === leaf.id);
    eq(tree.view().nodes.length, 2);
    eq(tree.view().nodes[1].id, leaf.id, "插在 active(index0) 上方");
    assert(v0.nodes.length === 1, "旧 view 引用未被改（不可变值约定）");
    eq(undo.depth(), 1);
    undo.undo();
    eq(tree.view().nodes.length, 1);
    eq(tree.view().activeId, 1, "undo 带回当时焦点");
    undo.redo();
    eq(tree.view().nodes.length, 2);
    undo.clear();
  });

  it("removeLayer：keep-one 守卫；删层 tileset 由 record 旧根持有——undo 复活、驱逐才释放（泄漏锚）", () => {
    const { undo, wp, tree, tiles } = mk();
    let t = wp.begin(); const leaf = tree.addLayer("a"); t.commit();
    t = wp.begin(); tiles.putRegion(leaf.id, 0, 0, 4, 4, solid(4, 4, 77)); t.commit();
    eq(tiles.tilesetCount(), 2);
    t = wp.begin(); assert(tree.removeLayer(leaf.id)); t.commit();
    eq(tree.countLeaves(), 1);
    eq(tiles.tilesetCount(), 2, "删层后 tileset 仍活（record 旧根持有）");
    undo.undo();
    eq(tree.countLeaves(), 2);
    eq(tiles.getRegion(leaf.id, 0, 0, 1, 1)[0], 77, "undo 复活层，像素原样");
    undo.redo();
    undo.clear();   // 清栈 = 驱逐所有 record
    eq(tiles.tilesetCount(), 1, "驱逐后 tileset 归零还池（TreeStructureOp 泄漏在 v2 消灭）");
    // keep-one
    const t2 = wp.begin();
    assert(!tree.removeLayer(1), "最后一叶不删");
    t2.cancel();
  });

  it("删组连带 children → 驱逐 → 无泄漏（回归锚）；undo 组连叶复活", () => {
    const { undo, wp, tree, tiles } = mkGrouped();   // 初始树自带组[g10: a11, b12]
    let t = wp.begin();
    tiles.putRegion(11, 0, 0, 2, 2, solid(2, 2, 10));
    tiles.putRegion(12, 0, 0, 2, 2, solid(2, 2, 20));
    t.commit();
    eq(tiles.tilesetCount(), 3);
    t = wp.begin(); assert(tree.removeGroupAndFillEmpty(10)); t.commit();
    eq(tree.countLeaves(), 1, "组连 children 一起删");
    eq(tiles.tilesetCount(), 3, "游离叶 tileset 由 record 旧根持有（v1 已知取舍在 v2 消灭的部位）");
    undo.undo();
    eq(tree.countLeaves(), 3, "undo 组连叶复活");
    eq(tiles.getRegion(11, 0, 0, 1, 1)[0], 10, "像素原样");
    undo.redo();
    undo.clear();   // 驱逐
    eq(tiles.tilesetCount(), 1, "驱逐后游离叶全释放——删组泄漏回归锚");
  });

  it("explodeGroupInPlace：children 提到原位；moveIntoGroup/moveOutOfGroup 往返", () => {
    const { undo, wp, tree } = mkGrouped();
    let t = wp.begin(); assert(tree.explodeGroupInPlace(10)); t.commit();
    eq(tree.view().nodes.length, 3, "解组后顶层 3 节点");
    assert(tree.view().nodes.every((n) => !("children" in n)));
    undo.undo();
    eq(tree.view().nodes.length, 2, "undo 组回来");
    t = wp.begin();
    assert(tree.moveIntoGroup(1, 10), "bg 进组");
    assert(tree.moveOutOfGroup(1), "再出组");
    t.commit();
    eq(tree.view().nodes.length, 2);
    undo.clear();
  });

  it("cancel：新建层回滚 → tileset 立即释放、树无痕", () => {
    const { wp, tree, tiles } = mk();
    const t = wp.begin();
    const leaf = tree.addLayer("tmp");
    tiles.putRegion(leaf.id, 0, 0, 2, 2, solid(2, 2, 5));
    t.cancel();
    eq(tree.countLeaves(), 1);
    eq(tiles.tilesetCount(), 1, "cancel 后新 tileset 还池");
  });

  it("配额驱逐路（整步 dispose）也释放树根引用", () => {
    const { undo, wp, tree, tiles } = mk({ maxQuotaBytes: 1 });   // recordBytes(树)>1 → 每 push 即驱逐旧步
    let t = wp.begin(); const a = tree.addLayer("a"); t.commit();
    t = wp.begin(); tree.removeLayer(a.id); t.commit();
    t = wp.begin(); tree.setTreeProp("backgroundColor", "#123456"); t.commit();
    // removeLayer 那步已被配额驱逐 → a 的 tileset 应已释放
    eq(tiles.tilesetCount(), 1, "被驱逐 record 的旧根引用已释放");
    undo.clear();
  });
});

describe("LayerTree · verbs 契约", () => {
  it("duplicateLayer：props 原样、像素零拷贝共享、插源上方", () => {
    const { wp, tree, tiles, undo } = mk();
    let t = wp.begin(); tiles.putRegion(1, 0, 0, 2, 2, solid(2, 2, 66)); t.commit();
    t = wp.begin(); const d = tree.duplicateLayer(1); t.commit();
    assert(d && d.id !== 1);
    eq(tiles.getRegion(d.id, 0, 0, 1, 1)[0], 66, "副本像素同");
    eq(tree.view().activeId, d.id);
    undo.clear();
  });

  it("moveLayer 越界 false；moveIntoGroup 自嵌套拒绝；moveOutOfGroup 非组内 false", () => {
    const { wp, tree } = mk();
    const t = wp.begin();
    tree.addLayer("a");
    assert(!tree.moveLayer(1, -1), "底层再往下 false");
    assert(tree.moveLayer(1, +1), "上移成");
    assert(!tree.moveOutOfGroup(1), "不在组内 false");
    t.cancel();
  });

  it("setLayerProp/setTreeProp/referenceLayerId 记账；setActive 不记账", () => {
    const { undo, wp, tree } = mk();
    let t = wp.begin(); tree.addLayer("a"); t.commit();
    const d0 = undo.depth();
    assert(tree.setActive(1), "setActive 无需令牌");
    eq(undo.depth(), d0, "setActive 不占步");
    eq(tree.view().activeId, 1);
    t = wp.begin();
    assert(tree.setLayerProp(1, "opacity", 0.5));
    assert(tree.setLayerProp(1, "name", "改名"));
    tree.setTreeProp("referenceLayerId", 1);
    t.commit();
    eq(undo.depth(), d0 + 1, "多 verb 一 token 一步");
    eq(tree.leafById(1).opacity, 0.5);
    undo.undo();
    eq(tree.leafById(1).opacity, 1);
    eq(tree.leafById(1).name, "bg");
    eq(tree.view().referenceLayerId, null);
    undo.clear();
  });

  it("mergeDown：字节递入 under、under 归一化、top 移除、active=under；undo 全还原", () => {
    const { undo, wp, tree, tiles } = mk();
    let t = wp.begin();
    const topL = tree.addLayer("top");
    tiles.putRegion(1, 0, 0, 2, 2, solid(2, 2, 40));
    tiles.putRegion(topL.id, 2, 2, 2, 2, solid(2, 2, 80));
    tree.setLayerProp(1, "opacity", 0.7);
    t.commit();
    t = wp.begin();
    const merged = solid(4, 4, 99);   // 外部烤好（此处造假字节，语义=递入）
    assert(tree.mergeDown(topL.id, { bytes: merged, rect: { x: 0, y: 0, w: 4, h: 4 }, resultClipping: false }));
    t.commit();
    eq(tree.countLeaves(), 1);
    eq(tree.leafById(1).opacity, 1, "under 归一化");
    eq(tree.view().activeId, 1);
    eq(tiles.getRegion(1, 3, 3, 1, 1)[0], 99, "合成字节已落 under");
    undo.undo();
    eq(tree.countLeaves(), 2, "top 复活");
    eq(tree.leafById(1).opacity, 0.7, "under props 还原");
    eq(tiles.getRegion(1, 0, 0, 1, 1)[0], 40, "under 像素还原");
    eq(tiles.getRegion(1, 3, 3, 1, 1)[3], 0, "合成区还原为空");
    undo.redo();
    eq(tree.countLeaves(), 1);
    eq(tiles.getRegion(1, 3, 3, 1, 1)[0], 99);
    undo.clear();
  });

  it("mergeDown 守卫：底层/under 是组/under 剪裁而 top 不剪 → false", () => {
    const { wp, tree } = mk();
    const t = wp.begin();
    assert(!tree.mergeDown(1, { bytes: solid(1, 1, 0), rect: { x: 0, y: 0, w: 1, h: 1 }, resultClipping: false }), "最底层 false");
    const a = tree.addLayer("a");
    tree.setLayerProp(1, "clippingMask", true);
    assert(!tree.mergeDown(a.id, { bytes: solid(1, 1, 0), rect: { x: 0, y: 0, w: 1, h: 1 }, resultClipping: false }), "under 剪裁 top 不剪 false");
    t.cancel();
  });

  it("maxLeaves：到顶 addLayer/duplicate 返 null", () => {
    const m = mkSmall();   // maxLeaves=2
    const t = m.wp.begin();
    assert(m.tree.addLayer("a"), "第二叶可加");
    eq(m.tree.addLayer("b"), null, "到 maxLeaves 返 null");
    eq(m.tree.duplicateLayer(1), null, "duplicate 同守卫");
    t.cancel();
  });
});

// 带组变体：nodes = [bg(1), group(10){a(11), b(12)}]
function mkGrouped() {
  const undo = new UndoStack({ maxQuotaBytes: 1 << 30 });
  let tree = null;
  const host = {
    getPixels: (layerId) => { const l = tree?.leafById(layerId); return l ? wp.layerTiles.tilesetPixels(l.pixelsRef) : null; },
    findLayerIdByPixels: (lp) => {
      let f = null;
      const walk = (ns) => ns.forEach((n) => { if ("children" in n) walk(n.children); else if (wp.layerTiles.tilesetPixels(n.pixelsRef) === lp) f = n.id; });
      if (tree) walk(tree.view().nodes);
      return f;
    },
    eachLayer: (cb) => {
      const walk = (ns) => ns.forEach((n) => { if ("children" in n) walk(n.children); else cb(n.id, wp.layerTiles.tilesetPixels(n.pixelsRef)); });
      if (tree) walk(tree.view().nodes);
    },
    replacePixels: (layerId, np) => { const l = tree?.leafById(layerId); if (l) wp.layerTiles.swapTilesetPixels(l.pixelsRef, np); },
  };
  const wp = new Wp({ undo, host, onTokenLeak: () => {} });
  const mkRef = () => wp.layerTiles.createTileset(new LayerPixels(64, 64));
  const r1 = mkRef(), r11 = mkRef(), r12 = mkRef();
  const leaf = (id, name, pixelsRef) => ({ id, name, visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixelsRef });
  tree = new LayerTree({
    wp, tiles: wp.layerTiles,
    initial: {
      nodes: [leaf(1, "bg", r1), { id: 10, name: "g", visible: true, opacity: 1, mode: "source-over", clippingMask: false, children: [leaf(11, "a", r11), leaf(12, "b", r12)] }],
      activeId: 1, referenceLayerId: null, backgroundColor: "#fff", width: 64, height: 64,
    },
  });
  for (const r of [r1, r11, r12]) wp.layerTiles.releaseTileset(r);
  wp.attachTree(tree);
  return { undo, wp, tree, tiles: wp.layerTiles };
}

// 小上限变体（maxLeaves=2）
function mkSmall() {
  const undo = new UndoStack({ maxQuotaBytes: 1 << 30 });
  let tree = null;
  const host = {
    getPixels: (layerId) => { const l = tree?.leafById(layerId); return l ? wp.layerTiles.tilesetPixels(l.pixelsRef) : null; },
    findLayerIdByPixels: () => null,
    eachLayer: () => {},
    replacePixels: () => {},
  };
  const wp = new Wp({ undo, host, onTokenLeak: () => {} });
  const lp0 = new LayerPixels(32, 32);
  const ref0 = wp.layerTiles.createTileset(lp0);
  tree = new LayerTree({
    wp, tiles: wp.layerTiles, maxLeaves: () => 2,
    initial: {
      nodes: [{ id: 1, name: "bg", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixelsRef: ref0 }],
      activeId: 1, referenceLayerId: null, backgroundColor: "#fff", width: 32, height: 32,
    },
  });
  wp.layerTiles.releaseTileset(ref0);
  wp.attachTree(tree);
  return { undo, wp, tree };
}
