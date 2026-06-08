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

describe("Store.flow.rename（图库非活动 item：无 encode，字节取自 local）", () => {
  it("synced 非活动 → 不传 encode，从 local.get 取字节，服务端 move 保 etag", async () => {
    const env = mk();
    const it0 = await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.rename("猫", "狗", {});   // 无 encode
    eq(res.where, "cloud-move");
    eq(env.cloud.getETag("狗"), it0.eTag, "etag 顺延");
    eq(u8txt(await env.local.get("狗")), "v1", "本地新名 = 既存字节");
    eq(await env.local.get("猫"), null, "本地旧名删了");
  });

  it("cloud-only（无本地）→ 无 encode → 纯服务端 move，不写本地", async () => {
    const env = mk();
    await env.cloud.push("云猫", bytes("c1"));               // 只云端
    env.store.adoptBase("云猫", env.cloud.getETag("云猫"));
    const res = await env.store.flow.rename("云猫", "云狗", {});
    eq(res.where, "cloud-move");
    assert(await env.provider.getItemByPath("云狗.ora"), "云端新名在");
    eq(await env.provider.getItemByPath("云猫.ora"), null, "云端旧名没了");
    eq(await env.local.get("云狗"), null, "没误写本地");
  });

  it("dirty 非活动 → 无 encode 但有本地字节 → push 本地字节到新名 + 旧名进 .trash", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    await env.local.save("猫", bytes("v2-local"));            // 本地比云端新
    env.cloud.setDirty("猫", true);
    const res = await env.store.flow.rename("猫", "狗", {});   // 无 encode
    eq(res.where, "cloud-push+trash");
    eq(await txt(await env.provider.download((await env.provider.getItemByPath("狗.ora")).id)), "v2-local", "推的是本地字节");
    assert((await env.cloud.listTrash()).length === 1, "旧名进 .trash");
  });
});

describe("Store.flow.delete（三态 move-aside / 不留双份）", () => {
  it("both → 云端进 .trash + 本地 hardDelete（不留双份）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.delete("猫");
    eq(res.where, "cloud");
    eq(await env.local.get("猫"), null, "本地真删（不进本地 trash）");
    eq(env.local._trash.size, 0, "本地无双份");
    assert((await env.cloud.listTrash()).length === 1, "云端进 .trash 可恢复");
  });

  it("local-only → 本地 move-aside（进本地 trash，绝不硬删）", async () => {
    const env = mk();
    await env.local.save("草稿", bytes("d1"));
    const res = await env.store.flow.delete("草稿");
    eq(res.where, "local");
    eq(await env.local.get("草稿"), null);
    eq(env.local._trash.size, 1, "进本地 trash 可恢复");
  });

  it("cloud-only → 云端进 .trash", async () => {
    const env = mk();
    await env.cloud.push("云猫", bytes("c1"));
    const res = await env.store.flow.delete("云猫");
    eq(res.where, "cloud");
    assert((await env.cloud.listTrash()).length === 1);
  });

  it("离线 → 本地 move-aside + 排队云删（不碰网络）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.delete("猫", { isOnline: () => false });
    eq(res.status, "trashed"); eq(res.where, "local");
    eq(res.queuedCloudDelete, true, "记下重连重放");
    assert(await env.provider.getItemByPath("猫.ora"), "离线不动云端");
  });
});

describe("Store.flow.restore / purge（本地+云端一条路）", () => {
  it("both 在回收站 → 本地恢复拿名、云端按同一名恢复", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const trashKey = await env.local.trash("猫");            // 本地进 trash
    const moved = await env.cloud.trash("猫");               // 云端进 .trash，moved.id
    const res = await env.store.flow.restore({ trashKey, fromCloud: true, cloudItemId: moved.id, targetName: "猫" });
    eq(res.status, "restored"); eq(res.name, "猫");
    eq(res.local, true); eq(res.cloud, true);
    eq(u8txt(await env.local.get("猫")), "v1", "本地恢复");
    assert(await env.provider.getItemByPath("猫.ora"), "云端恢复回原位");
  });

  it("purge both → 本地 trash 与云端 trash 都清", async () => {
    const env = mk();
    await env.local.save("猫", bytes("v1"));
    const trashKey = await env.local.trash("猫");
    await env.cloud.push("猫", bytes("v1"));
    const moved = await env.cloud.trash("猫");
    await env.store.flow.purge({ trashKey, cloudItemId: moved.id });
    eq(env.local._trash.size, 0, "本地 trash 清空");
    // 云端：purge 删的是 trash 里的 itemId
  });
});

