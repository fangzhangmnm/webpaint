// 回归：薄 store **全名身份**的往返（身份 = 云端明文文件名 X.ora；加密件云端 = X.ora.zip「追加 .zip」）。
//   v390 前的 bug：身份漂成裸名/云端文件名对不上 → 图库全 cloud-only 0B、打开空白。
//   薄 store 后身份=全名，store 命名默认「fileName 恒等 / encFileName 追加 .zip / toName 去尾一个 .zip」，
//   app 在边界用 sessionFileName 把裸 session 名转全名。此测试锁死：
//     · listing 身份 = 全名（明文 X.ora 恒等、加密 X.ora.zip 去尾 .zip → 都归一到 X.ora）
//     · pull(全名) 命中云端明文 X.ora；pull(全名) 经 encFileName 命中加密 X.ora.zip
//     · toName/encFileName 互逆无损（多扩展名不丢信息：Y.zip↔Y.zip.zip）
//   node 用真 cloud-sync + listing over mock-provider（此前测试都用无扩展名 mock → 漏掉带扩展名的往返）。
import { test, eq, assert } from "./runner.mjs";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createListing } from "../src/store/listing.ts";
import { createStore } from "../src/store/create-store.ts";
import { createMockLocal } from "../src/store/mock-local.ts";

const td = new TextDecoder();
const CTX_ON = { signedIn: true, online: true };
const emptyLocal = { async appKeys(): Promise<string[]> { return []; } };
const cleanHead = { seenBase: (): string | null => null, isDirty: (): boolean => false };
// 薄默认（对齐 create-store）：fileName 恒等、encFileName 追加 .zip。
const APPEND_ZIP = (n: string): string => `${n}.zip`;

test("[cloud-naming] 云端明文 X.ora → listing 身份=全名 X.ora + pull(全名) 取到内容", async () => {
  const provider = createMockProvider();
  provider._seed("20260528-01.ora", "DRAWING-BYTES");
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });   // 身份恒等（薄默认）
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("20260528-01.ora"), `listing 身份应=全名 20260528-01.ora，实得 ${JSON.stringify(paths)}`);
  assert(!paths.includes("20260528-01"), "身份=全名，不再去 .ora（app 边界才 strip 显示）");

  const pulled = await cloud.pull("20260528-01.ora");
  assert(!!pulled, "pull(全名) 应命中云端明文文件（否则 0B/打开空白）");
  eq(td.decode(new Uint8Array(await pulled!.blob.arrayBuffer())), "DRAWING-BYTES");
});

test("[cloud-naming] 云端加密 X.ora.zip（追加 .zip）→ listing 身份=X.ora + pull(全名) 经 encFileName 命中", async () => {
  const provider = createMockProvider();
  provider._seed("secret.ora.zip", "CIPHER");
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n, encFileName: APPEND_ZIP });
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("secret.ora"), `加密件身份应=全名 secret.ora（去尾一个 .zip），实得 ${JSON.stringify(paths)}`);

  const pulled = await cloud.pull("secret.ora");
  assert(!!pulled, "pull(全名) 应经 encFileName 追加 .zip 命中云端 secret.ora.zip");
  eq(td.decode(new Uint8Array(await pulled!.blob.arrayBuffer())), "CIPHER");
});

test("[cloud-naming] toName/encFileName 互逆无损：Y.zip ↔ Y.zip.zip（多扩展名不丢信息）", async () => {
  const provider = createMockProvider();
  provider._seed("Y.zip.zip", "ZZ");                       // 身份本身是 Y.zip 的加密件 → 追加 → Y.zip.zip
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n, encFileName: APPEND_ZIP });
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("Y.zip"), `Y.zip.zip 应去尾一个 .zip → 身份 Y.zip（不丢中间 .zip），实得 ${JSON.stringify(paths)}`);
  assert(!paths.includes("Y"), "绝不多去扩展名（swap 会丢信息，故用 append/strip 单个 .zip）");

  eq(APPEND_ZIP("Y.zip"), "Y.zip.zip");                    // 正向：身份 Y.zip → 云端加密名 Y.zip.zip
  const pulled = await cloud.pull("Y.zip");
  eq(td.decode(new Uint8Array(await pulled!.blob.arrayBuffer())), "ZZ");
});

test("[cloud-naming] 子夹 A/wall.ora → listing 身份=A/wall.ora（保留夹路径 + 全名）", async () => {
  const provider = createMockProvider();
  provider._seed("A/wall.ora", "SUBFOLDER-DRAWING");
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const listing = createListing({ cloud, local: emptyLocal, head: cleanHead, pendingFolders: () => [] });

  const snap = await listing.listFolder("A", CTX_ON);
  const paths = snap.items.map((i) => i.path);
  assert(paths.includes("A/wall.ora"), `子夹身份应=A/wall.ora（保留夹 + 全名），实得 ${JSON.stringify(paths)}`);
});

// getPeek：格式盲、**按文件名**解 zip CD 取 entry（cloud-only 缩略图路径）。全名身份、无 fileName 注入（薄默认恒等）。
//   v399：删「硬扫末尾 PNG」；改标准 zip 解析(EOCD→CD→按名找 entry→溢出尾片二次拉)。明文→entry 字节(无 type)；
//   加密容器→外层 "peek" entry 密文(ENC_PEEK_MIME)。验字节源路由(本地切片 / 云端 byte-range + pullRange 二次拉)。
const mkStore = (provider: ReturnType<typeof createMockProvider>) => createStore({
  appId: "test", provider,
  ui: { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} } as never,
  validateAdopt: () => true, kv: memKv(), local: createMockLocal(),
  isOnline: () => true, signedIn: () => true, skipMigration: true,   // 无 fileName/encFileName 注入 → 用薄默认（恒等 / 追加 .zip）
});
const bytesEq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const ENC = new TextEncoder();

