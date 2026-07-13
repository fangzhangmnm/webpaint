// store `zip-peek` 深模块纯逻辑（v399 重写：格式盲、按文件名取 entry + 溢出尾片二次拉）。
//   readCentralDirectory / readEntryBytes / readNamedEntry over a PeekSource（tail + range 回调）。
import { describe, it, assert, eq } from "./runner.mjs";
import { readCentralDirectory, readEntryBytes, readNamedEntry } from "../src/store/zip-peek.ts";

const enc = new TextEncoder();
const concat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── 手搓 STORE zip（method=0）：[local header + name + data]* + [CD]* + EOCD ──
function buildStoreZip(entries) {
  const locals = [], cds = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const lh = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);                                   // method=0 STORE
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lh.set(name, 30); lh.set(data, 30 + name.length);
    locals.push(lh);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);                                  // method=0
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);                            // localOff
    cd.set(name, 46);
    cds.push(cd);
    offset += lh.length;
  }
  const cdBytes = concat(...cds);
  const cdOffset = offset;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdBytes.length, true); ev.setUint32(16, cdOffset, true);
  return concat(...locals, cdBytes, eocd);
}

// PeekSource：从整份 bytes 造尾片 + range 回调（数 range 调用，验二次拉发生与否）。
function srcFrom(bytes, tailLen) {
  const total = bytes.length;
  const tl = Math.min(tailLen == null ? total : tailLen, total);
  let rangeCalls = 0;
  const src = {
    totalSize: total,
    tail: bytes.slice(total - tl),
    range: async (off, len) => { rangeCalls++; return bytes.slice(off, off + len); },
  };
  return { src, calls: () => rangeCalls };
}

const THUMB = enc.encode("THUMBNAIL-BYTES-not-a-png-just-opaque");
const REF = enc.encode("REFERENCE-IMG-different-bytes");

describe("zip-peek › readCentralDirectory（按名解 CD）", () => {
  it("解出全部 entry 名与顺序", async () => {
    const zip = buildStoreZip([{ name: "mimetype", data: "image/openraster" }, { name: "webpaint/reference.png", data: REF }, { name: "Thumbnails/thumbnail.png", data: THUMB }]);
    const { src } = srcFrom(zip);
    const entries = await readCentralDirectory(src);
    assert(!!entries, "解出 CD");
    eq(entries.map((e) => e.name).join(","), "mimetype,webpaint/reference.png,Thumbnails/thumbnail.png");
  });
});

describe("zip-peek › readNamedEntry（格式盲、按文件名）", () => {
  it("整份在尾片 → 按名取到目标字节，零二次拉", async () => {
    const zip = buildStoreZip([{ name: "webpaint/reference.png", data: REF }, { name: "Thumbnails/thumbnail.png", data: THUMB }]);
    const { src, calls } = srcFrom(zip);
    const out = await readNamedEntry(src, "Thumbnails/thumbnail.png");
    assert(!!out && bytesEq(out, THUMB), "取到 thumbnail 字节");
    eq(calls(), 0, "全在尾片 → 不二次拉");
  });
  it("不因物理位置取错：目标非最后一个 entry 也按名精确命中", async () => {
    // reference.png 排在 thumbnail 之后（模拟 v397 旧顺序）——按名取 thumbnail 仍拿对，不会拿成 reference。
    const zip = buildStoreZip([{ name: "Thumbnails/thumbnail.png", data: THUMB }, { name: "webpaint/reference.png", data: REF }]);
    const { src } = srcFrom(zip);
    const t = await readNamedEntry(src, "Thumbnails/thumbnail.png");
    const r = await readNamedEntry(src, "webpaint/reference.png");
    assert(!!t && bytesEq(t, THUMB), "按名取 thumbnail = thumbnail（不被后面的 reference 抢）");
    assert(!!r && bytesEq(r, REF), "按名取 reference = reference");
  });
  it("entry 名不存在 → null", async () => {
    const zip = buildStoreZip([{ name: "Thumbnails/thumbnail.png", data: THUMB }]);
    const { src } = srcFrom(zip);
    eq(await readNamedEntry(src, "no/such.png"), null);
  });
});

describe("zip-peek › 溢出尾片 → 额外 byte-range 二次拉", () => {
  it("CD 不在尾片 → 一次额外 range 拉 CD，仍取到目标", async () => {
    // 前面塞个大 entry 把 CD 推到很靠前；尾片只留够 EOCD + thumbnail entry，CD 落在尾片外。
    const big = new Uint8Array(4000).fill(7);
    const zip = buildStoreZip([{ name: "big.bin", data: big }, { name: "Thumbnails/thumbnail.png", data: THUMB }]);
    // 尾片只覆盖 thumbnail 的 local+data + CD 尾巴一点点是不行的；取一个「够 EOCD、不够 CD 全」的窗口。
    const { src, calls } = srcFrom(zip, 120);
    const out = await readNamedEntry(src, "Thumbnails/thumbnail.png");
    assert(!!out && bytesEq(out, THUMB), "CD 溢出尾片时经二次拉仍取到 thumbnail");
    assert(calls() >= 1, "发生了额外 byte-range（拉 CD / entry）");
  });
  it("目标 entry 数据不在尾片 → 二次拉 entry", async () => {
    // thumbnail 在最前，后面一堆字节把它推出小尾片；CD/EOCD 在尾片内。
    const filler = new Uint8Array(3000).fill(9);
    const zip = buildStoreZip([{ name: "Thumbnails/thumbnail.png", data: THUMB }, { name: "pad.bin", data: filler }]);
    const { src, calls } = srcFrom(zip, 200);   // 尾片含 pad 尾 + CD + EOCD，但不含最前的 thumbnail 数据
    const out = await readNamedEntry(src, "Thumbnails/thumbnail.png");
    assert(!!out && bytesEq(out, THUMB), "entry 数据溢出尾片时经二次拉仍取到");
    assert(calls() >= 1, "发生了额外 byte-range 拉 entry");
  });
});

describe("zip-peek › 加密容器旁路 entry 按名取（兼容加密）", () => {
  it("外层 zip 的 'peek' entry 可按名取到（getPeek 加密路径靠此）", async () => {
    const peekBytes = enc.encode("ENC-PEEK-CIPHERTEXT-FRAME");
    const zip = buildStoreZip([{ name: "3f2504e0-uuid-payload", data: new Uint8Array(50).fill(1) }, { name: "peek", data: peekBytes }]);
    const { src } = srcFrom(zip);
    const out = await readNamedEntry(src, "peek");
    assert(!!out && bytesEq(out, peekBytes), "按名取到外层 peek entry 的密文字节");
  });
});
