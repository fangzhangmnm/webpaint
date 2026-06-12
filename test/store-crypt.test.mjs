// Store 加密 = 底座 operator + 透明 save/load（ADR-0012）验收。
// 真 store.ts + cloud-sync.ts + crypto-container.ts 跑在 MockCloudProvider + MockLocal 上。
// 验红线：① save/load 对调用方全透明（encode 出明文、load 收明文）；② 明文绝不落盘
//   （IDB 字节恒为容器）；③ 加密态切换两端一起换；④ 离线+已同步拒；⑤ 错密码零持久副作用；
//   ⑥ 密码经 crypt seam（getPassword/requestPassword/onPasswordVerified），store 不存密码；
//   ⑦ 云端文件名翻转成 .zip；⑧ peek 经 readPeek（非交互批量 / 交互解锁）。

import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded, ensure7zLoaded } from "./zip-node.mjs";

ensureZipLoaded();
await ensure7zLoaded();

const { createStore } = await import("../src/store/store.ts");
const { createCloudSync, memKv } = await import("../src/store/cloud-sync.ts");
const { createMockProvider } = await import("../src/store/mock-provider.ts");
const { createMockLocal } = await import("../src/store/mock-local.ts");
const { looksEncryptedContainer } = await import("../src/store/crypto-container.ts");
const { zipPack } = await import("../src/zip.js");
const { encryptPeek } = await import("../src/store/crypto-container.ts");

const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
// 造一个 v233-235 老容器（外壳明文 zip + WinZip-AES payload + peek）放进本地，验「读得回 + 存成 7z」。
async function makeOldWinzipContainer(ora, pw) {
  const z = globalThis.window.zip;
  const w = new z.ZipWriter(new z.BlobWriter("application/zip"), { password: pw, encryptionStrength: 3 });
  await w.add("data.bin", new z.Uint8ArrayReader(ora), { level: 0 });
  await w.add("meta.bin", new z.TextReader("WPMETA1\n" + JSON.stringify({ v: 1, name: "x", ext: "ora" })), { level: 0 });
  const payload = new Uint8Array(await (await w.close()).arrayBuffer());
  const peek = await encryptPeek(PNG, pw);
  const outer = await zipPack([{ path: "GUID-OLD", data: payload }, { path: "peek", data: peek }]);
  return new Uint8Array(await outer.arrayBuffer());
}

const bytes = (s) => new TextEncoder().encode(s);
const txt = (u8) => new TextDecoder().decode(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
// flow.load 的 blob：真 adapter 出 Blob，MockLocal 出 Uint8Array → 统一成字节
const blobU8 = async (b) => (b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer()));

// 密码政策替身（≈ crypto-state）：store seam **只有 getPassword**（非交互）。
//   弹窗/验证/重试是 UI 层的事（这里用 _set 模拟「app 在 busy 外 ensureUnlocked 后把密码放进内存」）。
function makeCrypt(initial = null) {
  let pw = initial;
  return {
    ext: "ora",
    makePeek: async () => PNG,          // app 解释为缩略图；store 不看
    getPassword: () => pw,
    _set: (p) => { pw = p; },           // 模拟 UI 解锁后 setPassword
  };
}

function mk(crypt) {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora", encFileName: (n) => n + ".zip",
    contentType: "application/zip", appKey: "wp", now: () => ++t,
    match: (it) => /\.(ora|zip)$/i.test(it.name || ""), toName: (p) => p.replace(/\.(ora|zip)$/i, ""),
  });
  const local = createMockLocal();
  const store = createStore({ cloud, local, kv: memKv(), backoffMs: 1, crypt });
  return { provider, cloud, local, store };
}
async function seedSynced(env, name, body) {
  await env.local.save(name, bytes(body));
  const { item } = await env.cloud.push(name, bytes(body));
  env.store.adoptBase(name, item.eTag);
  return item;
}
const localU8 = async (env, name) => { const b = await env.local.get(name); return b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer()); };
const cloudPath = async (env, path) => { const it = await env.provider.getItemByPath(path); return it ? new Uint8Array(await (await env.provider.download(it.id)).arrayBuffer()) : null; };

