// 加密容器（ADR-0012：明文 zip 外壳 + .7z payload + 尾部加密 peek）验收。
//
// node 跑真 zip.js（外壳）+ **真 7z-wasm**（payload，vendored）+ 真 WebCrypto（peek）。
// 互操作性：payload 是真 .7z —— 一个全新 7z-wasm 实例（= 模拟「另一台机器的 7-Zip」）
// 用密码解开 <GUID> → data.bin 逐位还原，证明 7-Zip 输密码能开。
// 真桌面 7-Zip 实测仍留给 PC 真机批（见 docs/encryption.md 待验清单）。

import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded, ensure7zLoaded } from "./zip-node.mjs";

ensureZipLoaded();
await ensure7zLoaded();

const {
  packContainer, unpackContainer, looksEncryptedContainer,
  scanEncPeekFromEnd, decryptPeek, encryptPeek,
  makeGuid, PEEK_TAIL_WINDOW,
} = await import("../src/store/crypto-container.ts");
const { zipPack } = await import("../src/zip.js");
const { pack7z } = await import("../src/sevenzip.js");

// ---- 测试素材 ----
const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const ORA_STUB = new TextEncoder().encode("fake-ora-bytes-".repeat(1000));   // ~15KB
const PW = "测试密码123";

async function makeFixture(name = "文件夹/我的画", peek = PNG_STUB) {
  const guid = makeGuid();
  const blob = await packContainer({ dataBytes: ORA_STUB, fileName: name, ext: "ora", guid, peek, password: PW });
  return { guid, blob, bytes: new Uint8Array(await blob.arrayBuffer()) };
}
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("crypto-container · 容器往返", () => {
  it("pack → unpack 还原原始 ora 字节 + meta + guid", async () => {
    const { guid, blob } = await makeFixture();
    const res = await unpackContainer(blob, PW);
    eq(res.guid, guid, "guid 是外层明文 entry 名");
    eq(res.meta.name, "文件夹/我的画", "meta.bin 带真名");
    eq(res.meta.ext, "ora");
    const ora = new Uint8Array(await res.dataBlob.arrayBuffer());
    assert(bytesEq(ora, ORA_STUB), "data.bin 字节逐位还原");
  });

  it("错密码 → throw（不返回坏数据）", async () => {
    const { blob } = await makeFixture();
    let threw = false;
    try { await unpackContainer(blob, "wrong"); } catch (_) { threw = true; }
    assert(threw, "错密码必须抛");
  });

  it("容器探测：容器 true，明文 zip false，垃圾字节 false", async () => {
    const { blob } = await makeFixture();
    assert(await looksEncryptedContainer(blob), "容器 → true");
    const plain = await zipPack([{ path: "stack.xml", data: "<image/>" }, { path: "Thumbnails/thumbnail.png", data: PNG_STUB }]);
    assert(!(await looksEncryptedContainer(plain)), "明文 ora 形 zip → false");
    assert(!(await looksEncryptedContainer(new Uint8Array(1000))), "垃圾 → false");
  });
});