describe("move-aside 同名防撞 · 对抗（trash/backup 多次同名靠 guid 不撞）", () => {
  it("[对抗] 同一时钟下两次 weakOverride 同名 → .backup 留两份（旧版 [ts] 同 ms 会 fail 抛错）", async () => {
    const provider = createMockProvider();
    const cloud = createCloudSync({
      provider, kv: memKv(), fileName: (n) => n + ".ora",
      contentType: "application/zip", appKey: "wp", now: () => 1000,   // 固定时钟：逼出同秒，靠 guid 区分
    });
    await cloud.push("猫", bytes("v1"));
    await cloud.weakOverride("猫", bytes("v2"));   // 备份 v1 → .backup/猫 [yyyymmddhhmmss-<guid1>]
    await cloud.weakOverride("猫", bytes("v3"));   // 备份 v2 → .backup/猫 [yyyymmddhhmmss-<guid2>]（guid 不同，不撞）
    const backups = await provider.list(".backup");
    eq(backups.length, 2, "两次备份都在，且文件名互不冲突");
    eq(backups[0].name === backups[1].name, false, "两个 backup 名必须不同（guid 区分）");
  });

  it("[对抗] 云端 .backup/ 内容不漏进 gallery 列表（旧版只排 folders 却仍递归进去）", async () => {
    const env = mk();
    const it0 = await seedSynced(env, "猫", "v1");
    env.store.adoptBase("猫", it0.eTag);
    await env.cloud.weakOverride("猫", bytes("v2"));        // 造一个 .backup/猫 [stamp] 备份项
    const { files, folders } = await env.cloud.listAll();
    eq(files.some((f) => f.path.startsWith(".backup")), false, ".backup 文件不得进文件列表");
    eq(folders.some((f) => f.startsWith(".backup")), false, ".backup 不得进文件夹列表");
    assert(files.some((f) => f.name === "猫"), "正常文件仍在");
  });

  it("[对抗] 本地 backup 同名两次 → 两份独立、隐藏命名空间、原件不动（旧版同 ms 会静默覆盖）", async () => {
    const local = createMockLocal();
    await local.save("猫", bytes("v1"));
    const b1 = await local.backup("猫");
    await local.save("猫", bytes("v2"));
    const b2 = await local.backup("猫");
    assert(b1.startsWith(".backup-local/") && b2.startsWith(".backup-local/"), "进隐藏 .backup-local/ 命名空间");
    eq(b1 === b2, false, "两次 backup key 必须不同");
    eq(u8txt(await local.get(b1)), "v1", "第一份留底是 v1");
    eq(u8txt(await local.get(b2)), "v2", "第二份留底是 v2");
    eq(u8txt(await local.get("猫")), "v2", "原件还在");
  });
});

