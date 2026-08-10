// LayerTiles（T2，ADR-0008）：写时扣押 collector / Krita memento（同 token 中间产物弃置）/
// verbs / no-op 守卫（pixel-tx-noop 后继）/ computed 白名单 + 双捕获断言 + flip→undo→逐字节等原图锚 /
// tokenBeforeImage（选区 finalize 的 pre 物化）/ record dispose 释放句柄。
import { describe, it, assert, eq } from "./runner.mjs";
import { UndoStack } from "../src/backend/workpiece/undo-stack.ts";
import { PaintingWorkpiece } from "../src/backend/workpiece/painting-workpiece.ts";
import { LayerPixels } from "../src/backend/tiles/tile-layer.ts";

// 玩具 host：map 背 LayerPixels（T2 app 里是 doc 树；本测试关心组件本体）。
function mkHost(docW = 96, docH = 96) {
  const layers = new Map();   // id → LayerPixels
  const host = {
    getPixels: (id) => layers.get(id) ?? null,
    findLayerIdByPixels: (lp) => { for (const [id, p] of layers) if (p === lp) return id; return null; },
    eachLayer: (cb) => { for (const [id, p] of layers) cb(id, p); },
    replacePixels: (id, np) => { const old = layers.get(id); layers.set(id, np); old?.dispose(); },
    add: (id) => { const lp = new LayerPixels(docW, docH); layers.set(id, lp); return lp; },
    dispose: () => { for (const [, p] of layers) p.dispose(); layers.clear(); },
  };
  return host;
}

function mk(opts = {}) {
  const undo = new UndoStack({ maxQuotaBytes: opts.maxQuotaBytes ?? (1 << 30) });
  const host = mkHost();
  const wp = new PaintingWorkpiece({ undo, host, onTokenLeak: () => {} });
  return { undo, host, wp, tiles: wp.layerTiles };
}

const solid = (w, h, v) => new Uint8ClampedArray(w * h * 4).fill(v);

describe("LayerTiles · 写时扣押", () => {
  it("令牌开着直写 layer 像素 → 自动登记 + 一步入栈；undo/redo 逐字节", () => {
    const { undo, host, wp } = mk();
    const lp = host.add(1);
    const t = wp.begin("stroke");
    lp.putRegion(10, 10, 8, 8, solid(8, 8, 200));   // 直写 substrate（engine 路径），无需过 verb
    t.commit();
    eq(undo.depth(), 1, "collector 打包一步");
    const painted = lp.getRegion(0, 0, 96, 96);
    undo.undo();
    assert(lp.getRegion(0, 0, 96, 96).every((v) => v === 0), "undo 回空");
    undo.redo();
    const after = lp.getRegion(0, 0, 96, 96);
    assert(after.every((v, i) => v === painted[i]), "redo 逐字节等画后");
    host.dispose(); undo.clear();
  });

  it("Krita memento：同 token 同 tile 多次换手 → 只留令牌前原件", () => {
    const { undo, host, wp } = mk();
    const lp = host.add(1);
    let t = wp.begin(); lp.putRegion(0, 0, 4, 4, solid(4, 4, 50)); t.commit();   // 原件 = 50
    t = wp.begin();
    lp.putRegion(0, 0, 4, 4, solid(4, 4, 100));
    lp.putRegion(0, 0, 4, 4, solid(4, 4, 150));   // 中间产物 100 被正常 release，不进 record
    t.commit();
    eq(undo.depth(), 2);
    eq(lp.sampleAt(1, 1)[0], 150);
    undo.undo();
    eq(lp.sampleAt(1, 1)[0], 50, "undo 一步跳回令牌前原件（不是中间产物 100）");
    undo.redo();
    eq(lp.sampleAt(1, 1)[0], 150);
    host.dispose(); undo.clear();
  });

  it("no-op 守卫（v0.6.17 同族）：applyRegionDiff 无实质变化 → 零收集 → 不占 undo 步", () => {
    const { undo, host, wp } = mk();
    const lp = host.add(1);
    let t = wp.begin(); lp.putRegion(0, 0, 4, 4, solid(4, 4, 80)); t.commit();
    t = wp.begin();
    lp.applyRegionDiff(0, 0, 4, 4, solid(4, 4, 80));   // 同字节 → diff 零封装
    t.commit();
    eq(undo.depth(), 1, "no-op 笔画不占步");
    host.dispose(); undo.clear();
  });

  it("cancel：倒序回滚无痕 + 不入栈", () => {
    const { undo, host, wp } = mk();
    const lp = host.add(1);
    let t = wp.begin(); lp.putRegion(0, 0, 4, 4, solid(4, 4, 60)); t.commit();
    t = wp.begin();
    lp.putRegion(0, 0, 4, 4, solid(4, 4, 220));
    lp.clear();
    t.cancel();
    eq(lp.sampleAt(1, 1)[0], 60, "cancel 回令牌前");
    eq(undo.depth(), 1);
    host.dispose(); undo.clear();
  });

  it("无令牌直写：不收集不记账（T2 迁移期合法；旧 operator 自带快照）", () => {
    const { undo, host } = mk();
    const lp = host.add(1);
    lp.putRegion(0, 0, 4, 4, solid(4, 4, 99));   // 令牌关着 → 观察者忽略
    eq(undo.depth(), 0);
    eq(lp.sampleAt(0, 0)[0], 99);
    host.dispose(); undo.clear();
  });

  it("临时 LayerPixels（token 内建又弃）：seal 解析不到身份 → 扣押作废不入 record", () => {
    const { undo, host, wp } = mk();
    host.add(1);
    const t = wp.begin();
    const tmp = new LayerPixels(32, 32);   // host 之外的实例
    tmp.putRegion(0, 0, 4, 4, solid(4, 4, 10));
    tmp.dispose();
    t.commit();
    eq(undo.depth(), 0, "非权威实例的写不成步");
    host.dispose(); undo.clear();
  });
});

