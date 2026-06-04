// 真 cloud.js 的 characterization 测试 —— 跑在 MockCloudProvider 上（slice B）。
// 把当前 WebPaint 同步编排的真实行为钉成测试，作为把逻辑搬进 Store（C1+）前的安全网。
import { describe, it, assert, eq } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { memLS, graphFromProvider, blobText } from "./helpers.mjs";

// cloud.js 的 etag/dirty 缓存读全局 localStorage —— import 前装好 shim。
globalThis.localStorage = memLS();
const cloud = await import("../src/cloud.js");

// 每个用例：全新 mock + 清空 localStorage + 假签到。cloud 是单例，逐个 swap graph 即可（顺序跑）。
function fresh() {
  globalThis.localStorage.clear();
  const mock = createMockProvider();
  cloud.__setGraph(graphFromProvider(mock));
  cloud.__setSignedIn(() => true);
  return mock;
}

describe("pushSession", () => {
  it("首推（无 known etag）→ 上传成功、缓存 etag、清 dirty", async () => {
    const mock = fresh();
    const { item } = await cloud.pushSession("画", "v1");
    assert(item && item.eTag, "返回带 etag 的 item");
    assert(await mock.getItemByPath("画.ora"), "云端应出现 画.ora");
    eq(cloud.getKnownETag("画"), item.eTag, "known etag 应缓存");
    eq(cloud.isCloudDirty("画"), false, "推完应不 dirty");
  });

  it("云端被别处改过 → If-Match 412 → 抛 CloudConflictError（红线）", async () => {
    const mock = fresh();
    await cloud.pushSession("画", "v1");        // 缓存 etag E1
    await mock.upload("画.ora", "v2-external", {}); // 别处推，云端 etag 变 E2，本地 known 仍 E1
    let err;
    try { await cloud.pushSession("画", "v3"); }
    catch (e) { err = e; }
    assert(err, "应抛错");
    eq(err.name, "CloudConflictError", "应是 CloudConflictError");
    eq(err.sessionName, "画", "带 sessionName");
  });
});

describe("pullSession（永远 duplicate，不覆盖本地）", () => {
  it("返回 { blob, item, suggestedName }，blob 是云端字节", async () => {
    const mock = fresh();
    mock._seed("画.ora", new TextEncoder().encode("cloud-bytes"));
    const res = await cloud.pullSession("画");
    eq(res.suggestedName, "画");
    eq(await blobText(res.blob), "cloud-bytes");
    assert(res.item.eTag);
  });

  it("云端不存在 → null", async () => {
    fresh();
    eq(await cloud.pullSession("不存在"), null);
  });
});

describe("trashCloudSession（move-aside，非硬删）", () => {
  it("移到 .trash 加 [ts] 后缀，原位置清空，本地 etag/dirty 清除", async () => {
    const mock = fresh();
    await cloud.pushSession("画", "v1");
    assert(cloud.getKnownETag("画"), "推后应有 etag");
    const moved = await cloud.trashCloudSession("画");
    assert(moved, "返回 moved item");
    eq(await mock.getItemByPath("画.ora"), null, "原位置应空");
    const inTrash = await mock.list(".trash");
    eq(inTrash.length, 1, ".trash 里应有一个");
    eq(cloud.getKnownETag("画"), null, "本地 etag 应清");
  });

  it("云端没这文件 → 无操作返回 null", async () => {
    fresh();
    eq(await cloud.trashCloudSession("没有"), null);
  });
});

describe("restoreCloudFromTrash（防覆盖：撞名退 (2)）", () => {
  it("目标位置被占 → 自动落到 画 (2).ora，原占用文件不动", async () => {
    const mock = fresh();
    // 1. 推一个再删进 trash
    await cloud.pushSession("画", "v1");
    const trashed = await cloud.trashCloudSession("画");
    // 2. 目标位置重新被一个新文件占用
    await cloud.pushSession("画", "occupied-again");
    // 3. 从 trash 恢复 → 撞名 → 退 (2)
    const restored = await cloud.restoreCloudFromTrash(trashed.id, "画");
    eq(restored.path, "画 (2).ora", "应落到 (2)");
    eq(await blobText(await mock.download((await mock.getItemByPath("画.ora")).id)), "occupied-again",
       "原占用文件不应被覆盖");
  });
});

describe("deleteCloudSession", () => {
  it("硬删云端 + 清本地状态", async () => {
    const mock = fresh();
    await cloud.pushSession("画", "v1");
    await cloud.deleteCloudSession("画");
    eq(await mock.getItemByPath("画.ora"), null);
    eq(cloud.getKnownETag("画"), null);
  });
});

describe("renameCloudSession", () => {
  it("同 folder → 改名（旧失效新生效）", async () => {
    const mock = fresh();
    await cloud.pushSession("旧", "v1");
    await cloud.renameCloudSession("旧", "新");
    eq(await mock.getItemByPath("旧.ora"), null);
    assert(await mock.getItemByPath("新.ora"), "新名应在");
  });

  it("跨 folder → ensureSubfolder + move", async () => {
    const mock = fresh();
    await cloud.pushSession("a", "v1");
    await cloud.renameCloudSession("a", "sub/b");
    eq(await mock.getItemByPath("a.ora"), null);
    assert(await mock.getItemByPath("sub/b.ora"), "应移到 sub/b.ora");
    const folder = await mock.getItemByPath("sub");
    assert(folder && folder.isFolder, "sub 文件夹应被建出");
  });
});
