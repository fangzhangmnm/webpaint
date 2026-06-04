// 故障下的行为：限流/5xx、中间强退、lost-response（B5 假 412）。
// 三块：① mock 故障面自检 ② cloud.js 当前行为的 characterize（含已知差距）③ Store 验收红线（todo）。
// 来源：MyPWAPatterns docs/potential-bugs.md（A2/A10/B1/B2/B5/E8/H7）+ journals/potential-bugs.md。
import { describe, it, todo, assert, eq, throwsStatus } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { memLS, graphFromProvider, blobText } from "./helpers.mjs";

globalThis.localStorage = globalThis.localStorage || memLS();
const cloud = await import("../src/cloud.js");

function fresh() {
  globalThis.localStorage.clear();
  const mock = createMockProvider();
  cloud.__setGraph(graphFromProvider(mock));
  cloud.__setSignedIn(() => true);
  return mock;
}
const srvBytes = async (mock, path) => blobText(await mock.download((await mock.getItemByPath(path)).id));

describe("mock 故障面自检", () => {
  it("error 故障 → 操作前抛对应 status，云端不变", async () => {
    const mock = createMockProvider();
    await mock.upload("f.ora", "v1", {});
    mock.injectFault({ op: "upload", kind: "error", status: 429 });
    await throwsStatus(() => mock.upload("f.ora", "v2", {}), 429);
    eq(await blobText(await mock.download((await mock.getItemByPath("f.ora")).id)), "v1", "写前抛 → 云端仍 v1");
  });

  it("lostResponse → 写已落盘但抛无 status 的网络错", async () => {
    const mock = createMockProvider();
    mock.injectFault({ op: "upload", kind: "lostResponse" });
    let err;
    try { await mock.upload("f.ora", "v1", {}); } catch (e) { err = e; }
    assert(err, "应抛错");
    eq(err.status, undefined, "无 .status（模拟 fetch reject）");
    assert(await mock.getItemByPath("f.ora"), "但写已落盘");
  });

  it("times 控制故障次数：throwOnce 后恢复", async () => {
    const mock = createMockProvider();
    mock.injectFault({ op: "upload", kind: "error", status: 500, times: 1 });
    await throwsStatus(() => mock.upload("f.ora", "v1", {}), 500);
    assert(await mock.upload("f.ora", "v1", {}), "第二次应成功");
  });
});

describe("cloud.js 在故障下的当前行为（characterize + 标差距）", () => {
  it("写前瞬时失败（5xx）→ pushSession 透传 status、云端不变、重推干净成功", async () => {
    const mock = fresh();
    await cloud.pushSession("画", "v1");                       // 云端 + known etag = E1
    mock.injectFault({ op: "upload", kind: "error", status: 503 });
    let err;
    try { await cloud.pushSession("画", "v2"); } catch (e) { err = e; }
    eq(err.status, 503, "非 412 → 原样透传");
    eq(await srvBytes(mock, "画.ora"), "v1", "云端不变");
    const r = await cloud.pushSession("画", "v2b");            // known etag 仍 E1 == 云端 → 成功
    assert(r.item, "重推成功（瞬时失败是 clean，可安全重试）");
  });

  it("中间强退：upload 抛错后不错误清除 etag/dirty", async () => {
    const mock = fresh();
    await cloud.pushSession("画", "v1");
    cloud.setCloudDirty("画", true);
    const etagBefore = cloud.getKnownETag("画");
    mock.injectFault({ op: "upload", kind: "error", status: 500 });
    try { await cloud.pushSession("画", "v2"); } catch (_) {}
    eq(cloud.getKnownETag("画"), etagBefore, "失败不应改 known etag");
    eq(cloud.isCloudDirty("画"), true, "失败不应清 dirty（只在成功才清）");
  });

  it("⚠️差距(B5)：lost-response 后重推同一份 → 当前误报 CloudConflictError", async () => {
    const mock = fresh();
    await cloud.pushSession("画", "v1");                       // known E1, 云端 E1
    mock.injectFault({ op: "upload", kind: "lostResponse" });
    let e1;
    try { await cloud.pushSession("画", "v2"); } catch (e) { e1 = e; } // 云端→v2/E2，但回执丢
    assert(e1 && e1.name !== "CloudConflictError", "lost-response 是网络错，不是 412");
    eq(await srvBytes(mock, "画.ora"), "v2", "其实云端已是 v2（写成功了）");
    // 重推同一份 v2：If-Match E1 vs 云端 E2 → 412 → 当前抛 CloudConflictError（假冲突）
    let e2;
    try { await cloud.pushSession("画", "v2"); } catch (e) { e2 = e; }
    eq(e2.name, "CloudConflictError",
       "当前行为=假冲突；Store 应拉云比 hash：云端==本地要推的 → 判成功（见 todo B5）");
  });
});

describe("Store 验收红线", () => {
  // ✅ 已实现并转绿：B1/B2/B5/retry → C1；E8 + open/exit → C2/C3；C7 重连收敛 + 三态删除 → C5。
  // 余下待办：
  todo("list reconcile：缓存 N 项但 list 返回 0 → 疑似抖动，不 ghost、记录重试（A2）→ gallery 层");
});