describe("LayerTiles · verbs 与 token 内读口", () => {
  it("putRegion/editRegion/clearLayer/replaceLayer verbs + 无令牌 verb → throw", () => {
    const { undo, host, wp, tiles } = mk();
    host.add(1);
    let threw = false;
    try { tiles.putRegion(1, 0, 0, 2, 2, solid(2, 2, 5)); } catch { threw = true; }
    assert(threw, "无令牌 verb 应被拒");
    let t = wp.begin();
    tiles.putRegion(1, 0, 0, 4, 4, solid(4, 4, 40));
    tiles.editRegion(1, { x: 0, y: 0, w: 2, h: 2 }, (buf) => { buf.fill(255); });
    t.commit();
    eq(tiles.getRegion(1, 0, 0, 1, 1)[0], 255);
    eq(tiles.getRegion(1, 3, 3, 1, 1)[0], 40);
    t = wp.begin(); tiles.replaceLayer(1, solid(2, 2, 7), { x: 8, y: 8, w: 2, h: 2 }); t.commit();
    eq(tiles.getRegion(1, 0, 0, 1, 1)[3], 0, "replaceLayer 先清");
    eq(tiles.getRegion(1, 8, 8, 1, 1)[0], 7);
    t = wp.begin(); tiles.clearLayer(1); t.commit();
    assert(tiles.contentBounds(1) === null, "清空");
    undo.undo();   // 撤 clear
    eq(tiles.getRegion(1, 8, 8, 1, 1)[0], 7, "clear 可撤");
    host.dispose(); undo.clear();
  });

  it("tokenChanged/tokenBeforeImage：pre 物化 = 令牌前内容（选区 finalize 的粮）", () => {
    const { undo, host, wp, tiles } = mk();
    const lp = host.add(1);
    let t = wp.begin(); lp.putRegion(4, 4, 4, 4, solid(4, 4, 120)); t.commit();
    t = wp.begin();
    assert(!tiles.tokenChanged(1), "未写 → false");
    lp.putRegion(4, 4, 4, 4, solid(4, 4, 240));
    assert(tiles.tokenChanged(1));
    const pre = tiles.tokenBeforeImage(1);
    assert(pre.imageData, "pre 有内容");
    // pre 是令牌前的 120，而层上已是 240
    const px = pre.imageData.data[((4 - pre.bboxY) * pre.bboxW + (4 - pre.bboxX)) * 4];
    eq(px, 120, "pre = 令牌前字节");
    eq(lp.sampleAt(5, 5)[0], 240, "层上是新值");
    t.commit();
    host.dispose(); undo.clear();
  });

  it("读口：version 单调 / tiles 迭代身份 / contentBounds / getRegion", () => {
    const { undo, host, wp, tiles } = mk();
    const lp = host.add(1);
    const v0 = tiles.version(1);
    const t = wp.begin(); lp.putRegion(0, 0, 4, 4, solid(4, 4, 9)); t.commit();
    assert(tiles.version(1) > v0, "version 动了");
    const list = [...tiles.tiles(1)];
    eq(list.length, 1);
    assert(typeof list[0].contentId === "number" && list[0].bytes().length > 0);
    const b = tiles.contentBounds(1, true);
    eq(b.w, 4); eq(b.h, 4);
    host.dispose(); undo.clear();
  });
});