// 手搓 STORE zip（method=0）：[local header + name + data]* + [CD]* + EOCD。format-blind getPeek 需要真 zip。
function buildStoreZip(entries: { name: string; data: Uint8Array | string }[]): Uint8Array {
  const locals: Uint8Array[] = [], cds: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = ENC.encode(e.name);
    const data = typeof e.data === "string" ? ENC.encode(e.data) : e.data;
    const lh = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lh.set(name, 30); lh.set(data, 30 + name.length);
    locals.push(lh);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    cd.set(name, 46); cds.push(cd);
    offset += lh.length;
  }
  const cdBytes = new Uint8Array(cds.reduce((s, a) => s + a.length, 0));
  { let p = 0; for (const a of cds) { cdBytes.set(a, p); p += a.length; } }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdBytes.length, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdBytes.length + eocd.length);
  let p = 0; for (const a of locals) { out.set(a, p); p += a.length; } out.set(cdBytes, p); p += cdBytes.length; out.set(eocd, p);
  return out;
}
const THUMB = ENC.encode("THUMB-opaque-bytes-not-a-png");
const REF = ENC.encode("REFERENCE-window-image-bytes");
// reference.png 在 thumbnail 之前（v398 修复后的真实 ora 顺序）；thumbnail 最后。
const oraZip = () => buildStoreZip([{ name: "mimetype", data: "image/openraster" }, { name: "webpaint/reference.png", data: REF }, { name: "Thumbnails/thumbnail.png", data: THUMB }]);

test("[getPeek] 纯云端 X.ora → cloud byte-range 取尾片 + 解 CD 按名返回 thumbnail entry（无 type，不整份下载）", async () => {
  const provider = createMockProvider();
  provider._seed("note.ora", oraZip());
  const store = mkStore(provider);
  const peek = await store.file("note.ora", { isZip: true }).getPeek({ bytesLength: 4096, zipEntry: "Thumbnails/thumbnail.png" });
  assert(!!peek, "纯云端应经 cloud.pullTail 取尾片、按名命中 thumbnail entry");
  eq(peek!.type, "", "格式盲：明文 entry 不贴 MIME");
  assert(bytesEq(new Uint8Array(await peek!.arrayBuffer()), THUMB), "按名返回 = thumbnail 字节（不是 reference）");
});

test("[getPeek] 本地缓存有 → Blob.slice 尾片（不碰网络）+ 按名取 thumbnail", async () => {
  const provider = createMockProvider();
  const store = mkStore(provider);
  await store.file("draw.ora", { isZip: false }).save(oraZip());
  const peek = await store.file("draw.ora", { isZip: true }).getPeek({ bytesLength: 4096, zipEntry: "Thumbnails/thumbnail.png" });
  assert(!!peek, "本地有副本 → 切尾片、按名取 thumbnail");
  assert(bytesEq(new Uint8Array(await peek!.arrayBuffer()), THUMB), "本地路径同样按名返回 thumbnail");
});

test("[getPeek] 尾片太小装不下 CD → cloud.pullRange 二次拉，仍按名取到 thumbnail", async () => {
  const provider = createMockProvider();
  provider._seed("big.ora", buildStoreZip([{ name: "data/layer1.png", data: new Uint8Array(6000).fill(3) }, { name: "Thumbnails/thumbnail.png", data: THUMB }]));
  const store = mkStore(provider);
  // 80B 尾片只够 EOCD，装不下 CD 和大 layer entry → 库须 pullRange 二次拉 CD + entry。
  const peek = await store.file("big.ora", { isZip: true }).getPeek({ bytesLength: 80, zipEntry: "Thumbnails/thumbnail.png" });
  assert(!!peek, "CD/entry 溢出尾片 → 经 pullRange 二次拉仍取到（不再退占位）");
  assert(bytesEq(new Uint8Array(await peek!.arrayBuffer()), THUMB), "二次拉后字节仍是 thumbnail");
});

test("[getPeek] 加密容器（外层 zip 有 'peek' entry）→ 按名返回密文 blob(ENC_PEEK_MIME)，不解密", async () => {
  const provider = createMockProvider();
  const cipher = ENC.encode("ENC-PEEK-CIPHERTEXT-frame-bytes");
  // 加密容器外层形状：[<GUID> payload, "peek" 密文旁路]（app 拿 ENC_PEEK_MIME → 手动 decryptPeek）。
  provider._seed("secret.ora.zip", buildStoreZip([{ name: "3f2504e0-uuid", data: new Uint8Array(40).fill(1) }, { name: "peek", data: cipher }]));
  const store = mkStore(provider);
  const peek = await store.file("secret.ora", { isZip: true }).getPeek({ bytesLength: 4096, zipEntry: "Thumbnails/thumbnail.png" });
  assert(!!peek, "加密容器应按名命中外层 'peek' entry");
  eq(peek!.type, "application/x-sync-store-enc-peek", "返回密文标记 ENC_PEEK_MIME（app 手动解）");
  assert(bytesEq(new Uint8Array(await peek!.arrayBuffer()), cipher), "返回的是 peek entry 的密文字节（库不解密）");
});