describe("cloud-sync.push H7 兜底 · 对抗（不得把 0 字节占位当成功）", () => {
  it("[对抗] upload 返回 null + 留下 0 字节占位 → 仍 dirty，不骗成 synced", async () => {
    const fake = {
      // 模拟：分片末无 item / 上传失败，但 createUploadSession 已留下 0 字节占位（有 eTag）
      upload: async () => null,
      getItemByPath: async () => ({ id: "x", name: "猫.ora", eTag: "e1", size: 0 }),
    };
    const cs = createCloudSync({ provider: fake, kv: memKv(), fileName: (n) => n + ".ora", appKey: "t" });
    cs.setDirty("猫", true);
    const { item } = await cs.push("猫", new TextEncoder().encode("12345"));   // 写 5 字节
    assert(!item, "size 不符的 0 字节占位不该被认作上传结果");
    eq(cs.isDirty("猫"), true, "必须仍 dirty——下次 Ctrl+S 重试，绝不骗成 synced");
  });

  it("[对抗] 无基准 push 撞云端同名异文件（非空异大小）→ CloudNameCollisionError，绝不覆盖、保持 dirty", async () => {
    const fake = {
      upload: async () => { throw Object.assign(new Error("name exists"), { status: 409 }); },   // conflictBehavior:fail → 409
      getItemByPath: async () => ({ id: "y", name: "猫.ora", eTag: "other", size: 999 }),         // 别人的同名大文件
    };
    const cs = createCloudSync({ provider: fake, kv: memKv(), fileName: (n) => n + ".ora", appKey: "t" });
    cs.setDirty("猫", true);
    let collided = false;
    try { await cs.push("猫", new TextEncoder().encode("12345")); }
    catch (e) { collided = e.name === "CloudNameCollisionError"; }
    assert(collided, "撞名异文件必须抛 CloudNameCollisionError，不静默覆盖别人作品");
    eq(cs.isDirty("猫"), true, "没推上去 → 保持 dirty");
  });

  it("真 H7（分片末无 item 但字节确实上传到位）→ 大小匹配 → 认，标 synced", async () => {
    const fake = {
      upload: async () => null,                                                 // 末响应没带 item
      getItemByPath: async () => ({ id: "x", name: "猫.ora", eTag: "e2", size: 5 }),  // 但云端确有 5 字节
    };
    const cs = createCloudSync({ provider: fake, kv: memKv(), fileName: (n) => n + ".ora", appKey: "t" });
    cs.setDirty("猫", true);
    const { item } = await cs.push("猫", new TextEncoder().encode("12345"));
    assert(item && item.eTag === "e2", "大小匹配 → 采纳权威 etag");
    eq(cs.isDirty("猫"), false, "真上传成功 → 标 synced");
  });
});

