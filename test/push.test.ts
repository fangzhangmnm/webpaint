import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead, BypassError } from "../src/store/local-head.ts";
import { createSafeResolve } from "../src/store/safe-resolve.ts";
import { createSubstrate } from "../src/store/substrate.ts";
import { createPush } from "../src/store/push.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  if (x instanceof Blob) return await x.text();
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}
const sealPass = { sealForWrite: async (_n: string, b: Uint8Array) => b, isContainer: async () => false };

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const headKv = memKv();
  const head = createLocalHead({ kv: headKv, getCloudEtag: (n: string) => cloud.getETag(n) });
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const sub = createSubstrate();
  let ver = 0;
  const { push } = createPush({ cloud, head, seal: sealPass, safeResolve, serialize: sub.serialize, editVersion: () => ver });
  return { cloud, local, head, headKv, push, bump: () => ++ver };
}

test("happy push 新文件 → cloud 收字节 + 推后干净", async () => {
  const { cloud, head, push } = rig();
  head.recordEdit("f");
  const r = await push("f", { encode: () => enc("NEW") });
  eq(r.status, "pushed", "pushed");
  assert(!head.isDirty("f"), "推后干净");
  eq(await asStr((await cloud.pull("f"))?.blob), "NEW", "云端有 NEW");
});

test("bypass → push 抛 BypassError（dirty 绕过 recordEdit + base 已知）", async () => {
  const { head, headKv, push } = rig();
  head.markSeen("f", "v1");
  headKv.set("head.dirty:f", "1");                 // ★绕过 recordEdit 标脏
  let threw = false;
  try { await push("f", { encode: () => enc("X") }); } catch (e) { threw = e instanceof BypassError; }
  assert(threw, "bypass → 拒推");
});

test("真分叉 + onConflict=cancel → cancelled + 仍 dirty", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("V1"));                // 云端 V1@E1
  head.markSeen("f", "STALE"); head.recordEdit("f");   // parent=STALE（陈旧）
  const r = await push("f", { encode: () => enc("MINE"), onConflict: () => "cancel" });
  eq(r.status, "cancelled", "cancel 派发");
  assert(head.isDirty("f"), "cancel 后留 dirty");
  eq(await asStr((await cloud.pull("f"))?.blob), "V1", "云端没被覆盖");
});

test("lost-response 自愈 → healed + 干净（云端==本地推的）", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("SAME"));              // 云端已有 SAME（视作丢响应的那次写）
  head.markSeen("f", "STALE"); head.recordEdit("f");
  const r = await push("f", { encode: () => enc("SAME") });   // If-Match=STALE → 412 → heal
  eq(r.status, "healed", "自愈");
  assert(!head.isDirty("f"), "自愈后干净");
});
