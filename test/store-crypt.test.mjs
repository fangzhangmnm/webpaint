// Store flow.encrypt / flow.decrypt / getTailBytes 验收（加密 = store 底座 operator，ADR-0012）。
// 真 store.ts + 真 cloud-sync.ts + 真 crypto-container.ts 跑在 MockCloudProvider + MockLocal 上。
// 验深模块红线：本地与云端字节一起换；离线+已同步 → 拒；错密码零持久副作用；
// 云端没跟上 → 标脏+锚 parent 让正常 push 流接力收敛（v233 教训：只换一端 = 加密被静默撤销）。

import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded } from "./zip-node.mjs";

ensureZipLoaded();

const { createStore } = await import("../src/store/store.ts");
const { createCloudSync, memKv } = await import("../src/store/cloud-sync.ts");
const { createMockProvider } = await import("../src/store/mock-provider.ts");
const { createMockLocal } = await import("../src/store/mock-local.ts");
const { looksEncryptedContainer, unpackContainer, scanEncThumbFromEnd, decryptThumbParsed } =
  await import("../src/store/crypto-container.ts");

const bytes = (s) => new TextEncoder().encode(s);
const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const PW = "口令abc";

function mk() {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora",
    contentType: "application/zip", appKey: "wp", now: () => ++t,
  });
  const local = createMockLocal();
  const store = createStore({ cloud, local, kv: memKv(), backoffMs: 1 });
  return { provider, cloud, local, store };
}
async function seedSynced(env, name, body) {
  await env.local.save(name, bytes(body));
  const { item } = await env.cloud.push(name, bytes(body));
  env.store.adoptBase(name, item.eTag);
  return item;
}
const localU8 = async (env, name) => new Uint8Array(await (async (b) => b.arrayBuffer ? b.arrayBuffer() : b)(await env.local.get(name)));
const txt = (u8) => new TextDecoder().decode(u8);

describe("Store.flow.encrypt", () => {
  it("纯本地：换成容器、不碰云端", async () => {
    const env = mk();
    await env.local.save("画", bytes("plain-ora"));
    const res = await env.store.flow.encrypt("画", { password: PW, thumbPng: PNG_STUB, ext: "ora" });
    eq(res.status, "swapped"); eq(res.cloud, false);
    const u8 = await env.local.get("画");
    assert(await looksEncryptedContainer(u8), "本地已是容器");
    eq(await env.provider.getItemByPath("画.ora"), null, "云端没被碰");
    // 容器可解回原字节 + meta 带真名
    const { dataBlob, meta } = await unpackContainer(new Blob([u8]), PW);
    eq(txt(new Uint8Array(await dataBlob.arrayBuffer())), "plain-ora");
    eq(meta.name, "画"); eq(meta.ext, "ora");
  });

  it("已同步：本地+云端一起换、etag 推进、不留 dirty", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.encrypt("猫", { password: PW, thumbPng: PNG_STUB, ext: "ora" });
    eq(res.status, "swapped"); eq(res.cloud, true);
    assert(await looksEncryptedContainer(await env.local.get("猫")), "本地容器");
    const cloudItem = await env.provider.getItemByPath("猫.ora");
    const cloudBytes = new Uint8Array(await (await env.provider.download(cloudItem.id)).arrayBuffer());
    assert(await looksEncryptedContainer(cloudBytes), "云端容器（两端一起换）");
    eq(env.cloud.isDirty("猫"), false, "干净落地");
    eq(env.cloud.getETag("猫"), cloudItem.eTag, "etag 采纳新版");
  });

  it("已同步 + 离线 → 拒绝（status:offline），两端原样", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.encrypt("猫", { password: PW, thumbPng: PNG_STUB, isOnline: () => false });
    eq(res.status, "offline");
    eq(txt(await localU8(env, "猫")), "v1", "本地原样（不许只换一端）");
    eq(env.cloud.isDirty("猫"), false);
  });

  it("已是容器 → already（幂等，不重复包壳）", async () => {
    const env = mk();
    await env.local.save("画", bytes("plain"));
    await env.store.flow.encrypt("画", { password: PW, thumbPng: PNG_STUB });
    const res = await env.store.flow.encrypt("画", { password: PW, thumbPng: PNG_STUB });
    eq(res.status, "already");
  });

  it("云端被别人动过（412）→ 本地已换 + 标脏；后续 push 冲突正常 surface（绝不静默）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    // 别的设备推了新版（etag 前进）
    await env.provider.upload("猫.ora", bytes("v2-other-device"), { contentType: "application/zip" });
    const res = await env.store.flow.encrypt("猫", { password: PW, thumbPng: PNG_STUB });
    eq(res.status, "conflict");
    assert(await looksEncryptedContainer(await env.local.get("猫")), "本地已换（字节真相）");
    eq(env.cloud.isDirty("猫"), true, "标脏 → 正常 push 流接管");
    // 接力：下次 push 用锚的 parent（换前云版）→ 仍 412 → onConflict surface
    let surfaced = false;
    const pushRes = await env.store.flow.push("猫", {
      encode: async () => new Uint8Array(await (await env.local.get("猫")).arrayBuffer?.() ?? await env.local.get("猫")),
      onConflict: async () => { surfaced = true; return "keep"; },
    });
    assert(surfaced, "冲突弹给用户（不静默覆盖别人的 v2）");
    eq(pushRes.status, "conflict");
    eq(txt(new Uint8Array(await (await env.provider.download((await env.provider.getItemByPath("猫.ora")).id)).arrayBuffer())), "v2-other-device", "云端 v2 没被覆盖");
  });

  it("尾部 thumb 可经 getTailBytes 解出（80KB 窗口内）", async () => {
    const env = mk();
    await env.local.save("画", bytes("plain-ora-".repeat(3000)));   // ~30KB
    await env.store.flow.encrypt("画", { password: PW, thumbPng: PNG_STUB });
    const tail = await env.store.getTailBytes("画", 81920);
    const parsed = scanEncThumbFromEnd(new Uint8Array(await tail.arrayBuffer()));
    assert(parsed, "尾片扫到 MAGIC");
    const png = await decryptThumbParsed(parsed, PW);
    eq(png.length, PNG_STUB.length, "解回原 PNG");
  });
});

