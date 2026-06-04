// Store.flow.push 验收测试 —— C1 的 4 条红线（B1/B2/B5/retry）+ 真冲突路径。
// 这些原本是 cloud-faults 里的 todo，现在用真 Store 实现转绿。
// Store 编排在上，底层注入「真 cloud.js（跑在 MockCloudProvider 上）」当 adapter。
import { describe, it, assert, eq, throwsStatus } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { createStore } from "../src/store/store.js";
import { memLS, graphFromProvider, blobText } from "./helpers.mjs";

globalThis.localStorage = globalThis.localStorage || memLS();
const cloud = await import("../src/cloud.js");

// zero-delay sleep：保持测试快、不依赖真定时器
const fastSleep = () => Promise.resolve();

function fresh() {
  globalThis.localStorage.clear();
  const mock = createMockProvider();
  cloud.__setGraph(graphFromProvider(mock));
  cloud.__setSignedIn(() => true);
  const store = createStore({ cloud, sleep: fastSleep, backoffMs: 0 });
  return { mock, store };
}
const enc = (s) => () => new TextEncoder().encode(s);
const srvBytes = async (mock, path) => blobText(await mock.download((await mock.getItemByPath(path)).id));

describe("flow.push 正常", () => {
  it("首推成功 → 云端落地、status=pushed、dirtyAfter=false", async () => {
    const { mock, store } = fresh();
    const r = await store.flow.push("画", { encode: enc("v1") });
    eq(r.status, "pushed");
    eq(r.dirtyAfter, false);
    eq(await srvBytes(mock, "画.ora"), "v1");
    eq(cloud.isCloudDirty("画"), false);
  });
});

describe("B1 串行化", () => {
  it("同一 name 两次并发 push → 排队，绝不并发进 upload", async () => {
    globalThis.localStorage.clear();
    let inUpload = 0, maxConcurrent = 0, release;
    const gate = new Promise((r) => { release = r; });
    let gateArmed = true;
    const mock = createMockProvider({
      hook: async (op) => {
        if (op === "upload" && gateArmed) {
          gateArmed = false;            // 只挡第一次 upload
          inUpload++; maxConcurrent = Math.max(maxConcurrent, inUpload);
          await gate;
          inUpload--;
        }
      },
    });
    cloud.__setGraph(graphFromProvider(mock));
    cloud.__setSignedIn(() => true);
    const store = createStore({ cloud, sleep: fastSleep, backoffMs: 0 });

    const p1 = store.flow.push("画", { encode: enc("v1") });   // 卡在第一次 upload
    const p2 = store.flow.push("画", { encode: enc("v2") });   // 应排队，不进 upload
    await new Promise((r) => setTimeout(r, 0));                 // 放一个 tick 让 push#1 走到 gate
    eq(inUpload, 1, "只有 push#1 在 upload 里，push#2 还没进");
    release();
    await Promise.all([p1, p2]);
    eq(maxConcurrent, 1, "全程 upload 并发数 ≤ 1");
    eq(await srvBytes(mock, "画.ora"), "v2", "两次都生效，后者最终态");
  });
});

describe("B2 不丢编辑", () => {
  it("PUT 在途又落键 → 推完仍 unpushed（dirtyAfter=true，不静默清 dirty）", async () => {
    globalThis.localStorage.clear();
    let editVersion = 0;
    const mock = createMockProvider({
      hook: async (op) => { if (op === "upload") editVersion++; },  // 上传期间来了一笔编辑
    });
    cloud.__setGraph(graphFromProvider(mock));
    cloud.__setSignedIn(() => true);
    const store = createStore({ cloud, sleep: fastSleep, backoffMs: 0 });

    const r = await store.flow.push("画", {
      encode: enc("v1"),
      getEditVersion: () => editVersion,
    });
    eq(r.status, "pushed");
    eq(r.dirtyAfter, true, "PUT 期间编辑过 → 仍 unpushed");
    eq(cloud.isCloudDirty("画"), true, "dirty 不被这次成功清掉（B2）");
  });
});

describe("B5 lost-response 自愈", () => {
  it("写已落盘但回执丢 → 重推撞 412 → 拉云比对相等 → status=healed，不弹冲突", async () => {
    const { mock, store } = fresh();
    await store.flow.push("画", { encode: enc("v1") });          // 先建立 known etag
    mock.injectFault({ op: "upload", kind: "lostResponse" });    // 下次 upload：写后丢回执

    let conflictCalled = false;
    const r = await store.flow.push("画", {
      encode: enc("v2"),
      onConflict: async () => { conflictCalled = true; return "keep"; },
    });
    eq(r.status, "healed", "云端已是这份 → 自愈成功");
    eq(conflictCalled, false, "不应弹冲突");
    eq(await srvBytes(mock, "画.ora"), "v2");
    eq(cloud.isCloudDirty("画"), false, "自愈后视为已同步");
  });
});

describe("retry 退避重试", () => {
  it("429/5xx 两次后成功 → status=pushed", async () => {
    const { mock, store } = fresh();
    mock.injectFault({ op: "upload", kind: "error", status: 503, times: 2 });
    const r = await store.flow.push("画", { encode: enc("v1") });
    eq(r.status, "pushed", "退避重试后成功");
    eq(await srvBytes(mock, "画.ora"), "v1");
  });

  it("超过 maxAttempts 仍失败 → 抛最后的错", async () => {
    const { mock } = fresh();
    const store = createStore({ cloud, sleep: fastSleep, backoffMs: 0, maxAttempts: 2 });
    mock.injectFault({ op: "upload", kind: "error", status: 500, times: 5 });
    await throwsStatus(() => store.flow.push("画", { encode: enc("v1") }), 500);
  });

  it("不可重试的错（400）→ 立即抛，不重试", async () => {
    const { mock, store } = fresh();
    let uploads = 0;
    const mock2 = createMockProvider({ hook: (op) => { if (op === "upload") uploads++; } });
    cloud.__setGraph(graphFromProvider(mock2));
    mock2.injectFault({ op: "upload", kind: "error", status: 400, times: 5 });
    await throwsStatus(() => store.flow.push("画", { encode: enc("v1") }), 400);
    eq(uploads, 1, "只试一次");
  });
});

describe("真冲突（非自愈）", () => {
  it("云端是别人改的、与本地不同 → onConflict 被调用，status=conflict", async () => {
    const { mock, store } = fresh();
    await store.flow.push("画", { encode: enc("v1") });          // known etag E1
    await mock.upload("画.ora", "OTHER-DEVICE", {});             // 别的设备写了不同内容，etag 变

    let seen = null;
    const r = await store.flow.push("画", {
      encode: enc("v2"),
      onConflict: async (info) => { seen = info; return "keep"; },
    });
    eq(r.status, "conflict");
    eq(r.choice, "keep");
    assert(seen && seen.name === "画", "onConflict 收到 name");
    eq(await srvBytes(mock, "画.ora"), "OTHER-DEVICE", "未自作主张覆盖云端");
  });
});
