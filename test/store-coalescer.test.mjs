// Store.session coalescer 验收（④：连按 Ctrl+S 的合流状态机收进 Store 后首次可 node 单测）。
// 注入 fake doLocal/doPush（可控完成时机）+ edits.mark 模拟期间新编辑。
import { describe, it, eq } from "./runner.mjs";
import { createStore } from "../src/store/store.ts";

function defer() { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; }
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function mkStore() {
  return createStore({ cloud: { isDirty: () => false, getETag: () => null, setDirty() {} }, kv: null });
}

describe("Store.session coalescer", () => {
  it("空闲 → 立刻跑", async () => {
    const s = mkStore();
    let n = 0; const d = defer();
    s.session.configure({ doLocal: async () => { n++; await d.p; }, doPush: async () => {} });
    s.session.request("local");
    eq(s.session.state().inFlight, "local");
    eq(n, 1);
    d.resolve(); await flush();
    eq(s.session.state().inFlight, null);
  });

  it("在跑 + 期间无新编辑 + 同类型 → no-op（不排队）", async () => {
    const s = mkStore();
    const d = defer();
    s.session.configure({ doLocal: async () => { await d.p; }, doPush: async () => {} });
    s.session.request("local");
    s.session.request("local");                 // 没 edits.mark → hasNewEdits=false → 不排
    eq(s.session.state().pending, null);
    d.resolve(); await flush();
  });

  it("在跑 + 期间有新编辑 → 排尾巴，完成后跑", async () => {
    const s = mkStore();
    let n = 0; const d = defer();
    s.session.configure({ doLocal: async () => { n++; await d.p; }, doPush: async () => {} });
    s.session.request("local");                 // n=1, startVer=0
    s.edits.mark();                             // 期间新编辑 → version=1
    s.session.request("local");                 // hasNewEdits → pending=local
    eq(s.session.state().pending, "local");
    d.resolve(); await flush();                 // 首个完成 → 跑 pending（d 已 resolve，第二趟直接过）
    eq(n, 2);
    eq(s.session.state().pending, null);
    eq(s.session.state().inFlight, null);
  });

  it("在跑 local + 用户改主意 push → 排 push（即使无新编辑）", async () => {
    const s = mkStore();
    let pushed = 0; const d = defer();
    s.session.configure({ doLocal: async () => { await d.p; }, doPush: async () => { pushed++; } });
    s.session.request("local");
    s.session.request("push");                  // inFlight=local && type=push → 必排
    eq(s.session.state().pending, "push");
    d.resolve(); await flush();
    eq(pushed, 1);
  });

  it("pending 升级：local 尾巴被 push 盖过", async () => {
    const s = mkStore();
    const d = defer();
    s.session.configure({ doLocal: async () => { await d.p; }, doPush: async () => {} });
    s.session.request("local");
    s.edits.mark();
    s.session.request("local");                 // pending=local
    s.session.request("push");                  // type=push → 升级 pending=push
    eq(s.session.state().pending, "push");
    d.resolve(); await flush();
  });

  it("edits.mark 推进 version SSoT", () => {
    const s = mkStore();
    eq(s.edits.version(), 0);
    s.edits.mark(); s.edits.mark();
    eq(s.edits.version(), 2);
  });
});
