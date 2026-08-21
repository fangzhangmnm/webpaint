// v0.8 T3b-2 · LayerTree 门面行为锁（换心后：withPoint + LayerTree(json) verbs；旧 operator 流退役）。
// （区分 layer-tree-json.test.mjs——那是 v2 树组件的 verb 契约；本文件测 workpiece.layers 门面 =
//   app 调用面的「写即记账」行为：undo/redo 往返、checkpoint 聚合、keep-one、hint 文案。）
// 迁移自旧 operator-流版（v0.8.1 S1）——锚语义逐条保留：
//   - addLayer/duplicateNode = 创建即记账（undo 摘层回 prevActive、redo 连像素恢复——像素随
//     tileset 在 record 根里保活，v2 天然给出旧「undo 摘层时才捕 spec」的效果）；
//   - deleteGroup 删到 0 叶自动补空层；removeLayer keep-one 守卫透传；
//   - checkpoint:false 微步聚合（import 单整点语义 v0.7.41）；
//   - setLayerProp（拖动预览走 view 镜像、提交单账）；clearLayer 像素还原；
//   - statuses → step.hint（undo/redo 状态栏文案）；装配纪律 throw。
// mergeDown 走 GL 合成，node 不可测（归 gl-smoke/真机批，同旧注）。
import { describe, it, assert, eq } from "./runner.mjs";
import { seedWrite } from "./helpers.mjs";
import { PaintingWorkpiece } from "../src/backend/workpiece/painting-workpiece.ts";
import { PaintingView, flattenViewLeaves, countViewLeaves } from "../src/backend/workpiece/painting-view.ts";
import { History } from "../src/backend/workpiece/history.ts";
import { LayersFace } from "../src/backend/layers-face.ts";

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏）
const _ctxs = [];
function mk() {
  let unrec = 0;
  const statuses = [];
  const h = new History({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => { unrec++; } });
  const wp2 = new PaintingWorkpiece({ undo: h.stack, tree: { width: 128, height: 128 } });
  const doc = new PaintingView(wp2);
  h.attach(wp2);
  const lt = new LayersFace({ history: h, tree: wp2.layerTree, tiles: wp2.layerTiles, port: doc, status: (m) => statuses.push(m) });
  _ctxs.push({ h });
  return { doc, wp2, h, lt, unrec: () => unrec, statuses };
}
const px = (r, g, b, a) => new Uint8ClampedArray([r, g, b, a]);
const readPx = (L, x, y) => Array.from(L.getImageData(x, y, 1, 1).data).join(",");   // eq 是严格 !== → 转字符串比对

describe("workpiece-layer-tree · 装配纪律（T5：History 编排器）", () => {
  it("未 attach 就 withPoint → throw；重复 attach → throw", () => {
    let unrec = 0;
    const h = new History({ maxQuotaBytes: 1 << 20, onUnrecoverable: () => { unrec++; } });
    const wp2 = new PaintingWorkpiece({ undo: h.stack, tree: { width: 64, height: 64 } });
    _ctxs.push({ h, wp2 });
    let threw = false;
    try { h.withPoint("x", {}, () => {}); } catch { threw = true; }
    assert(threw, "未 attach 的 withPoint 必须 throw");
    h.attach(wp2);
    assert(h.withPoint("x", {}, () => {}).ok, "attach 后 withPoint 可用（空 fn 不占步）");
    let threw2 = false;
    try { h.attach(wp2); } catch { threw2 = true; }
    assert(threw2, "重复 attach 必须 throw");
    eq(unrec, 0, "全程无不可恢复");
  });
});

describe("workpiece-layer-tree · addLayer（创建即记账）", () => {
  it("add(微步) → 同 token 填像素 → 封口 → undo 摘层回 prevActive → redo 连像素恢复", () => {
    const { doc, h, lt, unrec } = mk();
    const base = doc.activeLayer;
    const a = lt.addLayer("导入测试", { checkpoint: false });   // v2 合规形：加层+像素同一个整点
    assert(a.ok, "addLayer ok");
    const L = a.layer;
    eq(doc.activeLayer.id, L.id, "新层为 active");
    L.pixels.putRegion(7, 7, 1, 1, px(9, 8, 7, 255));   // token 开着 → 写时扣押收进同一步
    h.sealCheckpoint();
    eq(countViewLeaves(doc.layers), 2, "两叶");
    h.undo();
    eq(countViewLeaves(doc.layers), 1, "undo 摘层");
    eq(doc.activeLayer.id, base.id, "active 回创建前");
    h.redo();
    eq(countViewLeaves(doc.layers), 2, "redo 恢复层");
    const L2 = flattenViewLeaves(doc.layers).find((x) => x.name === "导入测试");
    assert(L2, "redo 后层还在");
    eq(readPx(L2, 7, 7), "9,8,7,255", "redo 连像素恢复");
    eq(unrec(), 0, "全程无不可恢复");
  });

  it("checkpoint:false 微步与后续步封成一个整点（v0.7.41 import 单整点语义）", () => {
    const { doc, h, lt } = mk();
    lt.addLayer("微步层", { checkpoint: false });
    const L = doc.activeLayer;
    lt.setLayerProp(L.id, "opacity", 0.5);   // 默认封口 → [addLayer, prop] 一个整点
    eq(countViewLeaves(doc.layers), 2, "加层生效");
    h.undo();
    eq(countViewLeaves(doc.layers), 1, "一次 undo 整包消失（含加层）");
  });
});

