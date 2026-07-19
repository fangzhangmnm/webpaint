// P1（v435）：**非 upload 的云写也要 If-Match**。
//   红线原文是「every push is If-Match」，实现却成了「every **upload** is If-Match」——
//   move/rename 类破坏性写六处全裸。传输层一直支持 eTag（mock 会抛 412），缺的只是把参数传下去。
//   这些测试锁住「传下去了」，防止下次重构又漏。
import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const rig = () => {
  const provider = createMockProvider();
  return { provider, cloud: createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n }) };
};
async function is412(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return (e as { status?: number })?.status === 412; }
}

test("trash 带 If-Match：拿陈旧 base 去删 → 412（delete-vs-edit 的 edit-wins 由此强制，不再只靠读比对）", async () => {
  const { cloud } = rig();
  await cloud.push("f.ora", enc("V1"));
  const stale = cloud.getETag("f.ora");
  await cloud.push("f.ora", enc("V2-OTHER-DEVICE"));            // 别设备推新版
  assert(await is412(() => cloud.trash("f.ora", "evt1", { baseEtag: stale })), "陈旧 base → 412");
  eq(await (await cloud.pull("f.ora"))!.blob.text(), "V2-OTHER-DEVICE", "★ 别设备那版没被搬进 .trash");
});

test("trash 不传 baseEtag 时退回 item.eTag（仍闭合 _find→move 窗口，且正常删得掉）", async () => {
  const { cloud } = rig();
  await cloud.push("f.ora", enc("V1"));
  const moved = await cloud.trash("f.ora", "evt1");
  assert(moved, "正常路径仍能删");
  assert(!(await cloud.pull("f.ora")), "已移出主路径");
});

test("rename 带 If-Match：陈旧 base → 412，绝不静默改别设备新版的名", async () => {
  const { cloud } = rig();
  await cloud.push("f.ora", enc("V1"));
  const stale = cloud.getETag("f.ora");
  await cloud.push("f.ora", enc("V2-OTHER-DEVICE"));
  assert(await is412(() => cloud.rename("f.ora", "g.ora", { baseEtag: stale })), "陈旧 base → 412");
  eq(await (await cloud.pull("f.ora"))!.blob.text(), "V2-OTHER-DEVICE", "★ 原名原样，没被改走");
});

test("rename 正常路径（base 是最新）仍然成功 + 采纳服务端新 etag（S1：PATCH 必改 etag）", async () => {
  const { cloud } = rig();
  await cloud.push("f.ora", enc("V1"));
  const fresh = cloud.getETag("f.ora");
  await cloud.rename("f.ora", "g.ora", { baseEtag: fresh });
  eq(await (await cloud.pull("g.ora"))!.blob.text(), "V1", "改名成功");
  assert(cloud.getETag("g.ora") && cloud.getETag("g.ora") !== fresh, "新名锚在服务端返回的新 etag 上，不是旧的");
});

test("weakOverride 的 loser stash 带 If-Match（不把用户没见过的那版当 loser 搬走）", async () => {
  // hook 在 move 真正执行前插一版 → 精确模拟「_find 之后、move 之前云端被别设备推了」。
  let bumped = false;
  let cloud2: ReturnType<typeof createCloudSync>;
  const provider = createMockProvider({
    hook: async (op) => {
      if (op === "move" && !bumped) { bumped = true; await cloud2.push("f.ora", enc("V2-CONCURRENT")); }
    },
  });
  cloud2 = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  await cloud2.push("f.ora", enc("V1"));
  assert(await is412(() => cloud2.weakOverride("f.ora", enc("MINE"))), "并发窗口内云端变了 → 412，不静默把新版当 loser");
  eq(await (await cloud2.pull("f.ora"))!.blob.text(), "V2-CONCURRENT", "★ 那版还在原地，没被当 loser 搬进 .backup");
});

test("purge 带 If-Match：陈旧 eTag → 412（硬删不可逆，绝不按 id 盲删）", async () => {
  const { provider, cloud } = rig();
  await cloud.push("f.ora", enc("V1"));
  const item = await cloud.trash("f.ora", "evt1") as { id: string; eTag: string };
  const stale = item.eTag;
  await provider.rename(item.id, "renamed-by-other.ora");        // 别设备动了回收站里那项 → etag 变
  assert(await is412(() => cloud.purge(item.id, stale)), "陈旧 eTag → 412，不硬删");
});

test("remove()（活文件硬删、绕过 move-aside）已从契约上删除", () => {
  const { cloud } = rig();
  eq((cloud as unknown as Record<string, unknown>).remove, undefined, "零调用者 + 绕红线 → 不该继续挂在契约上");
});
