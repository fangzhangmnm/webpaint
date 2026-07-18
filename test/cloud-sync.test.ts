// cloud-sync push 对抗测试：no-base 同名碰撞 / H7 0字节 / claim 幂等 / 412。
//   这是引擎**唯一**静默丢数据路径（path-身份红线 + postmortem 2026-06-05 第④级）——
//   N6 尾字节守卫：同名同大小**异内容**绝不静默认领。补 WebPaint store-lost-response-claim 的对应覆盖。
import { test, eq, assert } from "./runner.mjs";
import { createCloudSync, memKv, CloudConflictError, CloudNameCollisionError } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  return { provider, cloud };
}
async function cloudStr(cloud: ReturnType<typeof rig>["cloud"], name: string): Promise<string | null> {
  const p = await cloud.pull(name); return p ? td.decode(new Uint8Array(await p.blob.arrayBuffer())) : null;
}

test("[cloud-sync] no-base 撞同名·同大小·同内容 → 认作我方 push（重试/回执丢幂等，synced）", async () => {
  const { provider, cloud } = rig();
  provider._seed("f", "SAMEDATA");                       // 云端已有（上次成功但回执丢 / 重试）
  const r = await cloud.push("f", enc("SAMEDATA"), { baseEtag: null });
  assert(!!r.item, "size+尾字节都符 → 认作我方 push");
  assert(!cloud.isDirty("f"), "synced（dirty 清）");
});

test("[cloud-sync] no-base 撞同名·同大小·**异内容** → CloudNameCollisionError，云端绝不被覆盖（N6 红线=唯一丢数据路径）", async () => {
  const { provider, cloud } = rig();
  provider._seed("f", "AAAA");                           // 别设备同名异文件（同大小 4B）
  let name = "";
  try { await cloud.push("f", enc("BBBB"), { baseEtag: null }); } catch (e) { name = (e as Error).name; }
  eq(name, "CloudNameCollisionError", "同大小异内容 → collision（不静默认领）");
  eq(await cloudStr(cloud, "f"), "AAAA", "云端字节没被我方覆盖（别人的作品不丢）");
});

test("[cloud-sync] no-base 撞同名·异大小 → CloudNameCollisionError，云端不被覆盖", async () => {
  const { provider, cloud } = rig();
  provider._seed("f", "OTHER-DEVICE-LONGER");
  let name = "";
  try { await cloud.push("f", enc("MINE"), { baseEtag: null }); } catch (e) { name = (e as Error).name; }
  eq(name, "CloudNameCollisionError", "异大小 → collision");
  eq(await cloudStr(cloud, "f"), "OTHER-DEVICE-LONGER", "云端不被覆盖");
});

test("[cloud-sync] no-base 撞 0字节占位 → 不认领、保持 dirty（防把空占位骗成 synced，postmortem ④）", async () => {
  const { provider, cloud } = rig();
  provider._seed("f", "");                               // 0 字节云端占位
  const r = await cloud.push("f", enc("REALDATA"), { baseEtag: null });
  assert(!r.item, "0字节占位 → 不认作我方 push（item null）");
  assert(cloud.isDirty("f") || cloud.getETag("f") == null, "保持未 synced（下次重试），绝不当成功");
});

test("[cloud-sync] 有 base 推但云端已变（etag 不符）→ 412 → CloudConflictError（陈旧推必挡）", async () => {
  const { provider, cloud } = rig();
  const seeded = provider._seed("f", "V1");
  cloud.setETag("f", seeded.eTag);                       // 本 tab 已见 V1
  await provider.upload("f", enc("V2-OTHERS"), { eTag: seeded.eTag });   // 别人推到 V2，etag 变
  let name = "";
  try { await cloud.push("f", enc("V1-EDIT"), { baseEtag: seeded.eTag }); } catch (e) { name = (e as Error).name; }
  eq(name, "CloudConflictError", "陈旧 base 推 → 412 → surface 冲突（不静默覆盖别人 V2）");
  eq(await cloudStr(cloud, "f"), "V2-OTHERS", "云端 V2 没被陈旧推盖掉");
});

test("[cloud-sync] 同名两次 weakOverride → .backup 两份（guid 防撞、loser 不丢）+ .backup 不漏进 listAll（不污染图库）", async () => {
  const { cloud } = rig();
  await cloud.push("f", enc("V1"));
  await cloud.weakOverride("f", enc("V2"));        // V1 loser → .backup，云端=V2
  await cloud.weakOverride("f", enc("V3"));        // V2 loser → .backup，云端=V3
  eq(await cloudStr(cloud, "f"), "V3", "云端=最新 V3");
  eq((await cloud.listBackup()).length, 2, "两份 .backup（同时钟 guid 防撞，没互相覆盖 → loser 都不丢）");
  const all = await cloud.listAll();
  assert(!all.files.some((f) => f.path.includes(".backup")), ".backup 不漏进 listAll 文件列（不污染图库列表）");
  assert(!all.folders.some((p) => p.includes(".backup")), ".backup 不漏进 folders");
});

test("[cloud-sync] 正常 no-base 新建（云端无同名）→ 成功 synced", async () => {
  const { cloud } = rig();
  const r = await cloud.push("g", enc("NEW"), { baseEtag: null });
  assert(!!r.item, "新建成功");
  eq(await cloudStr(cloud, "g"), "NEW", "云端是我方内容");
  assert(!cloud.isDirty("g"), "synced");
});

// ── deleteEmptyFolder：判空护栏（归 backend provider；返判别式 status 不 throw）。list-failed 覆盖见 folder-delete.test。──
test("[cloud-sync] deleteEmptyFolder：空夹 → status=deleted", async () => {
  const { provider, cloud } = rig();
  await provider.ensureFolder("Empty");
  eq((await cloud.deleteEmptyFolder("Empty")).status, "deleted", "空夹删成功");
  assert(!(await provider.getItemByPath("Empty")), "夹没了");
});

test("[cloud-sync] deleteEmptyFolder：非空夹 → status=non-empty（不删，绝不递归）", async () => {
  const { provider, cloud } = rig();
  await provider.ensureFolder("F");
  await provider.upload("F/child.ora", enc("C"));
  eq((await cloud.deleteEmptyFolder("F")).status, "non-empty", "非空 → 不删");
  assert(await provider.getItemByPath("F/child.ora"), "子项还在（没被递归删）");
  assert(await provider.getItemByPath("F"), "夹还在");
});

test("[cloud-sync] deleteEmptyFolder：不存在的夹 → status=already-gone（幂等）", async () => {
  const { cloud } = rig();
  eq((await cloud.deleteEmptyFolder("Nope")).status, "already-gone", "本就没有 → 幂等成功");
});