describe("Store.edits 本地落盘 dirty（派生自编辑游标，取代 app 的 _docDirty）", () => {
  it("初始 clean；mark→dirty；markSaved→clean", () => {
    const env = mk();
    const e = env.store.edits;
    eq(e.localDirty(), false, "新建 = 干净");
    e.mark();
    eq(e.localDirty(), true, "改一笔 = 脏");
    e.markSaved();
    eq(e.localDirty(), false, "落盘后 = 干净");
  });
  it("落盘期间又改（markSaved 给旧游标）→ 仍脏（B2 语义，不丢编辑）", () => {
    const env = mk();
    const e = env.store.edits;
    e.mark();                       // v=1
    const v0 = e.version();         // 落盘前快照
    e.mark();                       // v=2：落盘 await 期间又改了一笔
    e.markSaved(v0);                // 只确认存到 v0 那一刻
    eq(e.localDirty(), true, "落盘期间的新编辑仍标脏");
    e.markSaved();                  // 确认到当前
    eq(e.localDirty(), false);
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

describe("Store.flow.open（ADR-0016：clean 静默快进 / dirty 才弹 sheet）", () => {
  it("clean + 云端动 → 静默快进：不弹 onNewer、不刷 backup、adopt 云版", async () => {
    const env = mk();
    await seedSynced(env, "猫", "local-old");                 // clean，_base=etag0
    // 云端被「别处」改新（base 仍旧 etag、本地仍 clean）
    await env.provider.upload("猫.ora", bytes("cloud-new"), { contentType: "application/zip", conflictBehavior: "replace" });
    let onNewerCalled = false, adoptedBody = null;
    const res = await env.store.flow.open("猫", {
      onNewer: async () => { onNewerCalled = true; return "pull"; },
      adopt: async (blob) => { adoptedBody = await txt(blob); },
    });
    eq(res.source, "fast-forwarded", "clean → 快进而非 surfaced pull");
    eq(onNewerCalled, false, "clean 不该弹冲突 sheet");
    eq(res.backupName, undefined, "clean 快进不刷 backup（可从云端重取的已知版本）");
    eq(adoptedBody, "cloud-new", "adopt 到云端新版");
    eq(u8txt(await env.local.get("猫")), "cloud-new", "本地快进到云版");
  });

  it("dirty + 云端动 → 弹 onNewer；pull 则覆盖前先备份（真分叉才 backup）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "local-old");
    env.store.cloud.setDirty("猫", true);                     // 本地有未推编辑（经门捕获 parentBase）
    await env.provider.upload("猫.ora", bytes("cloud-new"), { contentType: "application/zip", conflictBehavior: "replace" });
    let onNewerCalled = false, adoptedBody = null;
    const res = await env.store.flow.open("猫", {
      onNewer: async () => { onNewerCalled = true; return "pull"; },
      adopt: async (blob) => { adoptedBody = await txt(blob); },
    });
    eq(onNewerCalled, true, "dirty 分叉 → 弹 sheet");
    eq(res.source, "pulled");
    assert(res.backupName, "dirty pull → 覆盖前先备份（never-lose）");
    eq(adoptedBody, "cloud-new", "adopt 到云端新版");
    assert(await env.local.get(res.backupName), "备份副本在（原版未丢）");
  });

  it("云端没动 → in-sync（本地权威，不拉）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.open("猫", { onNewer: async () => "pull", adopt: async () => {} });
    eq(res.source, "local"); eq(res.reason, "in-sync");
  });
});

describe("Store.flow.refresh（事件驱动干净快进 · ADR-0016 §2）", () => {
  it("clean + 云端动 → fast-forwarded、adopt 云版、不刷 backup", async () => {
    const env = mk();
    await seedSynced(env, "猫", "local-old");
    await env.provider.upload("猫.ora", bytes("cloud-new"), { contentType: "application/zip", conflictBehavior: "replace" });
    let adopted = null;
    const res = await env.store.flow.refresh("猫", { adopt: async (b) => { adopted = await txt(b); } });
    eq(res.status, "fast-forwarded");
    eq(adopted, "cloud-new");
    eq(u8txt(await env.local.get("猫")), "cloud-new", "本地快进到云版");
    eq([...env.local._items.keys()].some((k) => k.startsWith(".backup-local/")), false, "clean 快进不刷 backup");
  });

  it("dirty → dirty-skip：绝不在事件里覆盖/弹 sheet", async () => {
    const env = mk();
    await seedSynced(env, "猫", "local-old");
    env.store.cloud.setDirty("猫", true);
    await env.provider.upload("猫.ora", bytes("cloud-new"), { contentType: "application/zip", conflictBehavior: "replace" });
    const res = await env.store.flow.refresh("猫", { adopt: async () => {} });
    eq(res.status, "dirty-skip");
    eq(u8txt(await env.local.get("猫")), "local-old", "dirty 时绝不被事件覆盖（保未推编辑）");
  });

  it("云端没动 → in-sync no-op（etag 没动不拉内容）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    let pulled = false;
    const res = await env.store.flow.refresh("猫", { adopt: async () => { pulled = true; } });
    eq(res.status, "in-sync");
    eq(pulled, false, "etag 没动不拉内容（热路径零多余网络）");
  });

  it("离线 → offline，不碰云、不覆盖本地", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.refresh("猫", { isOnline: () => false, adopt: async () => {} });
    eq(res.status, "offline");
  });
});

describe("Store.busy（②b：transient saving/pushing 归 store，status 只读）", () => {
  it("saving / pushing 独立置位与读取", () => {
    const env = mk();
    eq(env.store.busy.saving(), false);
    eq(env.store.busy.pushing(), false);
    env.store.busy.set("saving", true);
    eq(env.store.busy.saving(), true);
    eq(env.store.busy.pushing(), false);     // 互不影响
    env.store.busy.set("pushing", true);
    env.store.busy.set("saving", false);
    eq(env.store.busy.saving(), false);
    eq(env.store.busy.pushing(), true);
  });
  it("whenPushIdle：无 push 立即 resolve；有 push 等 set(pushing,false) 才 resolve", async () => {
    const env = mk();
    await env.store.busy.whenPushIdle();           // 无 push → 立即（不挂起）
    env.store.busy.set("pushing", true);
    let resolved = false;
    env.store.busy.whenPushIdle().then(() => { resolved = true; });
    await Promise.resolve(); await Promise.resolve();
    eq(resolved, false, "push 在飞 → 仍等待");
    env.store.busy.set("pushing", false);
    await Promise.resolve(); await Promise.resolve();
    eq(resolved, true, "push 落地 → resolve");
  });
});

