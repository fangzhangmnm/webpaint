// 加密容器（ADR-0012 三层双 zip + 尾部加密 thumb）验收。
//
// node 跑真 zip.js（vendored UMD，require 进来挂 window.zip）+ 真 WebCrypto（node ≥ 19）。
// 互操作性验证：本机没有 7z 二进制，所以用**独立实现的 WinZip-AES 解密器**
// （node:crypto，按 WinZip AE-2 规范：PBKDF2-SHA1×1000 → AES-256-CTR(LE counter) → HMAC-SHA1）
// 解开 zip.js 产出的 payload —— 两个独立实现互通 = 格式是标准的 = 7-zip 能开。
// 真 7-zip 实测仍留给 PC 真机批（见 docs/encryption.md 待验清单）。

import nodeCrypto from "node:crypto";
import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded } from "./zip-node.mjs";

ensureZipLoaded();

const {
  packContainer, unpackContainer, looksEncryptedContainer,
  scanEncPeekFromEnd, decryptPeek, encryptPeek,
  makeGuid, PEEK_TAIL_WINDOW,
} = await import("../src/store/crypto-container.ts");
const { zipPack } = await import("../src/zip.js");

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

// ============ 互操作性：独立 WinZip-AES 解密器（≈ 7-zip 做的事）============
//
// 不用 zip.js 的任何代码：手动 parse 外层/内层 zip 结构 + node:crypto 按 WinZip AE 规范解密。
// WinZip AES extra field 0x9901；data = salt(16) + pwVerify(2) + ct + authcode(10)；
// key = PBKDF2-HMAC-SHA1(pw, salt, 1000, 32+32+2)；AES-256-CTR，counter 从 1 起**小端**自增。

function parseZipEntries(u8) {
  // 经 EOCD → central directory → local header（与 cloud-thumbs 同思路的最小 parser）
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
    // local header → 数据偏移 + local extra（AES extra field 在这里也有）
    const lNameLen = v.getUint16(localOff + 26, true), lExtraLen = v.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const extra = u8.slice(localOff + 30 + lNameLen, localOff + 30 + lNameLen + lExtraLen);
    entries.push({ name, method, compSize, data: u8.slice(dataOff, dataOff + compSize), extra });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

function winzipAesDecrypt(entry, password) {
  // method 99 = AES；真实 method 在 extra field 0x9901 里（我们全 STORE=0）
  eq(entry.method, 99, "payload entry 必须是 method 99（WinZip AES）");
  let strength = 0, p = 0;
  const ev = new DataView(entry.extra.buffer, entry.extra.byteOffset, entry.extra.byteLength);
  while (p + 4 <= entry.extra.length) {
    const id = ev.getUint16(p, true), sz = ev.getUint16(p + 2, true);
    if (id === 0x9901) { strength = entry.extra[p + 8]; }
    p += 4 + sz;
  }
  eq(strength, 3, "AES-256（strength=3）");
  const saltLen = 16, keyLen = 32;
  const salt = entry.data.slice(0, saltLen);
  const pwv = entry.data.slice(saltLen, saltLen + 2);
  const auth = entry.data.slice(entry.data.length - 10);
  const ct = entry.data.slice(saltLen + 2, entry.data.length - 10);
  const dk = nodeCrypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, keyLen * 2 + 2, "sha1");
  const aesKey = dk.subarray(0, keyLen), macKey = dk.subarray(keyLen, keyLen * 2), pwvDerived = dk.subarray(keyLen * 2);
  assert(pwvDerived[0] === pwv[0] && pwvDerived[1] === pwv[1], "password-verifier 2 字节匹配（密码对）");
  // HMAC-SHA1（取前 10 字节）验证密文完整性
  const mac = nodeCrypto.createHmac("sha1", macKey).update(ct).digest().subarray(0, 10);
  assert(Buffer.from(auth).equals(mac), "authcode（HMAC-SHA1/80）匹配");
  // AES-256-CTR：counter 16 字节，从 1 起，小端自增（与 WebCrypto 的大端 CTR 不同 → 手动 ECB+XOR）
  const ecb = nodeCrypto.createCipheriv("aes-256-ecb", aesKey, null);
  const out = Buffer.alloc(ct.length);
  const counter = Buffer.alloc(16);
  for (let block = 0; block * 16 < ct.length; block++) {
    // LE increment（注意 Buffer 的 ++buf[i] 表达式值不回绕，必须先存再判）
    for (let i = 0; i < 16; i++) { counter[i] = (counter[i] + 1) & 0xff; if (counter[i] !== 0) break; }
    const ks = ecb.update(counter);
    const base = block * 16, n = Math.min(16, ct.length - base);
    for (let i = 0; i < n; i++) out[base + i] = ct[base + i] ^ ks[i];
  }
  return new Uint8Array(out);
}

describe("互操作性 · 独立 WinZip-AES 实现（无 zip.js）解开容器", () => {
  it("外层明文可 parse、CD 干净（无加密 flag）、thumb 是最后 entry", async () => {
    const { guid, bytes } = await makeFixture("真名");
    const outer = parseZipEntries(bytes);
    eq(outer.length, 2);
    eq(outer[0].name, guid, "payload entry 名 = GUID");
    eq(outer[1].name, "peek", "peek 最后");
    eq(outer[0].method, 0, "外层 STORE 明文（扫描器看不到加密 flag）");
    eq(outer[1].method, 0);
  });

  it("独立解密 payload → data.bin 逐位 == 原 ora；meta.bin 可读出真名", async () => {
    const { guid, bytes } = await makeFixture("真名");
    const outer = parseZipEntries(bytes);
    const payload = outer.find((e) => e.name === guid);
    const inner = parseZipEntries(payload.data);
    const dataEntry = inner.find((e) => e.name === "data.bin");
    const metaEntry = inner.find((e) => e.name === "meta.bin");
    assert(dataEntry && metaEntry, "payload 内 data.bin + meta.bin");
    const data = winzipAesDecrypt(dataEntry, PW);
    assert(bytesEq(data, ORA_STUB), "独立实现解出的 data.bin == 原 ora 字节（格式标准 → 7z 可开）");
    const metaText = new TextDecoder().decode(winzipAesDecrypt(metaEntry, PW));
    assert(metaText.startsWith("WPMETA1\n"), "meta magic");
    eq(JSON.parse(metaText.slice(8)).name, "真名", "恢复路径：meta.bin 给出真名");
  });

  it("独立实现也拒绝错密码（password-verifier）", async () => {
    const { guid, bytes } = await makeFixture();
    const payload = parseZipEntries(bytes).find((e) => e.name === guid);
    const dataEntry = parseZipEntries(payload.data).find((e) => e.name === "data.bin");
    let threw = false;
    try { winzipAesDecrypt(dataEntry, "wrong"); } catch (_) { threw = true; }
    assert(threw);
  });
});
