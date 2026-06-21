// cloud-sync P0 批次（审计 2026-06-09 后续）：N5 / N7 / N8 回归。
import { describe, it, assert, eq } from "./runner.mjs";
import { createStore } from "../src/store/store.ts";
import { createCloudSync } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { memKv } from "../src/store/cloud-sync.ts";

const bytes = (s) => new TextEncoder().encode(s);

function mk() {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora",
    contentType: "application/zip", appKey: "wp", now: () => ++t,
  });
  const local = createMockLocal();
  const store = createStore({ cloud, local, kv: memKv(), backoffMs: 1 });
  return { provider, cloud, local, store };
}
async function seedSynced(env, name, body) {
  await env.local.save(name, bytes(body));
  const { item } = await env.cloud.push(name, bytes(body));
  env.store.adoptBase(name, item.eTag);
  return item;
}

describe("cloud-sync P0 · N5 删 dirty 文件 → 本地降级 local-only（不丢未推字节）", () => {
  it("两端都有但本地 dirty → 云端进 .trash、本地留在目录、解绑云端态", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", true);                                  // 本地有未推改动
    const res = await env.store.flow.delete("猫", { isOnline: () => true });
    eq(await env.provider.getItemByPath("猫.ora"), null, "云端原位删了（进 .trash）");
    eq(await env.local.exists("猫"), true, "本地未推字节留在目录里（不 hardDelete、不藏 backup）");
    eq(env.cloud.getETag("猫"), null, "已解绑云端 etag → local-only");
    eq(res.status, "demoted-local-only", "回报降级 local-only");
  });
  it("对照：两端都有且 clean → 仍连本地一起删（不留双份）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");                              // clean
    const res = await env.store.flow.delete("猫", { isOnline: () => true });
    eq(await env.local.exists("猫"), false, "clean → 本地也删（云端 .trash 已救着）");
    eq(res.status, "trashed");
  });
});

describe("cloud-sync P0 · N8 restore 采纳云 etag（不对自己文件弹假 collision）", () => {
  it("从云回收站恢复 → 采纳恢复 item 的 etag", async () => {
    const env = mk();
    await env.cloud.push("猫", bytes("v1"));
    const trashed = await env.cloud.trash("猫");                    // 进 .trash，拿 item id
    env.cloud.clearState("猫");                                     // 删后清态：getETag → null
    eq(env.cloud.getETag("猫"), null, "删后无 etag");
    const res = await env.store.flow.restore({ fromCloud: true, cloudItemId: trashed.id, targetName: "猫" });
    eq(res.status, "restored");
    assert(env.cloud.getETag("猫"), "N8：restore 采纳云 item 的 etag → 之后 push 有 base，不弹假 NameCollision");
  });
});

describe("cloud-sync P0 · N7 dirty-rename 旧云 .trash 失败不静默吞", () => {
  it("旧名 .trash 失败 → 回报 oldCloudOrphan（不静默成孤儿）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", true);                                 // dirty → push 新名 + trash 旧名
    env.provider.injectFault({ op: "move", kind: "error", status: 500, times: 1 });   // trash(旧名) 的 move 失败
    const res = await env.store.flow.rename("猫", "狗", { encode: () => bytes("v2") });
    eq(res.oldCloudOrphan, true, "旧云 .trash 失败被回报（不静默吞 → A9 不复发）");
  });
});

describe("cloud-sync P0 · N3 离线删除持久化队列 + 重连 drainDeleteQueue 重放", () => {
  it("离线删 → 排队（云端没动）；重连 drain 且 base-etag 匹配 → 云端真删", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const delRes = await env.store.flow.delete("猫", { isOnline: () => false });
    eq(delRes.queuedCloudDelete, true, "离线删回报已排队");
    eq(await env.local.exists("猫"), false, "本地离线 move-aside");
    assert(await env.provider.getItemByPath("猫.ora"), "离线时云端还在（没删）");
    const drain = await env.store.flow.drainDeleteQueue();             // 重连排空
    eq(drain.drained, 1, "重放一条");
    eq(drain.deferred, 0, "无遗留");
    eq(await env.provider.getItemByPath("猫.ora"), null, "base-etag 匹配 → 云端进 .trash（删了）");
    const drain2 = await env.store.flow.drainDeleteQueue();
    eq(drain2.drained, 0, "队列已空，幂等");
  });
  it("离线删后云端同名被换成新文件（etag 变）→ drain 命中 base 不符 → conflict-edit-wins，绝不删新文件", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    await env.store.flow.delete("猫", { isOnline: () => false });      // 离线排队，base = v1 的 etag
    // 期间别的设备把同名文件换成了新内容（etag 改变）——正是「旧设备攒删除、很久后上线」要防的
    await env.provider.upload("猫.ora", bytes("new-file-from-other-device"), { conflictBehavior: "replace" });
    const drain = await env.store.flow.drainDeleteQueue();
    eq(drain.drained, 1, "出队（终态 conflict-edit-wins）");
    assert(await env.provider.getItemByPath("猫.ora"), "base-etag 守卫：云端新文件没被旧删除误杀");
  });
  // Finding 1（静态论证 2026-06-21）：本地 only（从未同步，null base）离线删 → 不得在重连时盲删同名别设备新文件。
  it("本地 only（null base）离线删 → 重连后绝不 trash 同名的别设备新文件", async () => {
    const env = mk();
    await env.local.save("图", bytes("mine-local-only"));             // 仅本地，从未 push → cloud.getETag("图")=null
    eq(env.cloud.getETag("图"), null, "前提：无云端 base");
    const delRes = await env.store.flow.delete("图", { isOnline: () => false });
    eq(await env.local.exists("图"), false, "本地 only 删了本地份");
    eq(delRes.queuedCloudDelete, false, "无云端 base → 不排云删（没有可证明属于自己的云端版本）");
    // 之后别的设备创建了一个**不同的**同名云文件
    await env.provider.upload("图.ora", bytes("OTHER-DEVICE-DISTINCT-WORK"), { conflictBehavior: "fail" });
    await env.store.flow.drainDeleteQueue();                          // 重连排空
    assert(await env.provider.getItemByPath("图.ora"), "别设备的同名新文件没被盲删（红线：不静默删未证实属己内容）");
  });
  // Finding 1 防御纵深：即便有人直接用 null base 调 replayDelete，也拒绝 trash。
  it("replayDelete 收到 null base + 云端有同名文件 → skipped-no-base，不 trash", async () => {
    const env = mk();
    await env.provider.upload("图.ora", bytes("someone-elses"), { conflictBehavior: "fail" });
    const r = await env.store.flow.replayDelete("图", { baseEtag: null });
    eq(r.status, "skipped-no-base", "无 base 无法证明云端这份属己 → 不删");
    assert(await env.provider.getItemByPath("图.ora"), "云端文件仍在");
  });
});

