// C4：多 tab 同浏览器并发编辑——base-etag 归属验收。
// 两个 store 实例 = 两个 tab：共享同一 MockCloudProvider（同一 OneDrive）+ 同一 memLS（同一 localStorage），
// 但各持自己的内存 base。验证陈旧 tab 的推被 412 拦下，不静默覆盖（W2 / ADR-0009 红线）。
import { describe, it, eq } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { createStore } from "../src/store/store.js";
import { memLS, graphFromProvider, blobText } from "./helpers.mjs";

globalThis.localStorage = globalThis.localStorage || memLS();
const cloud = await import("../src/cloud.js");
const fastSleep = () => Promise.resolve();
const enc = (s) => () => new TextEncoder().encode(s);
const srvBytes = async (mock, path) => blobText(await mock.download((await mock.getItemByPath(path)).id));

// 一套共享后端（云 + LS），两个 tab 的 Store
function twoTabs() {
  globalThis.localStorage.clear();
  const mock = createMockProvider();
  cloud.__setGraph(graphFromProvider(mock));
  cloud.__setSignedIn(() => true);
  const tabA = createStore({ cloud, sleep: fastSleep, backoffMs: 0 });
  const tabB = createStore({ cloud, sleep: fastSleep, backoffMs: 0 });
  return { mock, tabA, tabB };
}

describe("C4 多 tab base-etag", () => {
  it("修复：两 tab 各自 adoptBase 同一基准 → 陈旧 tab 推被 412 拦，不覆盖", async () => {
    const { mock, tabA, tabB } = twoTabs();
    await tabA.flow.push("画", { encode: enc("v0") });      // 建云端，etag = E1
    const e1 = cloud.getKnownETag("画");
    // 两个 tab 都"在 E1 这一刻打开" → 各自把 base 捕获进自己内存
    tabA.adoptBase("画", e1);
    tabB.adoptBase("画", e1);

    const rA = await tabA.flow.push("画", { encode: enc("vA") });
    eq(rA.status, "pushed", "A 基于 E1 推成功 → 云端 E2");

    // B 仍基于 E1（它的内存 base 没被 A 改），尽管共享 LS 已是 E2
    const rB = await tabB.flow.push("画", { encode: enc("vB"), onConflict: async () => "keep" });
    eq(rB.status, "conflict", "B 的陈旧推被 412 拦下");
    eq(await srvBytes(mock, "画.ora"), "vA", "云端是 A 的版本，B 没静默覆盖");
  });

  it("bug 复现：若陈旧 tab 不 adoptBase（回落共享 LS etag）→ 静默覆盖", async () => {
    const { mock, tabA, tabB } = twoTabs();
    await tabA.flow.push("画", { encode: enc("v0") });      // 云端 E1，LS etag = E1
    // tabA 内存有 base（创建时推进了）；tabB 没 adoptBase → baseFor 回落读共享 LS
    const rA = await tabA.flow.push("画", { encode: enc("vA") });   // LS → E2
    eq(rA.status, "pushed");
    const rB = await tabB.flow.push("画", { encode: enc("vB") });   // 读共享 LS = E2 → If-Match 通过
    eq(rB.status, "pushed", "这就是 bug：没自管 base 的 tab 读到别人的新 etag");
    eq(await srvBytes(mock, "画.ora"), "vB", "A 的 vA 被静默覆盖（演示问题，故修复靠 adoptBase）");
  });

  it("同 tab 连续推：base 自己推进，第二推不假 412", async () => {
    const { tabA } = twoTabs();
    await tabA.flow.push("画", { encode: enc("v0") });
    tabA.adoptBase("画", cloud.getKnownETag("画"));
    eq((await tabA.flow.push("画", { encode: enc("v1") })).status, "pushed");
    eq((await tabA.flow.push("画", { encode: enc("v2") })).status, "pushed", "自己推进 base → 不自冲突");
  });
});
