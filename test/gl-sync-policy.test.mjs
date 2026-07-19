// GL 全量同步判定（缺陷 D 回归）—— 结构脏不可被 live-preview 推迟。
//
// 缺陷 D：`markContentDirty()` 一个标志位同时表达两种语义——「像素变了」（描边中可以安全推迟，
// live stamp 走 GPU overlay、CPU tile 尚未变）与「图层树结构变了」（**不可**推迟：新叶子不进
// _layerTiles，下一帧 _composite 就抛 LAYER_NOT_SYNCED）。二者一起被 `!livePreview` 挡掉。
//
// 而 board._isLivePreview() 在**整个浮层生命期**为真（自由变换活着就一直真，不只描边那一瞬）。
// 于是「自由变换进行中删个图层 / 新建图层」→ 每帧抛错 + 画布冻结，直到浮层结束。
// 真机报的 `uncaught error layer not synced:92` 就是这条。
import { describe, it, assert } from "./runner.mjs";
import { shouldSyncAll } from "../src/gl/gl-board.ts";

// 真值表：4 个 bool → 16 行。承重行 = structureDirty && livePreview 必须 true。
const B = [false, true];

describe("shouldSyncAll · 结构脏 ⟂ live-preview（缺陷 D）", () => {
  it("★承重：结构脏在 live-preview 期间也必须同步（否则合成抛 LAYER_NOT_SYNCED）", () => {
    for (const contentDirty of B) for (const forceSync of B) {
      assert(shouldSyncAll(contentDirty, true, true, forceSync) === true,
        `structureDirty 必须无条件同步（content=${contentDirty} force=${forceSync}）`);
    }
  });

  it("像素脏在 live-preview 期间照旧推迟（保住描边热路径不重传）", () => {
    assert(shouldSyncAll(true, false, true, false) === false,
      "只有像素脏 + 描边/浮层中 → 不同步（live stamp 走 overlay，抬笔 commit 后才传）");
    assert(shouldSyncAll(true, false, false, false) === true,
      "像素脏 + 非 live → 同步");
  });

  it("forceSync 压过 live-preview 门控（自由变换 lift 那帧的挖洞同步）", () => {
    assert(shouldSyncAll(false, false, true, true) === true, "forceSync 无条件同步");
  });

  it("全干净 → 不同步（pan/zoom 只 present 缓存，零重传）", () => {
    assert(shouldSyncAll(false, false, false, false) === false, "无脏无 force → 不同步");
    assert(shouldSyncAll(false, false, true, false) === false, "live 中但无脏 → 不同步");
  });

  it("完整 16 行真值表 == structureDirty || forceSync || (contentDirty && !livePreview)", () => {
    for (const c of B) for (const s of B) for (const lp of B) for (const f of B) {
      const want = s || f || (c && !lp);
      assert(shouldSyncAll(c, s, lp, f) === want,
        `(content=${c}, structure=${s}, live=${lp}, force=${f}) 应为 ${want}`);
    }
  });
});

// v440：补上计划里欠的第二条 —— board 两个 invalidate 入口的**接线**测试。
// （v439 只写了 shouldSyncAll 的纯真值表，没验证 board 侧到底把哪个信号送给了 GL。
//  分类错了照样会复发缺陷 D，而真值表全绿也发现不了。）
describe("board invalidate 接线（缺陷 D 的另一半）", () => {
  // 只造一个假 _glBoard，直接调 Board.prototype 上的两个方法——避免构造真 Board（需要 DOM canvas）。
  function probe() {
    const hits = [];
    const self = {
      _compositeCacheDirty: false,
      _glBoard: {
        markContentDirty: () => hits.push("content"),
        markStructureDirty: () => hits.push("structure"),
      },
      requestRender: () => hits.push("render"),
    };
    return { self, hits };
  }

  it("invalidateStructure() → markStructureDirty（不可被 livePreview 推迟的那条）", async () => {
    const { Board } = await import("../src/board.ts");
    const { self, hits } = probe();
    Board.prototype.invalidateStructure.call(self);
    assert(hits.includes("structure"), "必须送结构脏");
    assert(!hits.includes("content"), "不该只送内容脏");
    assert(self._compositeCacheDirty === true, "合成缓存作废");
    assert(hits.includes("render"), "请求重绘");
  });

  it("invalidateAll() → 只 markContentDirty（描边热路径仍可延迟）", async () => {
    const { Board } = await import("../src/board.ts");
    const { self, hits } = probe();
    Board.prototype.invalidateAll.call(self);
    assert(hits.includes("content"), "送内容脏");
    assert(!hits.includes("structure"),
      "绝不能顺手升级成结构脏——那会让每次描边 commit 都强制全量 syncAll");
    assert(self._compositeCacheDirty === true, "合成缓存作废");
  });
});