describe("crypto-container · 向后兼容 + 容错读取", () => {
  // 模拟 v233-235 老容器：外壳明文 zip { <GUID>=WinZip-AES zip, peek }。zip.js 不再写 WinZip-AES，
  // 这里用一段预生成的 WinZip-AES payload 验「读得回」——改用「外壳里塞一个 7z payload 但没 peek」+
  // 「裸 7z」+「缺 meta/data.bin」覆盖主要容错路径（WinZip-AES 读路径靠 zipUnpackEncrypted 单测兜）。

  it("裸 .7z（无外壳无 peek，手工 mock）→ 探测为加密 + 解出内容", async () => {
    const sevenz = await pack7z([{ path: "data.bin", data: ORA_STUB }, { path: "meta.bin", data: "WPMETA1\n" + JSON.stringify({ v: 1, name: "手工", ext: "ora" }) }], PW);
    assert(await looksEncryptedContainer(sevenz), "裸 .7z 首字节 magic → 探测 true");
    const res = await unpackContainer(new Blob([sevenz]), PW);
    assert(bytesEq(new Uint8Array(await res.dataBlob.arrayBuffer()), ORA_STUB), "裸 .7z 解出 data.bin");
    eq(res.meta.name, "手工", "meta 仍读出");
  });

  it("裸 .7z 缺 meta.bin → 仍解出（name/ext 未知，data 取唯一 entry）", async () => {
    const sevenz = await pack7z([{ path: "data.bin", data: ORA_STUB }], PW);
    const res = await unpackContainer(new Blob([sevenz]), PW);
    assert(bytesEq(new Uint8Array(await res.dataBlob.arrayBuffer()), ORA_STUB), "无 meta 也解出");
    eq(res.meta, null, "meta 缺失 → null");
  });

  it("裸 .7z 把 ora 直接当 entry（不叫 data.bin）→ 取首个非 meta entry 当本体", async () => {
    const sevenz = await pack7z([{ path: "我的画.ora", data: ORA_STUB }], PW);
    const res = await unpackContainer(new Blob([sevenz]), PW);
    assert(bytesEq(new Uint8Array(await res.dataBlob.arrayBuffer()), ORA_STUB), "data.bin 缺失 → fallback 首个 entry");
  });

  it("外壳容器内 payload 是 7z（缺 meta.bin）→ 解出 data 本体", async () => {
    const payload7z = await pack7z([{ path: "data.bin", data: ORA_STUB }], PW);
    const peek = await encryptPeek(PNG_STUB, PW);
    const container = await zipPack([{ path: makeGuid(), data: payload7z }, { path: "peek", data: peek }]);
    assert(await looksEncryptedContainer(container), "带 peek 容器 → true");
    const res = await unpackContainer(container, PW);
    assert(bytesEq(new Uint8Array(await res.dataBlob.arrayBuffer()), ORA_STUB), "外壳+7z payload 解出");
  });

  it("裸 .7z 错密码 → throw", async () => {
    const sevenz = await pack7z([{ path: "data.bin", data: ORA_STUB }], PW);
    let threw = false;
    try { await unpackContainer(new Blob([sevenz]), "wrong"); } catch (_) { threw = true; }
    assert(threw);
  });

  // v233-235 真实老容器：payload = WinZip-AES zip（用 zip.js 直接造，模拟当年 zipPackEncrypted 产物）。
  async function makeWinzipAesZip(entries, pw) {
    const z = globalThis.window.zip;
    const w = new z.ZipWriter(new z.BlobWriter("application/zip"), { password: pw, encryptionStrength: 3 });
    for (const { path, data } of entries) {
      const u8 = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      await w.add(path, new z.Uint8ArrayReader(u8), { level: 0 });
    }
    return new Uint8Array(await (await w.close()).arrayBuffer());
  }

  it("v233-235 老容器（外壳 + WinZip-AES payload + peek）→ 7z 代码也能读出", async () => {
    const aesPayload = await makeWinzipAesZip([
      { path: "data.bin", data: ORA_STUB },
      { path: "meta.bin", data: "WPMETA1\n" + JSON.stringify({ v: 1, name: "老画", ext: "ora" }) },
    ], PW);
    const peek = await encryptPeek(PNG_STUB, PW);
    const container = await zipPack([{ path: makeGuid(), data: aesPayload }, { path: "peek", data: peek }]);
    assert(await looksEncryptedContainer(container), "老容器仍探测为加密（peek 不变）");
    const res = await unpackContainer(container, PW);
    assert(bytesEq(new Uint8Array(await res.dataBlob.arrayBuffer()), ORA_STUB), "WinZip-AES payload 逐位解出（向后兼容）");
    eq(res.meta.name, "老画", "老 meta 读出");
  });

  it("裸 WinZip-AES zip（无外壳，手工 mock）→ 解出", async () => {
    const aesZip = await makeWinzipAesZip([{ path: "data.bin", data: ORA_STUB }], PW);
    const res = await unpackContainer(new Blob([aesZip]), PW);
    assert(bytesEq(new Uint8Array(await res.dataBlob.arrayBuffer()), ORA_STUB), "裸 WinZip-AES 解出");
  });
});

