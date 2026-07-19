// UndoStack 游标/并发/释放语义（缺陷 E 回归）。
//
// 三条旧行为（v439 修），外加 v439 自己引入的三条回归（v440 修，见文件下半部）：
//   1. undo() 在 await handler **之前**就 this.index--。handler 抛了 → doc 半改、游标却已前移
//      → 下一次 undo 跳过一条，doc 与 history 从此错位。
//   2. handler 的错误被吞成 reportError(..., "log")（只进 console，UI 无感）。
//   3. removeLayer/mergeDown/selectionToLayer 的 handler 是 async（await createImageBitmap 会让出），
//      连按两次 Ctrl+Z 会让两个半应用的 handler 交错改同一个 doc。
// 外加 dispose 从来没有任何实现（契约里有、_dispose 三处调用），于是 treeStructure entry 持有的
// 离树图层活引用永远不放手。
import { describe, it, assert, eq } from "./runner.mjs";
import { UndoStack } from "../src/history.ts";

const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, resolve: r }; };

describe("UndoStack · 游标只在 handler 兑现后移动（缺陷 E）", () => {
  it("undo handler 抛错 → 游标不动、canUndo 仍为真（不假装撤销成功）", async () => {
    const h = new UndoStack();
    h.registerHandler("boom", { undo: () => { throw new Error("handler 炸了"); }, redo: () => {} });
    h.push({ type: "boom" });
    eq(h.index, 0, "push 后游标在 0");

    await h.undo();
    eq(h.index, 0, "handler 抛错 → 游标停在原位");
    assert(h.canUndo(), "仍可撤销（用户可重试；红条已告知失败）");
  });

  it("redo handler 抛错 → 游标不动", async () => {
    const h = new UndoStack();
    let boom = false;
    h.registerHandler("t", { undo: () => {}, redo: () => { if (boom) throw new Error("redo 炸"); } });
    h.push({ type: "t" });
    await h.undo();
    eq(h.index, -1, "撤销成功 → 游标退到 -1");
    boom = true;
    await h.redo();
    eq(h.index, -1, "redo 抛错 → 游标不动（不会误认为已重做）");
    assert(h.canRedo(), "仍可重做");
  });

  it("成功路径照旧：undo/redo 正常推进游标", async () => {
    const h = new UndoStack();
    const seen = [];
    h.registerHandler("t", { undo: (e) => seen.push("u" + e.n), redo: (e) => seen.push("r" + e.n) });
    h.push({ type: "t", n: 1 }); h.push({ type: "t", n: 2 });
    await h.undo(); await h.undo();
    eq(h.index, -1, "两次撤销到底");
    await h.redo(); await h.redo();
    eq(h.index, 1, "两次重做回顶");
    eq(seen.join(","), "u2,u1,r1,r2", "顺序正确");
  });
});

describe("UndoStack · async handler 不交错（_busy 闩）", () => {
  it("连按两次 Ctrl+Z：第二次被丢弃，绝不与第一次交错改 doc", async () => {
    const h = new UndoStack();
    const d = defer();
    const log = [];
    h.registerHandler("slow", {
      undo: async (e) => { log.push("enter" + e.n); await d.p; log.push("exit" + e.n); },
      redo: () => {},
    });
    h.push({ type: "slow", n: 1 }); h.push({ type: "slow", n: 2 });

    const first = h.undo();          // 进入 handler、卡在 await
    const second = h.undo();         // 第二次按键：应被闩挡掉
    d.resolve();
    await Promise.all([first, second]);

    eq(log.join(","), "enter2,exit2", "只跑了一个 handler，没有 enter2,enter1 交错");
    eq(h.index, 0, "只撤销了一步");
  });

  it("闩释放后可继续撤销（不是把栈锁死）", async () => {
    const h = new UndoStack();
    h.registerHandler("t", { undo: async () => {}, redo: () => {} });
    h.push({ type: "t" }); h.push({ type: "t" });
    await h.undo();
    await h.undo();
    eq(h.index, -1, "闩只挡并发，不挡串行");
  });
});

