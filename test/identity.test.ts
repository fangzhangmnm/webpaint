import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createSafeResolve } from "../src/store/safe-resolve.ts";
import { createSubstrate } from "../src/store/substrate.ts";
import { createPush } from "../src/store/push.ts";
import { createIdentity } from "../src/store/identity.ts";

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
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const sub = createSubstrate();
  const { doPush } = createPush({ cloud, head, seal: sealPass, safeResolve, serialize: sub.serialize, editVersion: () => 0 });
  const id = createIdentity({ cloud, local, head, doPush, serialize: sub.serialize, serialize2: sub.serialize2 });
  return { provider, cloud, local, head, ...id };
}

test("rename local-only：新名先存、旧名后删（phantom-path）", async () => {
  const { local, rename } = rig();
  await local.save("old.pdf", enc("DATA"));
  const r = await rename("old.pdf", "new.pdf", { cloud: false });
  eq(r.where, "local", "本地改名");
  assert(await local.exists("new.pdf"), "新名在");
  assert(!(await local.exists("old.pdf")), "旧名删");
  eq(await asStr(await local.get("new.pdf")), "DATA", "字节搬过去");
});

test("rename cloud synced → 服务端 move（etag 顺延）", async () => {
  const { cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("DATA")); await local.save("old.pdf", enc("DATA"));
  head.markSeen("old.pdf", cloud.getETag("old.pdf"));      // synced（不 dirty）
  const r = await rename("old.pdf", "new.pdf");
  eq(r.where, "cloud-move", "服务端 move");
  eq(await asStr((await cloud.pull("new.pdf"))?.blob), "DATA", "云端新名有字节");
});

// （原「saveAs：写新身份，云端有」已随 identity.saveAs 删除——写新身份统一走
//   file(name,{mode:"new"}).save()，覆盖在 store-folder-listing.test.mjs 的目标占用护栏一节。）

test("rename dirty：推当前字节到新名 + 旧名进云端 .trash（脏字节不丢、不 hard-delete C5）", async () => {
  const { cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("ORIG"));
  head.markSeen("old.pdf", cloud.getETag("old.pdf"));
  await local.save("old.pdf", enc("EDITED")); head.recordEdit("old.pdf");   // dirty + 本地新字节
  const r = await rename("old.pdf", "new.pdf");
  eq(r.where, "cloud-push+trash", "dirty → 推新名 + 旧名进 trash");
  assert(!r.oldCloudOrphan, "旧名 trash 成功");
  eq(await asStr((await cloud.pull("new.pdf"))?.blob), "EDITED", "新名=当前编辑字节（脏字节没丢）");
  assert(!(await cloud.pull("old.pdf")), "旧名已移出主路径（进了 .trash，可恢复）");
});

test("rename dirty + 旧名 trash 失败 → oldCloudOrphan（surface 不吞，新名已推不回滚）", async () => {
  const { provider, cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("ORIG"));
  head.markSeen("old.pdf", cloud.getETag("old.pdf"));
  await local.save("old.pdf", enc("EDITED")); head.recordEdit("old.pdf");
  provider.injectFault({ op: "move", kind: "error", status: 500 });   // cloud.trash 的 move 失败
  const r = await rename("old.pdf", "new.pdf");
  assert(r.oldCloudOrphan, "旧名 trash 失败 → oldCloudOrphan=true（surface 让 caller 处理）");
  eq(await asStr((await cloud.pull("new.pdf"))?.blob), "EDITED", "新名已推成功（不因旧名 trash 失败回滚）");
});

