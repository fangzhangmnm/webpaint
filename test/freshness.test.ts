import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createSafeResolve } from "../src/store/safe-resolve.ts";
import { createFreshness } from "../src/store/freshness.ts";

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
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const { open, refresh } = createFreshness({ cloud, head, safeResolve });
  return { cloud, local, head, open, refresh };
}

test("open in-sync：seenBase == 云端 etag → 不动", async () => {
  const { cloud, head, open } = rig();
  await cloud.push("f", enc("V1"));
  head.markSeen("f", cloud.getETag("f"));
  const r = await open("f");
  eq(r.reason, "in-sync", "in-sync");
});

test("open in-sync 重捕 _base：reload 后 dirty(内存 _base/_parent 空)→ markSeen 闭合误报 collision 窗口（backlog）", async () => {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  await cloud.push("f", enc("V1"));
  const etag = cloud.getETag("f");
  // 模拟 reload：新建 head 但 kv 预置 dirty=1（durable 跨 reload），内存 _base/_parent 全空（从没 recordEdit/markSeen）。
  const headKv = memKv();
  headKv.set("head.dirty:f", "1");
  const head = createLocalHead({ kv: headKv, getCloudEtag: (n: string) => cloud.getETag(n) });
  const local = createMockLocal();
  await local.save("f", enc("MINE"));
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const { open } = createFreshness({ cloud, head, safeResolve });
  assert(head.isDirty("f"), "reload 后仍 dirty(kv durable)");
  // 修前：open in-sync 不 markSeen → _base/_parent 空 → ifMatchFor 走 no-base(null) → 推送 fail → 误报 collision。
  // 修后：open in-sync(云端 etag===seenBase 回退值)→ markSeen 重捕 _base + _parent。
  const r = await open("f");
  eq(r.reason, "in-sync", "云端没动 → in-sync");
  eq(head.ifMatchFor("f"), etag, "markSeen 后 push 的 If-Match = 当前云版 etag(不再 no-base 误报 collision)");
});

test("open clean → 静默快进（fast-forwarded，本地变云端版）", async () => {
  const { cloud, local, head, open } = rig();
  await cloud.push("f", enc("CLOUD"));
  head.markSeen("f", "OLD");                       // base 陈旧 ≠ 云端
  const r = await open("f");
  eq(r.source, "fast-forwarded", "clean → 快进");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版");
});

test("open dirty + takeCloud → pulled（先备份本地）", async () => {
  const { cloud, local, head, open } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("MINE")); head.markSeen("f", "OLD"); head.recordEdit("f");
  const r = await open("f", { onNewer: () => "takeCloud" });
  eq(r.source, "pulled", "takeCloud → 拉");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版（MINE 已备份）");
});

test("open dirty + cancel → 留本地（kept）", async () => {
  const { cloud, local, head, open } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("MINE")); head.markSeen("f", "OLD"); head.recordEdit("f");
  const r = await open("f", { onNewer: () => "cancel" });
  eq(r.reason, "kept", "cancel → 留本地");
  eq(await asStr(await local.get("f")), "MINE", "本地没动");
});

test("refresh dirty → dirty-skip（事件里绝不弹 sheet）", async () => {
  const { cloud, head, refresh } = rig();
  await cloud.push("f", enc("CLOUD")); head.markSeen("f", "OLD"); head.recordEdit("f");
  const r = await refresh("f");
  eq(r.status, "dirty-skip", "dirty → 跳过");
});

test("refresh clean 动过 → fast-forwarded", async () => {
  const { cloud, local, head, refresh } = rig();
  await cloud.push("f", enc("CLOUD")); head.markSeen("f", "OLD");
  const r = await refresh("f");
  eq(r.status, "fast-forwarded", "clean 动过 → 快进");
  eq(await asStr(await local.get("f")), "CLOUD", "本地更新");
});