describe("Store.flow.save/load · 加密透明", () => {
  it("明文文件：save 出明文落明文、load 收明文", async () => {
    const env = mk(makeCrypt());
    await env.store.flow.save("画", { encode: () => bytes("plain-ora") });
    assert(!(await looksEncryptedContainer(await env.local.get("画"))), "明文落盘");
    const r = await env.store.flow.load("画");
    eq(r.status, "loaded"); eq(r.encrypted, false);
    eq(txt(await blobU8(r.blob)), "plain-ora");
  });

  it("加密文件：save 自动包壳（明文绝不落盘）、load 自动解壳出明文", async () => {
    const crypt = makeCrypt("pw");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("v1") });
    await env.store.flow.encrypt("画", {});
    assert(await looksEncryptedContainer(await env.local.get("画")), "已加密");
    await env.store.flow.save("画", { encode: () => bytes("v2-secret") });
    const onDisk = await localU8(env, "画");
    assert(await looksEncryptedContainer(onDisk), "save 后仍是容器");
    assert(txt(onDisk).indexOf("v2-secret") < 0, "明文不出现在落盘字节里");
    const r = await env.store.flow.load("画");
    eq(r.status, "loaded"); eq(r.encrypted, true);
    eq(txt(await blobU8(r.blob)), "v2-secret");
  });

  it("加密文件 save 时密码不在内存 → 响亮 LOCKED（绝不静默存明文）", async () => {
    const crypt = makeCrypt("pw");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("v1") });
    await env.store.flow.encrypt("画", {});
    crypt._set(null);
    let code = null;
    try { await env.store.flow.save("画", { encode: () => bytes("v2") }); } catch (e) { code = e.code; }
    eq(code, "LOCKED", "锁定时保存加密文件必须抛 LOCKED");
    assert(txt(await localU8(env, "画")).indexOf("v2") < 0, "落盘字节没被明文污染");
  });

  it("load 锁定（内存无密码）→ status:locked，不返回密文、**不弹窗**", async () => {
    const crypt = makeCrypt("pw");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("v1") });
    await env.store.flow.encrypt("画", {});
    crypt._set(null);   // 锁定（store 非交互：直接返 locked，绝不弹窗死锁）
    const r = await env.store.flow.load("画");
    eq(r.status, "locked");
    assert(!r.blob, "锁定不返回任何 blob");
  });

  it("load 内存密码错 → locked（store 不循环重问，重问是 UI 的事）", async () => {
    const crypt = makeCrypt("right");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("secret") });
    await env.store.flow.encrypt("画", {});
    crypt._set("wrong");
    eq((await env.store.flow.load("画")).status, "locked");
    // UI 解锁后（把对的放进内存）重 load → loaded
    crypt._set("right");
    const r = await env.store.flow.load("画");
    eq(r.status, "loaded");
    eq(txt(await blobU8(r.blob)), "secret");
  });

  it("verifyPassword：UI 解锁循环的便宜验证器（解 peek，对→true 错→false）", async () => {
    const crypt = makeCrypt("pw");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("v1") });
    await env.store.flow.encrypt("画", {});
    eq(await env.store.verifyPassword("画", "pw"), true, "对密码 → true");
    eq(await env.store.verifyPassword("画", "wrong"), false, "错密码 → false");
    eq(await env.store.verifyPassword("不存在", "pw"), false, "无字节 → false");
  });
});

describe("Store.flow.encrypt/decrypt · 两端一起换 + .zip 翻转", () => {
  it("已同步：本地+云端一起换成容器，云端文件名翻成 .zip", async () => {
    const env = mk(makeCrypt("pw"));
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.encrypt("猫", {});
    eq(res.status, "swapped"); eq(res.cloud, true);
    assert(await looksEncryptedContainer(await env.local.get("猫")), "本地容器");
    eq(await cloudPath(env, "猫.ora"), null, "旧 .ora 名已不在（翻转）");
    const zbytes = await cloudPath(env, "猫.zip");
    assert(zbytes && await looksEncryptedContainer(zbytes), "云端落 .zip 且是容器");
    eq(env.cloud.isDirty("猫"), false, "干净落地");
  });

  it("decrypt 翻回 .ora 明文，字节逐位还原", async () => {
    const env = mk(makeCrypt("pw"));
    await seedSynced(env, "猫", "v1-plain");
    await env.store.flow.encrypt("猫", {});
    const res = await env.store.flow.decrypt("猫", {});
    eq(res.status, "swapped"); eq(res.cloud, true);
    eq(txt(await localU8(env, "猫")), "v1-plain", "本地明文还原");
    eq(await cloudPath(env, "猫.zip"), null, "加密 .zip 名已不在");
    eq(txt(await cloudPath(env, "猫.ora")), "v1-plain", "云端翻回 .ora 明文");
  });

  it("已同步 + 离线 → offline，两端原样", async () => {
    const env = mk(makeCrypt("pw"));
    await seedSynced(env, "猫", "v1");
    const res = await env.store.flow.encrypt("猫", { isOnline: () => false });
    eq(res.status, "offline");
    eq(txt(await localU8(env, "猫")), "v1", "本地原样（不许只换一端）");
  });

  it("错密码 decrypt → 零持久副作用", async () => {
    const crypt = makeCrypt("pw");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("v1") });
    await env.store.flow.encrypt("画", {});
    const before = await localU8(env, "画");
    crypt._set("wrong");   // 锁定（无对密码）
    const res = await env.store.flow.decrypt("画", {});
    eq(res.status, "locked");
    assert(await looksEncryptedContainer(await localU8(env, "画")), "仍是容器");
    eq((await localU8(env, "画")).length, before.length, "字节原样");
  });
});

