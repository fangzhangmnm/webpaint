import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createTrash } from "../src/store/trash.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  return { cloud, local, head, ...createTrash({ cloud, local, head }) };
}

test("restore 本地：从 trashKey 恢复", async () => {
  const { local, restore } = rig();
  await local.save("f", enc("X"));
  const tk = await local.trash("f");
  const r = await restore({ trashKey: tk });
  eq(r.status, "restored", "恢复"); assert(r.local, "本地恢复");
  assert(await local.exists("f"), "文件回来");
});

test("purge：强制 danger confirm，确认 → 彻底删", async () => {
  const { local, purge } = rig();
  await local.save("f", enc("X")); const tk = await local.trash("f");
  eq((await purge({ trashKey: tk, confirm: () => false })).status, "cancelled", "拒绝 → 取消");
  eq((await purge({ trashKey: tk, confirm: () => true })).status, "purged", "确认 → 彻底删");
});

test("restore both（本地+云端一起恢复）+ 采纳云 etag（N8：之后 push 有 base，不弹假撞名）", async () => {
  const { cloud, local, head, restore } = rig();
  await cloud.push("f", enc("DATA"));
  const trashed = await cloud.trash("f");                  // 云端进 .trash
  await local.save("f", enc("DATA")); const tk = await local.trash("f");   // 本地进 trash
  const r = await restore({ trashKey: tk, fromCloud: true, cloudItemId: trashed!.id, targetName: "f" });
  eq(r.status, "restored", "恢复"); assert(r.local && r.cloud, "本地+云端都恢复");
  assert(await local.exists("f"), "本地文件回来");
  assert(head.seenBase("f") != null, "采纳了恢复出的云 etag（base 有 → 下次 push 不弹假 collision，N8）");
});

test("emptyTrash scope=cloud：只清云端，本地回收站不动", async () => {
  const { cloud, local, emptyTrash } = rig();
  await cloud.push("c", enc("C")); await cloud.trash("c");           // 云端 trash 1 个
  await local.save("l", enc("L")); await local.trash("l");          // 本地 trash 1 个
  const r = await emptyTrash({ scope: "cloud" });
  eq(r.status, "emptied", "清空"); eq(r.purged, 1, "只清了云端 1 个");
  eq((await local.listTrash()).length, 1, "本地回收站没动");
});

test("emptyTrash 离线（scope=both, offline）→ 只清本地、云端跳过（不静默丢云端 trash）", async () => {
  const { cloud, local, emptyTrash } = rig();
  await cloud.push("c", enc("C")); await cloud.trash("c");
  await local.save("l", enc("L")); await local.trash("l");
  const r = await emptyTrash({ scope: "both", isOnline: () => false });
  eq(r.purged, 1, "只清了本地 1 个（云端离线跳过）");
  eq((await cloud.listTrash()).length, 1, "云端 trash 还在（离线没碰）");
});

test("emptyTrash local：批量清空本地回收站", async () => {
  const { local, emptyTrash } = rig();
  await local.save("a", enc("1")); await local.trash("a");
  await local.save("b", enc("2")); await local.trash("b");
  const r = await emptyTrash({ scope: "local" });
  eq(r.status, "emptied", "清空");
  eq(r.purged, 2, "清了 2 个");
});
