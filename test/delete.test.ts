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
