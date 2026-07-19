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
