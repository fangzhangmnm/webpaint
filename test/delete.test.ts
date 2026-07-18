import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createDelete } from "../src/store/delete.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  const kv = memKv();
  const d = createDelete({ cloud, local, head, kv });
  return { cloud, local, head, kv, ...d };
}

test("删除两端 clean → 云端 .trash + 本地硬删（不留双份）", async () => {
  const { cloud, local, del } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("X"));
  const r = await del("f");
  eq(r.where, "cloud", "where=cloud");
  assert(!(await local.exists("f")), "干净副本硬删");
});

test("删除两端 dirty → 先 local-only 再进本地 trash（#42，脏字节可恢复、不硬删）", async () => {
  const { cloud, local, head, del } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("MINE"));
  head.markSeen("f", cloud.getETag("f")); head.recordEdit("f");
  const r = await del("f");
  eq(r.status, "trashed", "进 trash"); eq(r.where, "both", "云端+本地两端");
  assert(!(await local.exists("f")), "本地原位已移走");
  assert(r.trashKey != null, "有本地 trashKey（未推脏字节可从本地 trash 恢复）");
});

test("离线删除：已同步文件(base 已知)→ 本地 move-aside + 排队云删", async () => {
  const { cloud, local, del } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("X"));   // 云端有 etag
  const r = await del("f", { isOnline: () => false });
  eq(r.where, "local"); assert(r.queuedCloudDelete, "有 base → 排云删");
});

test("离线删除：null base(本地 only/从未同步)不排云删（Finding 1，port 自 WebPaint）", async () => {
  const { local, del } = rig();
  await local.save("f", enc("X"));   // 只本地、从未推云 → baseEtag=null
  const r = await del("f", { isOnline: () => false });
  eq(r.where, "local"); assert(!r.queuedCloudDelete, "null base 不排云删（防重连盲删别设备同名新文件）");
});

test("replayDelete：base 匹配→trash / 不在→converged / 被改→edit-wins", async () => {
  const { cloud, replayDelete } = rig();
  await cloud.push("f", enc("X"));
  eq((await replayDelete("f", { baseEtag: cloud.getETag("f") })).status, "trashed", "匹配→删");
  await cloud.push("n", enc("Z"));   // 另起未被消费的云端文件验 null base
  eq((await replayDelete("n", { baseEtag: null })).status, "skipped-no-base", "无 base→不删（防删别设备同名新文件）");
  eq((await replayDelete("ghost", { baseEtag: "x" })).status, "converged", "不在→已没了");
  await cloud.push("g", enc("Y"));
  eq((await replayDelete("g", { baseEtag: "STALE" })).status, "conflict-edit-wins", "被改→不删");
});

test("drainDeleteQueue：离线删入队 → 重连排空", async () => {
  const { cloud, local, del, drainDeleteQueue } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("X"));
  await del("f", { isOnline: () => false });        // 入队（baseEtag=云端当前）
  const r = await drainDeleteQueue();
  eq(r.drained, 1, "排空 1 条");
});

// ── deleteEventId：一次删除 = 一个 id，两条腿共用（v415；trash-merge 据此精确配对）─────────────
const idOfLocalKey = (k: string) => k.slice(k.indexOf("/") + 1).split(":")[0];
const idOfCloudName = (n: string) => (n.match(/\[([^\]]+)\]/) || [])[1];

test("[deleteEventId] 在线删两端 → 本地 trashKey 与云端 trash 名带**同一个** id", async () => {
  const { cloud, local, head, del } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("MINE"));
  head.markSeen("f", cloud.getETag("f")); head.recordEdit("f");   // dirty → 两条腿都落 trash
  const r = await del("f");
  eq(r.where, "both", "两端");
  const trashed = await cloud.listTrash();
  eq(trashed.length, 1, "云端一条");
  eq(idOfLocalKey(r.trashKey as string), idOfCloudName(trashed[0].name),
     "★两条腿必须共用同一个 deleteEventId（否则回收站里配不上对 / 误配）");
});

test("[deleteEventId] 离线删 → id 持久化进队列；回线 drain 的云腿用**同一个** id", async () => {
  const { cloud, local, head, kv, del, drainDeleteQueue } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("X"));
  head.markSeen("f", cloud.getETag("f"));
  const r = await del("f", { isOnline: () => false });          // 离线：只落本地腿 + 排队
  eq(r.where, "local", "离线只动本地");
  assert(r.queuedCloudDelete, "云删已排队");

  const q = JSON.parse(kv.get("internal.pending_deletions") as string);
  eq(q.length, 1, "队列一条");
  const localId = idOfLocalKey(r.trashKey as string);
  eq(q[0].deleteEventId, localId, "★id 必须随队列持久化（不然回线时本地腿的 id 已经找不回来了）");

  await drainDeleteQueue();                                      // 回线重放 → 云腿此刻才生成
  const trashed = await cloud.listTrash();
  eq(trashed.length, 1, "云端一条");
  eq(idOfCloudName(trashed[0].name), localId, "★跨了一次重启/回线，两条腿仍是同一个 id");
});

test("[deleteEventId] 旧队列条目（升级前入队、无 id）→ 仍能 drain，不炸", async () => {
  const { cloud, local, head, kv, drainDeleteQueue } = rig();
  await cloud.push("f", enc("X")); await local.save("f", enc("X"));
  head.markSeen("f", cloud.getETag("f"));
  // 手工写一条旧格式（只有 name + baseEtag）
  kv.set("internal.pending_deletions", JSON.stringify([{ name: "f", baseEtag: cloud.getETag("f") }]));
  const r = await drainDeleteQueue();
  eq(r.drained, 1, "旧条目照样重放成功（现生成 id，代价仅是这条配不上对）");
  eq((await cloud.listTrash()).length, 1, "云端已进 trash");
});