describe("Store.autosave（②c：cadence 归 store，flush dirty-gated）", () => {
  it("flush：仅 dirty && !saving 才调 persist", async () => {
    const env = mk();
    let calls = 0;
    env.store.autosave.configure({ persist: async () => { calls++; } });
    await env.store.autosave.flush();          // clean → 不调
    eq(calls, 0);
    env.store.edit(null);                       // 推游标 → localDirty
    await env.store.autosave.flush();          // dirty → 调
    eq(calls, 1);
    env.store.busy.set("saving", true);
    await env.store.autosave.flush();          // 正在存盘 → 不重入
    eq(calls, 1);
  });
});

describe("Store parentBase 权威（ADR-0016 §4：clean→dirty 门 + bypass 守卫）", () => {
  it("[对抗] dirty 推送绕过门（无 parentBase）→ 抛，绝不拿陈旧 base 静默覆盖", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");                        // _base=etag、clean
    env.cloud.setDirty("猫", true);                           // **低层** cloud.setDirty 绕过 Store 的门 → 不捕获 parentBase
    let threw = false;
    try { await env.store.flow.push("猫", { encode: () => bytes("v2") }); }
    catch { threw = true; }
    assert(threw, "dirty 无 parentBase 必须 loud failure，而非静默丢更新");
  });

  it("store.edit(name)（L4 ② 唯一编辑入口）= 推游标 + 经门捕 parentBase → push 不撞 bypass 守卫", async () => {
    const env = mk();
    const it0 = await seedSynced(env, "猫", "v1");            // clean、_base=etag
    eq(env.store.edits.localDirty(), false);
    env.store.edit("猫");                                     // app 编辑落地只调这一处
    assert(env.store.edits.localDirty(), "edit() 推了游标 → local-dirty");
    eq(env.cloud.isDirty("猫"), true, "edit() 经门标了云脏");
    eq(env.store._internal.parentFor("猫"), it0.eTag, "edit() 经门捕了 parentBase");
    const res = await env.store.flow.push("猫", { encode: () => bytes("v2") });
    eq(res.status, "pushed", "走 edit() 的脏 → push 干净落地（不撞 bypass）");
  });

  it("store.edit(null)（gallery-first 未绑 session）→ 只推游标、不经门标任何 item", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");                        // 猫 = clean
    eq(env.cloud.isDirty("猫"), false);
    env.store.edit(null);
    assert(env.store.edits.localDirty(), "无 name 仍推游标");
    eq(env.cloud.isDirty("猫"), false, "edit(null) 不经门、不标已存在 item 脏");
    eq(env.store._internal.hasParent("猫"), false, "edit(null) 不捕 parentBase");
  });

  it("走门标脏（cloudState.setDirty）→ 捕获 parentBase=派生云版 → push 干净落地、episode 清除", async () => {
    const env = mk();
    const it0 = await seedSynced(env, "猫", "v1");
    env.store.cloud.setDirty("猫", true);                     // 经 Store 的门
    eq(env.store._internal.hasParent("猫"), true, "门捕获了 parentBase");
    eq(env.store._internal.parentFor("猫"), it0.eTag, "parentBase = 派生自的云版");
    const res = await env.store.flow.push("猫", { encode: () => bytes("v2") });
    eq(res.status, "pushed");
    eq(env.store._internal.hasParent("猫"), false, "干净落地后 episode 清除");
  });

  it("门 episode 内幂等：已 dirty 再标脏不重捕（base 中途变也不改 parentBase）", async () => {
    const env = mk();
    const it0 = await seedSynced(env, "猫", "v1");
    env.store.cloud.setDirty("猫", true);
    env.store.adoptBase("猫", "etag-moved");                  // 模拟 base 中途被推进
    env.store.cloud.setDirty("猫", true);                     // 已 dirty 再标脏 → 不重新捕获
    eq(env.store._internal.parentFor("猫"), it0.eTag, "episode 内 parentBase 恒定（幂等）");
  });

  it("串行交接：B(干净) refresh 快进到 A 版 → B 编辑 → push 干净 If-Match，0 backup（无 .backup 蛙跳）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");                        // B 设备：synced v1
    await env.provider.upload("猫.ora", bytes("v2-fromA"), { contentType: "application/zip", conflictBehavior: "replace" });  // A 推了 v2
    const ff = await env.store.flow.refresh("猫", { adopt: async () => {} });
    eq(ff.status, "fast-forwarded", "B 干净 → 先快进到 A 版");
    env.store.cloud.setDirty("猫", true);                     // B 现在落笔（门捕获 parentBase=v2 etag）
    const res = await env.store.flow.push("猫", { encode: () => bytes("v3-fromB") });
    eq(res.status, "pushed", "干净 If-Match 落地，无 412");
    const backups = await env.provider.list(".backup").catch(() => []);   // 没建 .backup 文件夹 = 0 备份
    eq(backups.length, 0, "串行交接不刷云端 .backup");
    eq([...env.local._items.keys()].some((k) => k.startsWith(".backup-local/")), false, "也不刷本地 backup");
    eq(await txt(await env.provider.download((await env.provider.getItemByPath("猫.ora")).id)), "v3-fromB", "云端是 B 的 v3");
  });
});

