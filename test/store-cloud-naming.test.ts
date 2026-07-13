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

// peekTail：内容盲尾取（cloud-only 缩略图字节源）。全名身份、无 fileName 注入（薄默认恒等）。
//   ⚠ peekTail 将在 getPeek 重构中从公开面移除，此处暂验字节源正确。
const mkStore = (provider: ReturnType<typeof createMockProvider>) => createStore({
  appId: "test", provider,
  ui: { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} } as never,
  validateAdopt: () => true, kv: memKv(), local: createMockLocal(),
  isOnline: () => true, signedIn: () => true, skipMigration: true,   // 无 fileName/encFileName 注入 → 用薄默认（恒等 / 追加 .zip）
});

test("[peekTail] 纯云端 X.ora → 经 cloud.pullTail 取末尾 n 字节（内容盲，不整份下载）", async () => {
  const provider = createMockProvider();
  const body = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(6);   // 216 字节
  provider._seed("note.ora", body);
  const store = mkStore(provider);
  const tail = await store.file("note.ora", { isZip: false }).peekTail(20);
  assert(!!tail, "纯云端应经 cloud.pullTail byte-range 取到尾部（cloud-only 缩略图靠此）");
  eq(td.decode(new Uint8Array(await tail!.arrayBuffer())), body.slice(-20));
});

test("[peekTail] 本地缓存有 → Blob.slice 尾部（不碰网络）", async () => {
  const provider = createMockProvider();
  const store = mkStore(provider);
  await store.file("draw.ora", { isZip: false }).save(new TextEncoder().encode("HELLO-LOCAL-TAIL"));
  const tail = await store.file("draw.ora", { isZip: false }).peekTail(4);
  assert(!!tail, "本地有副本 → 切片");
  eq(td.decode(new Uint8Array(await tail!.arrayBuffer())), "TAIL");
});