describe("UndoStack · dispose 释放（缺陷 E：契约有、实现无）", () => {
  it("超出 max 被淘汰的 entry 会 dispose", () => {
    const h = new UndoStack({ max: 2 });
    const disposed = [];
    h.registerHandler("t", { undo: () => {}, redo: () => {}, dispose: (e) => disposed.push(e.n) });
    h.push({ type: "t", n: 1 }); h.push({ type: "t", n: 2 }); h.push({ type: "t", n: 3 });
    eq(disposed.join(","), "1", "最老的一条被淘汰即释放");
    eq(h.entries.length, 2, "栈长受 max 限制");
  });

  it("被 redo 段截断的 entry 会 dispose", async () => {
    const h = new UndoStack();
    const disposed = [];
    h.registerHandler("t", { undo: () => {}, redo: () => {}, dispose: (e) => disposed.push(e.n) });
    h.push({ type: "t", n: 1 }); h.push({ type: "t", n: 2 });
    await h.undo();                       // 游标退到 0，n=2 进入 redo 段
    h.push({ type: "t", n: 3 });          // 新动作 → 截断 redo 段
    eq(disposed.join(","), "2", "被截断的 n=2 释放");
  });

  it("clear() 释放全部（切文档时别把上一张画的图层引用钉住）", () => {
    const h = new UndoStack();
    const disposed = [];
    h.registerHandler("t", { undo: () => {}, redo: () => {}, dispose: (e) => disposed.push(e.n) });
    h.push({ type: "t", n: 1 }); h.push({ type: "t", n: 2 });
    h.clear();
    eq(disposed.join(","), "1,2", "全部释放");
    eq(h.index, -1, "游标复位");
  });
});

describe("UndoStack · push 时校验 entry 契约", () => {
  it("validate 返回错误 → 仍入栈（doc 已改，不能假装没发生），但会报出来", () => {
    const h = new UndoStack();
    h.registerHandler("t", { undo: () => {}, redo: () => {}, validate: (e) => (e.ok ? null : "缺 ok 字段") });
    h.push({ type: "t", ok: true });
    eq(h.entries.length, 1, "合契约的正常入栈");
    h.push({ type: "t" });                 // 不合契约
    eq(h.entries.length, 2, "仍入栈——doc 已经改过了，丢掉 entry 只会让状态更不一致");
  });

  it("没有 validate 的 handler 照常工作（可选契约）", () => {
    const h = new UndoStack();
    h.registerHandler("t", { undo: () => {}, redo: () => {} });
    h.push({ type: "t" });
    eq(h.entries.length, 1, "无 validate 不影响");
  });
});

// ---------------------------------------------------------------------------
// v440：v439 自身引入的回归（R1/R2/R3）。这三条都是"修 E 时改法本身"制造的新伤。
// ---------------------------------------------------------------------------

describe("UndoStack · async 期间的外部改动（R1/R2 回归）", () => {
  it("R1：async undo 在途时 clear() → 闩不卡死，后续 undo/redo 仍可用", async () => {
    const h = new UndoStack();
    const d = defer();
    h.registerHandler("slow", { undo: async () => { await d.p; }, redo: () => {} });
    // **三条**：让 i-1 != -1，否则 clear 后的 index 恰好与 handler 写回值撞巧一致，测不出问题
    h.push({ type: "slow" }); h.push({ type: "slow" }); h.push({ type: "slow" });

    const inflight = h.undo();      // 撤销 index=2 那条，卡在 await
    h.clear();                      // 切文档：entries 清空、index=-1
    d.resolve();
    await inflight;

    // 在途 handler 恢复后绝不能在空栈上恢复出正索引
    assert(h.index === -1, `clear 后游标必须仍是 -1，实得 ${h.index}`);
    assert(!h.canUndo(), "空栈不可撤销");

    // 闩必须已释放：新文档里推一条并撤销，要真的跑起来
    let ran = false;
    h.registerHandler("t", { undo: () => { ran = true; }, redo: () => {} });
    h.push({ type: "t" });
    await h.undo();
    assert(ran, "clear 之后 undo 必须仍然可用（_busy 卡死会让它永远不跑）");
  });

  it("R1b：entries[index] 缺失时不得抛出逃逸异常（否则 finally 不跑、闩永久卡死）", async () => {
    const h = new UndoStack();
    h.registerHandler("t", { undo: () => {}, redo: () => {} });
    h.push({ type: "t" });
    // 人为制造 index 与 entries 失配（R1 的真实成因是 clear/async 竞态，这里直接构造该状态）
    h.entries.length = 0;
    // 不应抛；应安全退出并保持闩可用
    await h.undo();
    let ran = false;
    h.registerHandler("u", { undo: () => { ran = true; }, redo: () => {} });
    h.push({ type: "u" });
    await h.undo();
    assert(ran, "失配后闩仍须可用");
  });

  it("R2：async undo 在途时 push() → 游标一致，redo 不双重应用", async () => {
    const h = new UndoStack();
    const d = defer();
    const applied = [];
    h.registerHandler("slow", { undo: async () => { await d.p; applied.push("undo-slow"); }, redo: () => applied.push("redo-slow") });
    h.registerHandler("stroke", { undo: () => applied.push("undo-stroke"), redo: () => applied.push("redo-stroke") });

    h.push({ type: "slow" });                 // index 0
    const inflight = h.undo();                // 撤销它，卡在 await
    h.push({ type: "stroke" });               // 期间用户画了一笔（已应用到 doc）
    d.resolve();
    await inflight;

    // 承重：新笔画是最后一条**已应用**的动作，游标必须指着它，而不是被拽回去
    const top = h.entries[h.index];
    assert(top && top.type === "stroke",
      `游标必须停在已应用的 stroke 上，实得 ${top ? top.type : "(空)"} @index=${h.index}`);
    assert(!h.canRedo(), "已应用的 stroke 不该躺在 redo 段里（否则 Ctrl+Y 会双重应用）");
  });
});