describe("Store.readPeek / getTailBytes", () => {
  it("加密文件 readPeek（非交互）解出 app peek 字节；明文文件 → null", async () => {
    const env = mk(makeCrypt("pw"));
    await env.store.flow.save("画", { encode: () => bytes("plain-ora-".repeat(2000)) });
    eq(await env.store.readPeek("画"), null, "明文无 peek");
    await env.store.flow.encrypt("画", {});
    const peek = await env.store.readPeek("画");
    assert(peek && peek.length === PNG.length, "加密文件 readPeek 出 peek 字节");
  });

  it("锁定时 readPeek 非交互 → null（图库批量渲染不弹窗）", async () => {
    const crypt = makeCrypt("pw");
    const env = mk(crypt);
    await env.store.flow.save("画", { encode: () => bytes("x") });
    await env.store.flow.encrypt("画", {});
    crypt._set(null);
    eq(await env.store.readPeek("画"), null, "非交互不弹窗，锁定返 null");
  });

  it("getTailBytes：本地尾片；不存在 → null", async () => {
    const env = mk(makeCrypt());
    await env.store.flow.save("画", { encode: () => bytes("0123456789") });
    const tail = await env.store.getTailBytes("画", 4);
    eq(txt(new Uint8Array(await tail.arrayBuffer())), "6789");
    eq(await env.store.getTailBytes("不存在", 4), null);
  });
});

describe("Store.isEncrypted", () => {
  it("按本地字节尾扫判定（SSoT=字节）", async () => {
    const env = mk(makeCrypt("pw"));
    await env.store.flow.save("画", { encode: () => bytes("v1") });
    eq(await env.store.isEncrypted("画"), false);
    await env.store.flow.encrypt("画", {});
    eq(await env.store.isEncrypted("画"), true);
  });
});

describe("向后兼容：老 WinZip-AES 容器 → 读得回 + 下次保存迁成 7z", () => {
  function payloadMagicOf(container) {
    // 解外层 zip 拿 <GUID> payload 的头 6 字节（粗暴：找首个 local file header 数据）。用 store 读更稳——
    // 这里直接验「load 出明文」+「save 后 at-rest 的 payload 是 7z magic」。
    return container;
  }
  it("flow.load 读出老容器明文；flow.save 后 at-rest payload 变 .7z", async () => {
    const env = mk(makeCrypt("pw"));
    const old = await makeOldWinzipContainer(bytes("我的老画内容"), "pw");
    await env.local.save("老画", old);                       // 直接塞老容器进本地
    eq(await env.store.isEncrypted("老画"), true, "老容器探测为加密");
    const r = await env.store.flow.load("老画");
    eq(r.status, "loaded");
    eq(txt(await blobU8(r.blob)), "我的老画内容", "WinZip-AES payload 读出明文（向后兼容）");
    // 改点内容再存 → _seal 用 pack7z 重打成 7z 容器
    await env.store.flow.save("老画", { encode: () => bytes("我的老画内容-改") });
    const after = await localU8(env, "老画");
    assert(await looksEncryptedContainer(after), "存后仍是加密容器");
    // at-rest 外壳仍是明文 zip，但内层 <GUID> payload 现在是 .7z（找 7z magic 出现在字节里即证明迁移）
    let has7z = false;
    for (let i = 0; i + 6 <= after.length; i++) { if (SEVENZ_MAGIC.every((b, k) => after[i + k] === b)) { has7z = true; break; } }
    assert(has7z, "迁移后 payload 是 .7z（出现 7z magic）");
    // 再 load 验明文还在
    const r2 = await env.store.flow.load("老画");
    eq(txt(await blobU8(r2.blob)), "我的老画内容-改", "迁移后仍读得回");
  });
});