test("rename dirty + 云推失败 → cloudDeferred + newName 标脏（待推，下次 sync 自动收敛，不必重跑 rename）", async () => {
  const { provider, cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("ORIG"));
  head.markSeen("old.pdf", cloud.getETag("old.pdf"));
  await local.save("old.pdf", enc("EDITED")); head.recordEdit("old.pdf");
  provider.injectFault({ op: "upload", kind: "error", status: 500, times: 99 });   // 云推全失败（耗尽 retry）
  const r = await rename("old.pdf", "new.pdf");
  assert(r.cloudDeferred, "云推失败 → cloudDeferred（surface）");
  assert(await local.exists("new.pdf"), "本地已是 new.pdf");
  assert(head.isDirty("new.pdf"), "newName 标脏=待推（下次 push 自动带走 → 自动收敛，不必重跑 rename）");
});

// ── 改名 = 上传失败后的逃生通道（用户 2026-07-18 拍定）。────────────────────────────────────
//   「推新名 + 旧名进 .trash」的 move 语义隐含前提：本地字节是旧名云端字节的**后代**。
//   谱系断了这个前提就不成立 —— 而谱系断正是用户来改名的原因。此时必须降级为「另存」，
//   否则逃生通道就是斩杀线（真机事故：用户改名自愈，远端旧画消失）。
test("rename 谱系不明（reload 后 durable etag 空）→ 降级为另存：★云端旧画原封不动", async () => {
  const { cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("CLOUD-ORIG"));
  cloud.setETag("old.pdf", null);                                           // 模拟：版本更新 reload，内存谱系没了、durable etag 从没写过
  await local.save("old.pdf", enc("EDITED")); head.recordEdit("old.pdf");   // dirty，但 _parent=null ∧ seenBase=null → 谱系不明
  const r = await rename("old.pdf", "new.pdf");
  eq(r.where, "cloud-push+kept", "谱系不明 → 另存语义");
  assert(r.oldKept, "oldKept=true（caller 必须告诉用户「旧的还在」）");
  eq(await asStr((await cloud.pull("new.pdf"))?.blob), "EDITED", "新名 = 本地字节（逃生成功）");
  eq(await asStr((await cloud.pull("old.pdf"))?.blob), "CLOUD-ORIG", "★ 云端旧画原封不动（没被挪进 .trash）");
});

test("rename 谱系已分叉（云端被别的设备推过新版）→ 同样降级为另存，不碰旧名", async () => {
  const { cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("V1"));
  head.markSeen("old.pdf", cloud.getETag("old.pdf"));                       // 本机见到的是 V1
  await local.save("old.pdf", enc("EDITED")); head.recordEdit("old.pdf");   // 基于 V1 编辑
  await cloud.push("old.pdf", enc("V2-FROM-OTHER-DEVICE"));                 // 别的设备推了 V2 → 云端 etag 前进
  const r = await rename("old.pdf", "new.pdf");
  eq(r.where, "cloud-push+kept", "base≠云端 etag → 另存语义");
  eq(await asStr((await cloud.pull("old.pdf"))?.blob), "V2-FROM-OTHER-DEVICE", "★ 别的设备那版没被吃掉");
});

test("rename：encode 抛错 → 旧名本地不丢（phantom-path：先存新再删旧，没存成就没删）", async () => {
  const { local, rename } = rig();
  await local.save("old.pdf", enc("DATA"));
  let threw = false;
  try { await rename("old.pdf", "new.pdf", { encode: () => { throw new Error("boom"); } }); } catch { threw = true; }
  assert(threw, "encode 抛 → rename 抛");
  assert(await local.exists("old.pdf"), "旧名本地还在（落盘前失败，绝没先删）");
  assert(!(await local.exists("new.pdf")), "新名没建");
});

test("acquire：云端 item → 本地 + adopt", async () => {
  const { cloud, local, acquire } = rig();
  await cloud.push("remote.pdf", enc("REMOTE"));
  let adopted: string | null = null;
  const r = await acquire("remote.pdf", { adopt: (_b, n) => { adopted = n; } });
  eq(r.status, "acquired", "拉取成功");
  eq(await asStr(await local.get("remote.pdf")), "REMOTE", "落本地");
  eq(adopted, "remote.pdf", "adopt 回调");
});