describe("LayerTiles · computed 白名单", () => {
  it("锚：flipHorizontalAll → undo → 逐字节等原图；redo 再翻", () => {
    const { undo, host, wp, tiles } = mk();
    const lp = host.add(1);
    let t = wp.begin();
    const patt = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) { patt[i * 4] = i * 10; patt[i * 4 + 3] = 255; }
    lp.putRegion(3, 5, 4, 4, patt);
    t.commit();
    const orig = host.getPixels(1).getRegion(0, 0, 96, 96);
    t = wp.begin(); tiles.flipHorizontalAll(); t.commit();
    const flipped = host.getPixels(1).getRegion(0, 0, 96, 96);
    assert(!flipped.every((v, i) => v === orig[i]), "翻转真的变了");
    undo.undo();
    const back = host.getPixels(1).getRegion(0, 0, 96, 96);
    assert(back.every((v, i) => v === orig[i]), "锚：flip→undo→逐字节等原图");
    undo.redo();
    const again = host.getPixels(1).getRegion(0, 0, 96, 96);
    assert(again.every((v, i) => v === flipped[i]), "redo 等翻转图");
    host.dispose(); undo.clear();
  });

  it("rot90 对合：CCW→undo→原图；offsetWrap 逆平移", () => {
    const { undo, host, wp, tiles } = mk();
    const lp = host.add(1);
    let t = wp.begin(); lp.putRegion(0, 0, 2, 1, new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255])); t.commit();
    const orig = host.getPixels(1).getRegion(0, 0, 96, 96);
    t = wp.begin(); tiles.rotate90All(1); t.commit();
    undo.undo();
    assert(host.getPixels(1).getRegion(0, 0, 96, 96).every((v, i) => v === orig[i]), "rot undo 还原");
    t = wp.begin(); tiles.offsetWrapAll(10, 20); t.commit();
    eq(host.getPixels(1).sampleAt(10, 20)[0], 1, "平移到位");
    undo.undo();
    assert(host.getPixels(1).getRegion(0, 0, 96, 96).every((v, i) => v === orig[i]), "offset undo 还原");
    host.dispose(); undo.clear();
  });

  it("双捕获断言：computed verb 与 tile 收集同 token 并存 → throw", () => {
    const { undo, host, wp, tiles } = mk();
    const lp = host.add(1);
    const t = wp.begin();
    lp.putRegion(0, 0, 2, 2, solid(2, 2, 33));   // 先有收集
    let threw = false;
    try { tiles.flipHorizontalAll(); } catch { threw = true; }
    assert(threw, "computed verb 前已有收集 → throw");
    t.cancel();
    host.dispose(); undo.clear();
  });
});