describe("workpiece-layer-tree · duplicateNode", () => {
  it("复制叶含像素 → undo/redo 往返", () => {
    const { doc, h, lt } = mk();
    const src = doc.activeLayer;
    seedWrite(src, () => src.pixels.putRegion(3, 3, 1, 1, px(1, 2, 3, 255)));   // 基线内容（种子，不入 undo——C7 硬化后走显式态）
    const a = lt.duplicateNode(src.id);
    assert(a.ok, "duplicate ok");
    eq(readPx(a.layer, 3, 3), "1,2,3,255", "像素已复制");
    h.undo();
    eq(countViewLeaves(doc.layers), 1, "undo 摘复制层");
    eq(doc.activeLayer.id, src.id, "active 回源层");
    h.redo();
    eq(countViewLeaves(doc.layers), 2, "redo 恢复");
  });
  it("复制组：递归深拷含像素 → undo/redo 往返", () => {
    const { doc, h, lt } = mk();
    const leaf = doc.activeLayer;
    seedWrite(leaf, () => leaf.pixels.putRegion(2, 2, 1, 1, px(5, 6, 7, 255)));
    const g = lt.addGroup("组");
    assert(g.ok, "建组");
    assert(lt.moveIntoGroup(leaf.id, g.groupId, {}).ok, "叶移入");
    const r = lt.duplicateNode(g.groupId);
    assert(r.ok, "组可复制");
    assert(r.layer.isGroup, "副本是组");
    eq(r.layer.name, "组", "名字照抄原名（与叶 duplicate 一致不改名）");
    eq(countViewLeaves(doc.layers), 2, "副本带出组内叶");
    eq(readPx(r.layer.children[0], 2, 2), "5,6,7,255", "后代叶像素已复制");
    h.undo();
    eq(countViewLeaves(doc.layers), 1, "undo 摘副本组");
    h.redo();
    eq(countViewLeaves(doc.layers), 2, "redo 恢复");
  });
  it("复制缺失 id → {ok:false,'missing'}", () => {
    const { lt } = mk();
    eq(lt.duplicateNode(99999).msg, "missing", "reason 透传");
  });
});

describe("workpiece-layer-tree · removeLayer / deleteGroup", () => {
  it("最后一张叶 keep-one 守卫拒删", () => {
    const { doc, lt } = mk();
    const st = lt.removeLayer(doc.activeLayer.id, doc.activeLayer.name);
    eq(st.ok, false, "拒绝");
    eq(countViewLeaves(doc.layers), 1, "层还在");
  });
  it("deleteGroup 删到 0 叶自动补空层；undo 树整还原", () => {
    const { doc, h, lt } = mk();
    // 唯一叶移进组 → 删组 = 删到 0 叶
    const leafId = doc.activeLayer.id;   // addGroup 会把 active 设为组本身 → 先记叶 id
    const g = lt.addGroup("组");
    assert(g.ok, "建组");
    const gid = g.groupId;
    assert(lt.moveIntoGroup(leafId, gid, {}).ok, "移入");
    const st = lt.deleteGroup(gid, { undoStatus: "恢复组", redoStatus: "删除组" });
    assert(st.ok, "删组 ok");
    eq(countViewLeaves(doc.layers), 1, "补了空层");
    assert(!doc.layers.some((n) => n.isGroup), "组已删");
    h.undo();
    assert(doc.layers.some((n) => n.id === gid), "undo 组回来了");
    h.redo();
    assert(!doc.layers.some((n) => n.isGroup), "redo 再删");
  });
});

