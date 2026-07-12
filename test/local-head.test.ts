import { test, eq, assert } from "./runner.mjs";
import { createLocalHead, BypassError } from "../src/store/local-head.ts";
import { memKv } from "../src/store/cloud-sync.ts";

// 一个可变的"云端当前 etag"，getCloudEtag 闭包读它（seenBase 回退 + 多 tab 共享 etag 模拟）。
function cloudEtagRef(initial: string | null = null) {
  const ref = { v: initial };
  return { ref, get: (_n: string) => ref.v };
}

test("W2 双-tab：B 用自己的 parent 不是共享 etag → 不静默覆盖", () => {
  const kv = memKv();                          // 两 tab 共享 localStorage
  const cloud = cloudEtagRef("v1");
  const A = createLocalHead({ kv, getCloudEtag: cloud.get });
  const B = createLocalHead({ kv, getCloudEtag: cloud.get });
  A.markSeen("f", "v1"); B.markSeen("f", "v1");

  A.recordEdit("f");
  eq(A.ifMatchFor("f"), "v1", "A 推 If-Match=v1");
  // A 推成功 → 云端到 v2
  cloud.ref.v = "v2"; A.onPushed("f", "v2", false);

  B.recordEdit("f");                            // B 基于它看到的 v1
  eq(B.ifMatchFor("f"), "v1", "B 仍用自己的 parent=v1，绝非共享新 etag v2");
  // → B 真去推会 If-Match=v1 vs 云端 v2 → 412 安全 surface，不静默覆盖
});

test("新文件首推：dirty 无 base → If-Match=null（不带 If-Match）", () => {
  const kv = memKv();
  const lh = createLocalHead({ kv, getCloudEtag: () => null });
  lh.recordEdit("new");                         // 从没 markSeen → 无 _base
  eq(lh.ifMatchFor("new"), null, "真新文件首推不带 If-Match");
});

test("bypass 守卫：dirty 被绕过 recordEdit 设置 + base 已知 → ifMatchFor 抛", () => {
  const kv = memKv();
  const lh = createLocalHead({ kv, getCloudEtag: () => null });
  lh.markSeen("f", "v1");                       // base=v1，clean，无 parent
  kv.set("head.dirty:f", "1");                  // ★直接戳 kv 标脏（模拟绕过 recordEdit 的脏写）
  let threw = false;
  try { lh.ifMatchFor("f"); } catch (e) { threw = e instanceof BypassError; }
  assert(threw, "dirty+base 已知+无 parent → BypassError");
  // 对照：走正门 recordEdit 则不抛
  const lh2 = createLocalHead({ kv: memKv(), getCloudEtag: () => null });
  lh2.markSeen("g", "v1"); lh2.recordEdit("g");
  eq(lh2.ifMatchFor("g"), "v1", "走正门 → 正常返 parent，不抛");
});

test("reload re-capture：dirty 持久活、内存丢 → markSeen 后不再 bypass", () => {
  const kv = memKv();
  kv.set("head.dirty:f", "1");                  // 上个 session 持久化的 dirty（未推字节在 IDB）
  const lh = createLocalHead({ kv, getCloudEtag: () => null });   // 新 tab：内存空
  assert(lh.isDirty("f"), "reload 后 dirty 从 kv 活着");
  lh.markSeen("f", "v3");                       // open 采纳云版 → 在此 re-capture parent
  eq(lh.ifMatchFor("f"), "v3", "re-capture parent=v3，不再抛 bypass");
});

test("捕获幂等：episode 内多次 recordEdit 只头一次抓 parent", () => {
  const kv = memKv();
  const cloud = cloudEtagRef("v1");
  const lh = createLocalHead({ kv, getCloudEtag: cloud.get });
  lh.markSeen("f", "v1");
  lh.recordEdit("f");                           // 抓 parent=v1
  lh.markSeen("f", "v2");                       // 后台 refresh 看到 v2（已 dirty，不该改 parent）
  lh.recordEdit("f");                           // 再次编辑
  eq(lh.ifMatchFor("f"), "v1", "parent 仍是头一次的 v1，不被 v2 污染");
});

test("seenBase 回退：缺 _base → cloud etag；且不进 dirty 的 If-Match", () => {
  const kv = memKv();
  const cloud = cloudEtagRef("cloudX");
  const lh = createLocalHead({ kv, getCloudEtag: cloud.get });
  eq(lh.seenBase("f"), "cloudX", "缺 _base → 回退共享 etag");
  lh.markSeen("f", "v1");
  eq(lh.seenBase("f"), "v1", "有 _base → 用 _base");
});

test("onPushed dirtyAfter=true → reparent 留 dirty；false → 清", () => {
  const kv = memKv();
  const lh = createLocalHead({ kv, getCloudEtag: () => null });
  lh.markSeen("f", "v1"); lh.recordEdit("f");
  lh.onPushed("f", "v2", true);                 // 推中又改
  assert(lh.isDirty("f"), "dirtyAfter → 仍 dirty");
  eq(lh.ifMatchFor("f"), "v2", "reparent：剩余编辑派生自刚推的 v2");
  lh.onPushed("f", "v3", false);               // 干净落地
  assert(!lh.isDirty("f"), "dirtyAfter=false → 清 dirty");
});

test("markSynced：采纳云版 → 清 dirty + base 推进", () => {
  const kv = memKv();
  const lh = createLocalHead({ kv, getCloudEtag: () => null });
  lh.markSeen("f", "v1"); lh.recordEdit("f");
  assert(lh.isDirty("f"), "编辑后 dirty");
  lh.markSynced("f", "v5");                     // pull/快进采纳云版
  assert(!lh.isDirty("f"), "采纳后 clean");
  eq(lh.seenBase("f"), "v5", "base 推进到 v5");
});
