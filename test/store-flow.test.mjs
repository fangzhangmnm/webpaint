// Store flow 编排验收（③：把 rename / saveAs / acquire / open 收进库内）。
// 真 store.js + 真 cloud-sync.js 跑在 MockCloudProvider + MockLocal 上。验红线：
//   rename synced → 服务端 move 保 etag；rename dirty → push 新 + 旧进 .trash（非 hard-delete）；
//   本地永远先存新名再删旧名；saveAs 不动旧；acquire cloud→local；open onNewer=pull 备份先于覆盖。
import { describe, it, assert, eq } from "./runner.mjs";
import { createStore } from "../src/store/store.js";
import { createCloudSync } from "../src/store/cloud-sync.js";
import { createMockProvider } from "../src/store/mock-provider.js";
import { createMockLocal } from "../src/store/mock-local.js";
import { memKv } from "../src/store/cloud-sync.js";

const bytes = (s) => new TextEncoder().encode(s);
const txt = async (b) => new TextDecoder().decode(new Uint8Array(await (b.arrayBuffer ? b.arrayBuffer() : Promise.resolve(b))));
const u8txt = (u) => new TextDecoder().decode(u);

function mk({ clock } = {}) {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora",
    contentType: "application/zip", appKey: "wp", now: clock || (() => ++t),
  });
  const local = createMockLocal();
  const store = createStore({ cloud, local, kv: memKv(), backoffMs: 1 });
  return { provider, cloud, local, store };
}
// 预置一个「已同步」session：本地有、云端有、cloud 不 dirty、base=云端 etag。
async function seedSynced(env, name, body) {
  await env.local.save(name, bytes(body));
  const { item } = await env.cloud.push(name, bytes(body));   // push 内 setETag + setDirty(false)
  env.store.adoptBase(name, item.eTag);
  return item;
}

describe("Store.flow.rename", () => {
  it("synced → 服务端 move 保 etag、字节不重传、旧名清空", async () => {
    const env = mk();
    const it0 = await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.rename("猫", "狗", { encode: () => bytes("v1") });
    eq(res.where, "cloud-move");
    eq(env.cloud.getETag("狗"), it0.eTag, "etag 顺延到新名");
    eq(await env.provider.getItemByPath("猫.ora"), null, "云端旧名没了");
    assert(await env.provider.getItemByPath("狗.ora"), "云端新名在");
    eq(u8txt(await env.local.get("狗")), "v1", "本地新名在");
    eq(await env.local.get("猫"), null, "本地旧名删了");
  });

  it("dirty → push 当前字节到新名 + 旧名进 .trash（非 hard-delete）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", true);                          // 模拟有未推编辑
    const res = await env.store.flow.rename("猫", "狗", { encode: () => bytes("v2-edited") });
    eq(res.where, "cloud-push+trash");
    eq(await txt(await env.provider.download((await env.provider.getItemByPath("狗.ora")).id)), "v2-edited", "新名是最新字节");
    eq(await env.provider.getItemByPath("猫.ora"), null, "旧名移出原位");
    const trash = await env.cloud.listTrash();
    assert(trash.length === 1, "旧名进了 .trash 而非硬删");
  });

  it("本地先存新名再删旧名：encode 抛错时旧名不丢", async () => {
    const env = mk();
    await env.local.save("猫", bytes("v1"));
    let threw = false;
    try { await env.store.flow.rename("猫", "狗", { encode: () => { throw new Error("boom"); }, cloud: false }); }
    catch { threw = true; }
    assert(threw, "encode 抛错应冒泡");
    eq(u8txt(await env.local.get("猫")), "v1", "旧名仍在（绝不先删）");
    eq(await env.local.get("狗"), null);
  });

  it("纯本地（cloud:false）→ 只改本地，不碰云", async () => {
    const env = mk();
    await env.local.save("猫", bytes("v1"));
    const res = await env.store.flow.rename("猫", "狗", { encode: () => bytes("v1"), cloud: false });
    eq(res.where, "local");
    eq(u8txt(await env.local.get("狗")), "v1");
    eq(await env.local.get("猫"), null);
  });

  it("云端推送失败 → 本地改名仍成、新名标脏 deferred（不回滚）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", true);                          // 走 push 分支
    env.provider.injectFault({ op: "upload", kind: "error", status: 500, times: 10 });
    const res = await env.store.flow.rename("猫", "狗", { encode: () => bytes("v2") });
    eq(res.where, "local");
    eq(res.cloudDeferred, true);
    eq(u8txt(await env.local.get("狗")), "v2", "本地改名落地");
    eq(await env.local.get("猫"), null, "旧名已删");
    eq(env.cloud.isDirty("狗"), true, "新名标脏，下次 push 续");
  });
});

describe("Store.flow.saveAs", () => {
  it("写新身份，旧的不动", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.saveAs("猫副本", { encode: () => bytes("v1") });
    eq(res.where, "cloud");
    eq(u8txt(await env.local.get("猫副本")), "v1", "新名本地在");
    assert(await env.provider.getItemByPath("猫副本.ora"), "新名云端在");
    eq(u8txt(await env.local.get("猫")), "v1", "旧名本地仍在");
    assert(await env.provider.getItemByPath("猫.ora"), "旧名云端仍在");
  });
});

describe("Store.flow.acquire", () => {
  it("cloud-only → 本地，adopt 收到 blob + localName", async () => {
    const env = mk();
    await env.cloud.push("云猫", bytes("cloudbody"));        // 只在云端
    let adopted = null;
    const res = await env.store.flow.acquire("云猫", { localName: "云猫(2)", adopt: (blob, nm) => { adopted = nm; } });
    eq(res.status, "acquired");
    eq(res.localName, "云猫(2)");
    eq(adopted, "云猫(2)", "adopt 收到 localName");
    eq(u8txt(await env.local.get("云猫(2)")), "cloudbody");
  });
  it("云端不存在 → absent", async () => {
    const env = mk();
    eq((await env.store.flow.acquire("无")).status, "absent");
  });
});

describe("Store.flow.open（site 4 合流目标）", () => {
  it("云端比 base 新 + onNewer=pull → 本地先备份再覆盖再 adopt", async () => {
    const env = mk();
    await seedSynced(env, "猫", "local-old");
    // 云端被「别处」改新：直接 force-push 一个新版本（base 仍是旧 etag）
    await env.provider.upload("猫.ora", bytes("cloud-new"), { contentType: "application/zip", conflictBehavior: "replace" });
    let adoptedBody = null;
    const res = await env.store.flow.open("猫", {
      onNewer: async () => "pull",
      adopt: async (blob) => { adoptedBody = await txt(blob); },
    });
    eq(res.source, "pulled");
    assert(res.backupName, "本地原版已备份");
    eq(adoptedBody, "cloud-new", "adopt 到云端新版");
    eq(u8txt(await env.local.get("猫")), "cloud-new", "本地被云端覆盖");
    assert(await env.local.get(res.backupName), "备份副本存在（原版未丢）");
  });
});
