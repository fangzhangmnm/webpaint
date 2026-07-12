import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createSafeResolve } from "../src/store/safe-resolve.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  if (x instanceof Blob) return await x.text();
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  return { cloud, local, head };
}

test("safePull dirty → 先备份再覆盖（backupName 有）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));          // 云端有 CLOUD
  await local.save("f", enc("OLD"));            // 本地旧版
  head.recordEdit("f");                         // 标脏 → 必须备份
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const r = await sr.safePull("f");
  assert(r.ok, "safePull ok");
  assert(!!(r.ok && r.backupName), "dirty → 有备份");
  eq(await asStr(await local.get("f")), "CLOUD", "本地被覆盖为云端版");
});

test("safePull clean → 跳备份（backupName 无）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("OLD"));            // clean（没 recordEdit）
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const r = await sr.safePull("f");
  assert(r.ok && !r.backupName, "clean → 不备份（ADR-0016）");
});

test("safePull validate 失败 → 拒绝，本地不覆盖（N2）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("BADHTML"));
  await local.save("f", enc("GOOD"));
  head.recordEdit("f");
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => false });
  const r = await sr.safePull("f");
  assert(!r.ok && r.reason === "invalid-cloud-bytes", "坏字节被拒");
  eq(await asStr(await local.get("f")), "GOOD", "本地一份好副本没被覆盖");
});

test("tryHeal：云端字节==本地推的 → 自愈 true + 清脏（B5）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("B"));
  head.recordEdit("f");
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  assert(await sr.tryHeal("f", enc("B")), "字节相等 → 自愈");
  assert(!head.isDirty("f"), "自愈后清脏");
  assert(!(await sr.tryHeal("f", enc("C"))), "字节不等 → 不自愈");
});

test("weakOverride（keepMine）：force-push 本地，云端变本地版", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  await sr.weakOverride("f", enc("MINE"));
  const pulled = await cloud.pull("f");
  eq(await asStr(pulled?.blob), "MINE", "云端被 force 成本地版");
});

test("resolveConflict 派发：takeCloud/keepMine/cancel", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("MINE"));
  head.recordEdit("f");
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });

  const cancel = await sr.resolveConflict("f", "cancel");
  eq(cancel.status, "cancelled", "cancel 什么都不动");
  assert(head.isDirty("f"), "cancel 后仍 dirty");

  const take = await sr.resolveConflict("f", "takeCloud");
  eq(take.resolution, "takeCloud", "takeCloud → safePull");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版");

  await local.save("f", enc("MINE2")); head.recordEdit("f");
  const keep = await sr.resolveConflict("f", "keepMine", { bytes: enc("MINE2") });
  eq(keep.resolution, "keepMine", "keepMine → weakOverride");
  eq(await asStr((await cloud.pull("f"))?.blob), "MINE2", "云端变本地版");
});