describe("Store.flow.decrypt", () => {
  it("已同步容器 → 本地+云端一起换回明文，字节逐位还原", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1-plain-bytes");
    await env.store.flow.encrypt("猫", { password: PW, thumbPng: PNG_STUB, ext: "ora" });
    const res = await env.store.flow.decrypt("猫", { password: PW });
    eq(res.status, "swapped"); eq(res.cloud, true);
    eq(txt(await localU8(env, "猫")), "v1-plain-bytes", "本地明文逐位还原");
    const cloudItem = await env.provider.getItemByPath("猫.ora");
    eq(txt(new Uint8Array(await (await env.provider.download(cloudItem.id)).arrayBuffer())), "v1-plain-bytes", "云端明文");
    eq(env.cloud.isDirty("猫"), false);
  });

  it("错密码 → throw code=WRONG_PASSWORD，零持久副作用", async () => {
    const env = mk();
    await env.local.save("画", bytes("plain"));
    await env.store.flow.encrypt("画", { password: PW, thumbPng: PNG_STUB });
    const before = await localU8(env, "画");
    let code = null;
    try { await env.store.flow.decrypt("画", { password: "wrong" }); } catch (e) { code = e.code; }
    eq(code, "WRONG_PASSWORD");
    const after = await localU8(env, "画");
    eq(before.length, after.length, "本地字节原样（错密码不动任何持久态）");
    assert(await looksEncryptedContainer(after), "仍是容器");
  });

  it("明文文件 → not-encrypted（幂等）", async () => {
    const env = mk();
    await env.local.save("画", bytes("plain"));
    const res = await env.store.flow.decrypt("画", { password: PW });
    eq(res.status, "not-encrypted");
  });
});

describe("Store.getTailBytes", () => {
  it("取尾部 N 字节；不存在 → null", async () => {
    const env = mk();
    await env.local.save("画", bytes("0123456789"));
    const tail = await env.store.getTailBytes("画", 4);
    eq(txt(new Uint8Array(await tail.arrayBuffer())), "6789");
    eq(await env.store.getTailBytes("不存在", 4), null);
  });
});