describe("saveAndPush 冲突 = take-cloud（pull · 无命名 · 我的进本地 backup）", () => {
  it("dirty 分叉 + onConflict→pull → store 内：备份本地→拉云覆盖→adopt，resolved/pull", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");                        // _base=etag1，clean
    env.store.cloud.setDirty("猫", true);                     // 经门标脏 → 捕获 parentBase=etag1
    await env.provider.upload("猫.ora", bytes("v2-cloud"), { contentType: "application/zip", conflictBehavior: "replace" });  // 云端被别处推新
    let adopted = null;
    const res = await env.store.flow.push("猫", {
      encode: () => bytes("v2-mine"),                         // 我的版本（与云端分叉）
      adopt: async (blob) => { adopted = await txt(blob); },
      onConflict: async () => "pull",                         // 用户选「用云端覆盖本地」
    });
    eq(res.status, "resolved");
    eq(res.resolution, "pull");
    assert(res.backupName, "我的版本进了本地 backup（可恢复）");
    eq(adopted, "v2-cloud", "adopt 到云端版");
    eq(u8txt(await env.local.get("猫")), "v2-cloud", "本地被云端覆盖");
    assert(await env.local.get(res.backupName), "本地 backup 副本在（我的版本未丢）");
  });

  it("[对抗] dirty 分叉 + onConflict→no-op（保留本地）→ 仍 dirty（_tryHeal 的 pull 副作用不得静默清脏丢更新）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.store.cloud.setDirty("猫", true);                     // 有未推编辑
    await env.provider.upload("猫.ora", bytes("v2-cloud"), { contentType: "application/zip", conflictBehavior: "replace" });
    const res = await env.store.flow.push("猫", { encode: () => bytes("v2-mine"), onConflict: async () => "no-op" });
    eq(res.status, "conflict");
    eq(env.store.cloud.isDirty("猫"), true, "保留本地后必须仍 dirty，下次 push 会再试（绝不静默丢）");
  });
});

describe("Store.flow.emptyTrash（批量彻底删，两端在库内一处清）", () => {
  it("本地 + 云端 trash 都清；不按 GUID 配对", async () => {
    const env = mk();
    await env.local.save("a", bytes("A")); await env.local.trash("a");
    await env.local.save("b", bytes("B")); await env.local.trash("b");
    await env.cloud.push("c", bytes("C")); await env.cloud.trash("c");
    const res = await env.store.flow.emptyTrash({ isOnline: () => true });
    eq(res.status, "emptied");
    eq(res.failed.length, 0, "无失败");
    eq((await env.local.listTrash()).length, 0, "本地 trash 应空");
    eq((await env.cloud.listTrash()).length, 0, "云端 trash 应空");
  });

  it("离线：只清本地、云端 trash 留着、无失败（isOnline=false 跳过云段）", async () => {
    const env = mk();
    await env.local.save("a", bytes("A")); await env.local.trash("a");
    await env.cloud.push("c", bytes("C")); await env.cloud.trash("c");
    const res = await env.store.flow.emptyTrash({ isOnline: () => false });
    eq(res.status, "emptied");
    eq(res.failed.length, 0);
    eq((await env.local.listTrash()).length, 0, "本地清空");
    eq((await env.cloud.listTrash()).length, 1, "云端 trash 离线应保留");
  });
});
