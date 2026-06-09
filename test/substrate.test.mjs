// Substrate 底座验收（L4 ①）：编辑游标 + push-serialize。coalescer 另由 store-coalescer.test 覆盖（经 store.session）。
import { describe, it, eq, assert } from "./runner.mjs";
import { createSubstrate, toU8, bytesEqual } from "../src/store/substrate.ts";

const defer = () => { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };   // run() 经 prev.then 排在微任务，非同步启动

describe("substrate · edits 游标", () => {
  it("mark 推进；markSaved 后 localDirty 复位；再 mark 又脏", () => {
    const { edits } = createSubstrate();
    eq(edits.localDirty(), false);
    edits.mark(); edits.mark();
    eq(edits.version(), 2);
    assert(edits.localDirty(), "mark 后应 dirty");
    edits.markSaved();
    eq(edits.localDirty(), false);
    edits.mark();
    assert(edits.localDirty(), "再 mark 应 dirty");
  });
  it("markSaved(v) 可显式记某游标", () => {
    const { edits } = createSubstrate();
    edits.mark(); edits.mark();          // version=2
    edits.markSaved(1);                  // 标「已存到 v1」
    assert(edits.localDirty(), "saved=1 < version=2 → dirty");
  });
});

describe("substrate · serialize（B1 同名串行）", () => {
  it("同一 name：第二个等第一个跑完才启动", async () => {
    const { serialize } = createSubstrate();
    const order = []; const d1 = defer();
    const p1 = serialize("a", async () => { order.push("a1-start"); await d1.p; order.push("a1-end"); });
    const p2 = serialize("a", async () => { order.push("a2-start"); });
    await flush();                       // 让 a1 启动（微任务），a2 仍排在它后面
    eq(order.join(","), "a1-start");     // a2 还没启动
    d1.resolve(); await p1; await p2;
    eq(order.join(","), "a1-start,a1-end,a2-start");
  });
  it("不同 name：并行，不互相阻塞", async () => {
    const { serialize } = createSubstrate();
    const order = []; const dA = defer();
    const pA = serialize("a", async () => { await dA.p; order.push("a"); });
    const pB = serialize("b", async () => { order.push("b"); });
    await pB;
    eq(order.join(","), "b");            // b 没等 a
    dA.resolve(); await pA;
    eq(order.join(","), "b,a");
  });
  it("前一个抛错不卡死后一个（then(fn,fn)）", async () => {
    const { serialize } = createSubstrate();
    let ran2 = false;
    const p1 = serialize("a", async () => { throw new Error("boom"); });
    const p2 = serialize("a", async () => { ran2 = true; });
    await p1.catch(() => {}); await p2;
    assert(ran2, "前一个失败后，后一个仍应跑");
  });
});

describe("substrate · serialize2（rename 牵两身份）", () => {
  it("串在 old 与 new 两条链尾", async () => {
    const { serialize, serialize2 } = createSubstrate();
    const order = []; const dOld = defer();
    const pOld = serialize("old", async () => { await dOld.p; order.push("old-write"); });
    const pRen = serialize2("old", "new", async () => { order.push("rename"); });
    eq(order.join(","), "");             // rename 等 old 的 in-flight 写
    dOld.resolve(); await pOld; await pRen;
    eq(order.join(","), "old-write,rename");
  });
});

describe("substrate · byte utils", () => {
  it("toU8 各类型 → Uint8Array；bytesEqual 逐字节", async () => {
    eq((await toU8(null)).length, 0);
    const u = await toU8("hi");
    assert(u instanceof Uint8Array && u.length === 2, "string→u8");
    eq((await toU8(new ArrayBuffer(3))).length, 3);
    assert(bytesEqual(await toU8("ab"), await toU8("ab")), "相等");
    assert(!bytesEqual(await toU8("ab"), await toU8("ac")), "不等");
  });
});