// Finding 2（静态论证 2026-06-21）：cloud.push 返 {item:null}（保守 unknown 路径）时 _doPush 不得谎报 "pushed"。
describe("cloud-sync · Finding 2 push 未确认不谎报 pushed", () => {
  it("无 base + 云端同名同长度异内容 + 尾校验失败（unknown）→ status≠pushed 且仍 dirty", async () => {
    const env = mk();
    const MINE = bytes("AAAAAAAAAAAAAAAA");                            // 16 bytes
    const OTHER = bytes("BBBBBBBBBBBBBBBB");                           // 同长 16，异内容
    await env.provider.upload("猫.ora", OTHER, { conflictBehavior: "fail" });   // 云端已有别设备同长文件
    await env.local.save("猫", MINE);
    env.cloud.setDirty("猫", true);                                   // 本地脏、无 base → 首推不带 If-Match → 409
    env.provider.downloadRange = async () => { throw new Error("mock: 尾校验拉取失败"); };   // → _confirmOurUpload verdict=unknown → cloud.push 返 {item:null}
    const res = await env.store.flow.push("猫", { encode: () => MINE, getEditVersion: () => 1 });
    assert(res.status !== "pushed", `未确认落地不得报 pushed（实得 ${res.status}）`);
    eq(env.cloud.isDirty("猫"), true, "保持 dirty → 下次重推，不静默丢");
  });
});

describe("cloud-sync P0 · N10 快进期间 store 拥 replacing 门（input 起笔据此降级，gate 归深模块）", () => {
  it("clean + 云端 etag 动过 → refresh 走 _safePull：临界段内 replacing()=true，结束 finally 清回 false", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", false);
    eq(env.store.busy.replacing(), false, "初始非换内容态");
    let sawReplaceStart = false;
    await env.provider.upload("猫.ora", bytes("v2-from-other-device"), { conflictBehavior: "replace" });   // 另一台设备改了云端（etag 变）
    let sawDuring = null;
    const res = await env.store.flow.refresh("猫", {
      isOnline: () => true,
      localDirty: () => false,
      onReplaceStart: () => { sawReplaceStart = true; },
      adopt: async () => { sawDuring = env.store.busy.replacing(); },   // adopt 在 _safePull 内 → 此刻应 true
    });
    eq(res.status, "fast-forwarded", "etag 动过 + clean → 快进");
    eq(sawReplaceStart, true, "确定要拉内容时通知了 app（auto-FF 据此出 status）");
    eq(sawDuring, true, "换内容临界段内 replacing()=true（input 会挡起笔，不落在半换态上）");
    eq(env.store.busy.replacing(), false, "结束后 finally 清回 false");
  });
  it("in-sync（etag 未动）→ 不进 _safePull：replacing 全程 false，onReplaceStart 不触发", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", false);
    let replaceStartCalled = false;
    const res = await env.store.flow.refresh("猫", {
      isOnline: () => true, localDirty: () => false,
      onReplaceStart: () => { replaceStartCalled = true; },
    });
    eq(res.status, "in-sync");
    eq(replaceStartCalled, false, "没拉内容 → 不闪 status（每次轮询不打扰）");
    eq(env.store.busy.replacing(), false, "从不置 replacing");
  });
});

import { mergeFolders } from "../src/store/folder-merge.ts";
describe("folder-merge P0 · N11 显式 conflictPolicy（默认 last-win）", () => {
  const item = (id, uat, extra) => ({ id, uat, ...extra });
  const env = (items) => ({ version: 1, items, trash: [], resetAt: 0 });
  it("同 id 撞 → uat 新者胜（last-win），默认即此策略", () => {
    const a = env([item("b1", 100, { size: 10 })]);
    const b = env([item("b1", 200, { size: 20 })]);   // uat 更新
    const m = mergeFolders(a, b);                       // 不传 conflictPolicy → 默认 last-win
    eq(m.items.find((e) => e.id === "b1").size, 20, "uat 新者（size 20）胜");
  });
  it("显式 conflictPolicy:'last-win' 行为一致", () => {
    const a = env([item("b1", 300, { size: 30 })]);    // a 更新
    const b = env([item("b1", 200, { size: 20 })]);
    const m = mergeFolders(a, b, { conflictPolicy: "last-win" });
    eq(m.items.find((e) => e.id === "b1").size, 30, "uat 新者（size 30）胜");
  });
});
