// 加密容器（ADR-0012 三层双 zip + 尾部加密 thumb）验收。
//
// node 跑真 zip.js（vendored UMD，require 进来挂 window.zip）+ 真 WebCrypto（node ≥ 19）。
// 互操作性验证：本机没有 7z 二进制，所以用**独立实现的 WinZip-AES 解密器**
// （node:crypto，按 WinZip AE-2 规范：PBKDF2-SHA1×1000 → AES-256-CTR(LE counter) → HMAC-SHA1）
// 解开 zip.js 产出的 payload —— 两个独立实现互通 = 格式是标准的 = 7-zip 能开。
// 真 7-zip 实测仍留给 PC 真机批（见 docs/encryption.md 待验清单）。

import fs from "node:fs";
import nodeCrypto from "node:crypto";
import { describe, it, assert, eq } from "./runner.mjs";

// ---- zip.js UMD → window.zip（src/zip.js 的 Z() 在 call-time 查 window）----
// node 下 require/import 该 UMD 两条分支都摸不到产物 → 显式喂 exports 强制 CJS 分支。
const _zipCode = fs.readFileSync(new URL("../vendor/zip-js/zip-full.min.js", import.meta.url), "utf8");
const _zipExports = {};
new Function("exports", "module", "define", _zipCode).call(globalThis, _zipExports, { exports: _zipExports }, undefined);
globalThis.window = globalThis;
window.zip = _zipExports;
assert(window.zip && window.zip.ZipWriter, "vendored zip.js 没加载成");

const {
  packContainer, unpackContainer, looksEncryptedContainer,
  scanEncThumbFromEnd, decryptThumbParsed, encryptThumb,
  makeGuid, THUMB_TAIL_WINDOW,
} = await import("../src/crypto-container.js");
const { zipPack } = await import("../src/zip.js");
const cryptoState = await import("../src/crypto-state.js");

// ---- 测试素材 ----
const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const ORA_STUB = new TextEncoder().encode("fake-ora-bytes-".repeat(1000));   // ~15KB
const PW = "测试密码123";

async function makeFixture(name = "文件夹/我的画") {
  const guid = makeGuid();
  const blob = await packContainer({ oraBytes: ORA_STUB, fileName: name, guid, thumbPng: PNG_STUB, password: PW });
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
    const ora = new Uint8Array(await res.oraBlob.arrayBuffer());
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

describe("crypto-container · 尾部加密 thumb（byte-range 路径）", () => {
  it("只拿尾部窗口就能扫到 + 解密回 PNG", async () => {
    const { bytes } = await makeFixture();
    const tail = bytes.slice(Math.max(0, bytes.length - THUMB_TAIL_WINDOW));
    const parsed = scanEncThumbFromEnd(tail);
    assert(parsed, "尾部窗口内必须扫到 MAGIC（thumb 是外层最后 entry）");
    const png = await decryptThumbParsed(parsed, PW);
    assert(bytesEq(png, PNG_STUB), "解密 == 原 PNG");
  });

  it("80KB suffix（cloud-thumbs 预算）也命中", async () => {
    const { bytes } = await makeFixture();
    const tail = bytes.slice(Math.max(0, bytes.length - 81920));
    assert(scanEncThumbFromEnd(tail), "80KB suffix 命中");
  });

  it("thumb 错密码 → throw（AES-GCM tag 即验证器）", async () => {
    const enc = await encryptThumb(PNG_STUB, PW);
    const parsed = scanEncThumbFromEnd(enc);
    let threw = false;
    try { await decryptThumbParsed(parsed, "wrong"); } catch (_) { threw = true; }
    assert(threw);
  });
});

describe("crypto-state · 统一密码 + 交互解包", () => {
  it("内存密码直接解，无弹窗", async () => {
    const { blob } = await makeFixture();
    cryptoState.setPassword(PW);
    let prompted = 0;
    cryptoState.setPasswordPrompt(async () => { prompted++; return null; });
    const res = await cryptoState.unpackContainerInteractive(blob);
    eq(prompted, 0, "有内存密码不该弹");
    assert(res.oraBlob, "解出 ora");
    cryptoState.lock();
  });

  it("内存密码失效 → 弹窗重问；输对后记为统一密码", async () => {
    const { blob } = await makeFixture();
    cryptoState.setPassword("stale-pw-from-another-gallery");
    const answers = ["wrong-again", PW];
    cryptoState.setPasswordPrompt(async () => answers.shift());
    const res = await cryptoState.unpackContainerInteractive(blob);
    assert(res.oraBlob);
    eq(cryptoState.getPassword(), PW, "验证通过的密码上位");
  });

  it("取消弹窗 → throw（绝不静默吞）", async () => {
    const { blob } = await makeFixture();
    cryptoState.lock();
    cryptoState.setPasswordPrompt(async () => null);
    let threw = false;
    try { await cryptoState.unpackContainerInteractive(blob); } catch (e) { threw = /取消/.test(e.message); }
    assert(threw, "取消必须抛带「取消」的错");
  });
});

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
    eq(outer[1].name, "thumb", "thumb 最后");
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