describe("crypto-container · 尾部加密 peek（byte-range 路径，格式盲）", () => {
  it("只拿尾部窗口就能扫到 + 解密回不透明字节", async () => {
    const { bytes } = await makeFixture();
    const tail = bytes.slice(Math.max(0, bytes.length - PEEK_TAIL_WINDOW));
    const parsed = scanEncPeekFromEnd(tail);
    assert(parsed, "尾部窗口内必须扫到 MAGIC（peek 是外层最后 entry）");
    const out = await decryptPeek(parsed, PW);
    assert(bytesEq(out, PNG_STUB), "解密 == 原 peek 字节");
  });

  it("80KB suffix（byte-range 预算）也命中", async () => {
    const { bytes } = await makeFixture();
    const tail = bytes.slice(Math.max(0, bytes.length - 81920));
    assert(scanEncPeekFromEnd(tail), "80KB suffix 命中");
  });

  it("空 peek 也是合法容器（探测标记必须在）", async () => {
    const { bytes } = await makeFixture("空peek件", null);
    assert(await looksEncryptedContainer(bytes), "空 peek 容器仍探测为 true");
    const parsed = scanEncPeekFromEnd(bytes);
    const out = await decryptPeek(parsed, PW);
    eq(out.length, 0, "解出空字节");
  });

  it("peek 错密码 → throw code=WRONG_PASSWORD（AES-GCM tag 即验证器）", async () => {
    const enc = await encryptPeek(PNG_STUB, PW);
    const parsed = scanEncPeekFromEnd(enc);
    let code = null;
    try { await decryptPeek(parsed, "wrong"); } catch (e) { code = e.code; }
    eq(code, "WRONG_PASSWORD");
  });
});

// 密码循环（getPassword/requestPassword/onPasswordVerified）已移进 store 的 crypt seam，
// 验收在 test/store-crypt.test.mjs（store.flow.load / decrypt 的密码循环）。

// 密码循环（getPassword/requestPassword/onPasswordVerified）已移进 store 的 crypt seam，
// 验收在 test/store-crypt.test.mjs（store.flow.load / decrypt 的密码循环）。

// ============ 互操作性：payload 是真 .7z（7-Zip 可开）============
// 只用最小 zip parser 取出外层 <GUID> 字节（外壳是明文 zip），断言它是 .7z；再用**全新** 7z-wasm
// 实例（= 另一台机器的 7-Zip）输密码解出 data.bin → 逐位还原。

const { unpack7z } = await import("../src/sevenzip.js");

function parseOuterZip(u8) {
  // 外壳明文 zip：EOCD → CD → local header（最小 32-bit parser）
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === u8.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD 没找到");
  const cdOff = v.getUint32(eocd + 16, true), cdSize = v.getUint32(eocd + 12, true);
  const entries = [];
  let p = cdOff;
  while (p < cdOff + cdSize) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commLen = v.getUint16(p + 32, true);
    const localOff = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nameLen));
    const lNameLen = v.getUint16(localOff + 26, true), lExtraLen = v.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    entries.push({ name, method, compSize, data: u8.slice(dataOff, dataOff + compSize) });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];   // "7z\xBC\xAF\x27\x1C"

describe("互操作性 · 外壳明文 zip + payload 真 .7z（7-Zip 可开）", () => {
  it("外壳 CD 干净：[<GUID>, peek] 两 entry、全 STORE、payload 是 .7z magic", async () => {
    const { guid, bytes } = await makeFixture("真名");
    const outer = parseOuterZip(bytes);
    eq(outer.length, 2);
    eq(outer[0].name, guid, "payload entry 名 = GUID");
    eq(outer[1].name, "peek", "peek 最后");
    eq(outer[0].method, 0, "外层 STORE 明文（扫描器只见不透明字节）");
    eq(outer[1].method, 0);
    for (let i = 0; i < 6; i++) eq(outer[0].data[i], SEVENZ_MAGIC[i], "payload 是 .7z");
  });

  it("全新 7z-wasm 实例输密码解 payload → data.bin 逐位 == 原 ora；meta 给真名", async () => {
    const { guid, bytes } = await makeFixture("真名");
    const payload = parseOuterZip(bytes).find((e) => e.name === guid).data;
    const inner = await unpack7z(payload, PW);   // 模拟「另一端 7-Zip」
    assert(inner["data.bin"] && inner["meta.bin"], "payload 内 data.bin + meta.bin");
    assert(bytesEq(inner["data.bin"], ORA_STUB), "解出的 data.bin == 原 ora 字节（7-Zip 同理可开）");
    const metaText = new TextDecoder().decode(inner["meta.bin"]);
    assert(metaText.startsWith("WPMETA1\n"), "meta magic");
    eq(JSON.parse(metaText.slice(8)).name, "真名", "恢复路径：meta.bin 给出真名");
  });

  it("7z payload 拒绝错密码（加密头 → 列不出目录）", async () => {
    const { guid, bytes } = await makeFixture();
    const payload = parseOuterZip(bytes).find((e) => e.name === guid).data;
    let code = null;
    try { await unpack7z(payload, "wrong"); } catch (e) { code = e.code; }
    eq(code, "WRONG_PASSWORD");
  });
});