describe("workpiece-layer-tree · 组合动词 + hint 文案", () => {
  it("addGroup 失败路径外栈不动；statuses 经 step.hint 报状态栏", () => {
    const { doc, h, lt, statuses } = mk();
    const d0 = h.depth;
    const r = lt.addGroup("甲组", { undoStatus: "撤甲组", redoStatus: "重甲组" });
    assert(r.ok, "ok");
    eq(h.depth, d0 + 1, "入栈一步");
    h.undo();
    assert(!doc.layers.some((n) => n.isGroup), "undo 组消失");
    eq(statuses[statuses.length - 1], "撤甲组", "undo hint 文案");
    h.redo();
    assert(doc.layers.some((n) => n.isGroup), "redo 组回来");
    eq(statuses[statuses.length - 1], "重甲组", "redo hint 文案");
  });
  it("ungroup：children 提到原位；undo 还原", () => {
    const { doc, h, lt } = mk();
    const leafId = doc.activeLayer.id;
    const g = lt.addGroup("外组");
    assert(lt.moveIntoGroup(leafId, g.groupId, {}).ok, "移入");
    assert(lt.ungroup(g.groupId, {}).ok, "解组 ok");
    assert(!doc.layers.some((n) => n.isGroup), "组没了、叶提出来");
    eq(countViewLeaves(doc.layers), 1, "叶保留");
    h.undo();
    assert(doc.layers.some((n) => n.isGroup), "undo 组回来");
  });
  it("explodeLayer：叶同位替换成 n 叶，undo 原叶回来", () => {
    const { doc, h, lt } = mk();
    const src = doc.activeLayer;
    seedWrite(src, () => src.pixels.putRegion(0, 0, 1, 1, px(200, 0, 0, 255)));
    const parts = [
      { data: new Uint8ClampedArray([200, 0, 0, 255]), name: "红" },
      { data: new Uint8ClampedArray([0, 0, 0, 0]), name: "空" },
    ];
    const st = lt.explodeLayer(src.id, parts, { x: 0, y: 0, w: 1, h: 1 }, {});
    assert(st.ok, "explode ok");
    eq(countViewLeaves(doc.layers), 2, "两分片");
    assert(!flattenViewLeaves(doc.layers).some((l) => l.id === src.id), "原叶退场");
    h.undo();
    eq(countViewLeaves(doc.layers), 1, "undo 回单叶");
    eq(readPx(doc.activeLayer, 0, 0), "200,0,0,255", "原叶像素还在");
  });
  it("stampAll：新叶置顶 + 其余根级节点隐藏，一次 undo 全撤", () => {
    const { doc, h, lt } = mk();
    lt.addLayer("下层");
    const st = lt.stampAll("盖印 1", { bytes: px(7, 7, 7, 255), rect: { x: 0, y: 0, w: 1, h: 1 } }, {});
    assert(st.ok, "stamp ok");
    eq(doc.layers[doc.layers.length - 1].id, st.layer.id, "置顶");
    assert(doc.layers.filter((n) => n.id !== st.layer.id).every((n) => !n.visible), "其余全隐藏");
    h.undo();
    eq(countViewLeaves(doc.layers), 2, "undo 摘盖印层");
    assert(doc.layers.every((n) => n.visible), "可见性一次撤回");
  });
});

describe("workpiece-layer-tree · setLayerProp / clearLayer / moveLayer", () => {
  it("操作型 prop：undo/redo 值往返", () => {
    const { doc, h, lt } = mk();
    const L = doc.activeLayer;
    lt.setLayerProp(L.id, "visible", false);
    eq(L.visible, false, "生效");
    h.undo();
    eq(L.visible, true, "undo 回");
    h.redo();
    eq(L.visible, false, "redo 回");
  });
  it("拖动预览走 view 镜像（不碰 json），提交单账：undo 回拖动前", () => {
    const { doc, h, lt } = mk();
    const L = doc.activeLayer;
    L.opacity = 0.3;   // 拖动期实时写 view 镜像（json 未动 → record 天然是拖前根）
    const st = lt.setLayerProp(L.id, "opacity", 0.3);
    assert(st.ok, "提交记账 ok");
    h.undo();
    eq(doc.activeLayer.opacity, 1, "undo 回拖动前");
    h.redo();
    eq(doc.activeLayer.opacity, 0.3, "redo 回拖后");
  });
  it("clearLayer：undo 像素还原", () => {
    const { doc, h, lt } = mk();
    const L = doc.activeLayer;
    seedWrite(L, () => L.pixels.putRegion(5, 5, 1, 1, px(4, 5, 6, 255)));
    assert(lt.clearLayer(L.id).ok, "清空 ok");
    eq(readPx(L, 5, 5).split(",")[3], "0", "已清");
    h.undo();
    eq(readPx(L, 5, 5), "4,5,6,255", "undo 还原像素");
  });
  it("moveLayer 同级往返", () => {
    const { doc, h, lt } = mk();
    lt.addLayer("上层");
    const top = doc.activeLayer;
    assert(lt.moveLayer(top.id, -1).ok, "下移 ok");
    eq(doc.layers[0].id, top.id, "在底");
    h.undo();
    eq(doc.layers[1].id, top.id, "undo 回顶");
  });
});

// 测试卫生：统一释放（清栈 = record 驱逐 → tileset 引用计数归零还池；防 FR 泄漏 assert 刷屏）
describe("workpiece-layer-tree 收尾", () => {
  it("清栈释放本文件的 undo 包", () => {
    for (const { h } of _ctxs) h.clear();
    _ctxs.length = 0;
    assert(true, "disposed");
  });
});