describe("UndoStack · 缺 handler 不得锁死更老的历史（R3 回归）", () => {
  it("无 handler 的 entry 被跳过，之前的历史仍可达", async () => {
    const h = new UndoStack();
    let older = false;
    h.registerHandler("known", { undo: () => { older = true; }, redo: () => {} });
    h.push({ type: "known" });        // index 0 —— 更老的一条
    h.push({ type: "orphan" });       // index 1 —— 没有注册 handler

    await h.undo();                   // 撞上 orphan：应报错但**跳过**
    await h.undo();                   // 应能撤销到 known
    assert(older, "无 handler 的 entry 不得把它之前的历史永久锁死");
    assert(h.index === -1, `应已撤到底，实得 index=${h.index}`);
  });
});

describe("UndoStack · 字节上限驱逐（R11：离树像素被钉在栈里）", () => {
  it("总重量超上限 → 从最老的开始淘汰（并 dispose）", () => {
    const h = new UndoStack({ max: 50, maxBytes: 100 });
    const disposed = [];
    h.registerHandler("t", {
      undo: () => {}, redo: () => {},
      weight: (e) => e.bytes,
      dispose: (e) => disposed.push(e.n),
    });
    h.push({ type: "t", n: 1, bytes: 60 });
    h.push({ type: "t", n: 2, bytes: 60 });   // 合计 120 > 100 → 淘汰最老的 n=1
    eq(disposed.join(","), "1", "最老的被淘汰");
    eq(h.entries.length, 1, "只剩一条");
    eq(h.index, 0, "游标随之调整");
  });

  it("永不淘汰到空（至少留最后一条，哪怕它自己就超标）", () => {
    const h = new UndoStack({ max: 50, maxBytes: 10 });
    h.registerHandler("t", { undo: () => {}, redo: () => {}, weight: (e) => e.bytes });
    h.push({ type: "t", bytes: 999 });
    eq(h.entries.length, 1, "单条超标也保留——否则刚做的这步立刻不可撤销");
  });

  it("没有 weight 的 handler 记 0（不影响既有类型）", () => {
    const h = new UndoStack({ max: 50, maxBytes: 10 });
    h.registerHandler("t", { undo: () => {}, redo: () => {} });
    for (let i = 0; i < 5; i++) h.push({ type: "t" });
    eq(h.entries.length, 5, "无 weight → 不触发字节淘汰");
  });

  it("默认无字节上限（不传 maxBytes 时行为不变）", () => {
    const h = new UndoStack({ max: 50 });
    h.registerHandler("t", { undo: () => {}, redo: () => {}, weight: () => 1e9 });
    h.push({ type: "t" }); h.push({ type: "t" });
    eq(h.entries.length, 2, "不传上限就不淘汰");
  });
});
